import Foundation
import Observation
import RemiPush
import UserNotifications
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// App-only OS boundary. Preferences retain registration intent, never trust.
/// The notification extensions link RemiPush without this identity owner (#1242).
@MainActor
@Observable
public final class NativeRelayNotifications {
    public static let shared = NativeRelayNotifications()

    public private(set) var store: MachineStore?
    public private(set) var startupError: String?
    public private(set) var notice: String?
    public private(set) var enabling = false
    public private(set) var notificationPresentationID: UUID?
    public var presentsRelayNotification = false

    @ObservationIgnored private var pushStore: RemiPushStore?
    @ObservationIgnored private var identityStore: ClientIdentityStore?
    @ObservationIgnored private var foreground = false
    @ObservationIgnored private var lifecycle = UUID()
    @ObservationIgnored private var started = false
    @ObservationIgnored private var pendingCarrier: Data?
    @ObservationIgnored private var latestToken: Data?
    @ObservationIgnored private var tokenTask: Task<Void, Never>?
    @ObservationIgnored private var enableTask: Task<Void, Never>?
    @ObservationIgnored private var enableAttempt: UUID?
    @ObservationIgnored private var enablingEndpointID: String?
    @ObservationIgnored private var intentKey = ""
    @ObservationIgnored private var intents: Set<String> = []
    @ObservationIgnored private var permissionWait: (UUID, CheckedContinuation<Bool, Never>)?
    @ObservationIgnored private var tokenWait: (UUID, CheckedContinuation<Data?, Never>)?
    @ObservationIgnored private var permissionTimeout: Task<Void, Never>?
    @ObservationIgnored private var tokenTimeout: Task<Void, Never>?

    private init() {
        do {
            let push = try RemiPushStore.configured()
            pushStore = push
            let identity = ClientIdentityStore(service: NativeIdentityRecordStore.defaultService,
                account: NativeIdentityRecordStore.defaultAccount, pushStore: push)
            identityStore = identity
            // Cold background launches must not migrate, reconcile or create Dpk.
            _ = try identity.loadCurrent()
        } catch {
            startupError = "Device identity is unavailable. Open Remi in the foreground to continue."
        }
        if let namespace = Bundle.main.object(forInfoDictionaryKey: "RemiPushNamespace") as? String,
           ["native-debug", "native-release"].contains(namespace) {
            intentKey = "remi.relay.notification-intent.\(namespace)"
            intents = Set((UserDefaults.standard.stringArray(forKey: intentKey) ?? []).prefix(128))
        }
    }

    /// Called only by an active foreground scene. Existing v2 identities use a
    /// strict read; creation and legacy migration are confined to this boundary.
    public func activate() {
        guard !foreground else { return }
        foreground = true
        lifecycle = UUID()
        if store == nil {
            do {
                if pushStore == nil {
                    let push = try RemiPushStore.configured()
                    pushStore = push
                    identityStore = ClientIdentityStore(service: NativeIdentityRecordStore.defaultService,
                        account: NativeIdentityRecordStore.defaultAccount, pushStore: push)
                }
                guard let pushStore, let identityStore else { throw RemiPushError.unavailable }
                let currentIdentity: ClientIdentity?
                do {
                    currentIdentity = try identityStore.loadCurrent()
                } catch {
                    // The foreground provider migrates legacy records, but never
                    // replaces protected, corrupt or unavailable Keychain records.
                    currentIdentity = nil
                }
                let identity = try currentIdentity ?? identityStore.loadOrCreate()
                let saved = MachineConfigurationStore.shared.load()
                let current = MachineStore(endpoints: saved.isEmpty
                    ? [MachineEndpoint(host: "127.0.0.1", port: 18765)] : saved,
                    identity: identity,
                    clientVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0",
                    clientId: Self.clientID(), pushStore: pushStore)
                // A preference cannot install missing or revoked SQLite trust.
                for endpoint in current.persistableEndpoints where intents.contains(endpoint.id) {
                    current.restoreRelayNotificationIntent(on: endpoint)
                }
                store = current
                startupError = nil
            } catch {
                startupError = "Device identity is unavailable. Remi cannot sign answers with this identity."
            }
        }
        guard let store else { return }
        if !started { started = true; store.start() }
        if let carrier = pendingCarrier {
            pendingCarrier = nil
            store.openRelayNotification(carrier: carrier)
            notificationPresentationID = UUID()
            presentsRelayNotification = true
        }
        if !intents.isEmpty {
            // Refresh the OS token on foreground entry; never persist token bytes.
            registerWithAPNs()
            if let latestToken { acceptPushToken(latestToken) }
        }
    }

    /// Transient inactive scenes (including the permission dialog) retain the
    /// request. Background entry releases every bounded OS continuation.
    public func background() {
        foreground = false
        lifecycle = UUID()
        cancelEnable()
        tokenTask?.cancel(); tokenTask = nil
        finishPermission(false)
        finishToken(nil)
        enabling = false
    }

    public func enable(on endpoint: MachineEndpoint) {
        guard foreground, !enabling, let current = store, endpoint.relayPin != nil,
              current.persistableEndpoints.contains(endpoint) else {
            notice = "Finish pairing and open Remi before enabling relay notifications."
            return
        }
        let epoch = lifecycle
        let attempt = UUID()
        enableAttempt = attempt
        enablingEndpointID = endpoint.id
        enabling = true
        notice = "Allow notifications to receive relay alerts."
        enableTask = Task { [weak self, weak current] in
            guard let self, let current else { return }
            defer {
                if self.enableAttempt == attempt {
                    self.enabling = false
                    self.enableTask = nil
                    self.enableAttempt = nil
                    self.enablingEndpointID = nil
                }
            }
            guard self.isEnableCurrent(current, epoch, attempt, endpoint), !Task.isCancelled else { return }
            let allowed = await self.requestPermission()
            guard self.isEnableCurrent(current, epoch, attempt, endpoint), !Task.isCancelled else { return }
            guard allowed else {
                self.notice = "Notification permission is unavailable. Review Remi in system notification settings."
                self.enabling = false; return
            }
            guard let token = await self.requestToken(), self.isEnableCurrent(current, epoch, attempt, endpoint), !Task.isCancelled else {
                if self.isEnableCurrent(current, epoch, attempt, endpoint) {
                    self.notice = "APNs registration did not complete. Try enabling notifications again."
                    self.enabling = false
                }
                return
            }
            guard let environment = await RemiPushStore.runtimeAPNsEnvironment(stillCurrent: { [weak self, weak current] in
                guard let self, let current else { return false }
                return self.isEnableCurrent(current, epoch, attempt, endpoint) && !Task.isCancelled
            }), self.isEnableCurrent(current, epoch, attempt, endpoint), !Task.isCancelled else {
                if self.isEnableCurrent(current, epoch, attempt, endpoint) {
                    self.notice = "The signed APNs environment is unavailable. Relay notifications require a signed app."
                    self.enabling = false
                }
                return
            }
            current.updateRelayPushToken(token, environment: environment)
            await current.enableRelayNotifications(on: endpoint)
            guard self.isEnableCurrent(current, epoch, attempt, endpoint), !Task.isCancelled else { return }
            self.intents.insert(endpoint.id)
            self.saveIntents()
            self.notice = nil
            self.enabling = false
        }
    }

    /// Cancel before a remove or same-ID replacement, including failed Forget.
    /// A suspended OS callback must never enable the replacement endpoint.
    public func machineWillChange(_ endpoint: MachineEndpoint) {
        if enablingEndpointID == endpoint.id { cancelEnable() }
    }

    /// The caller supplies only a successful durable removeMachine result.
    public func didForget(_ endpoint: MachineEndpoint) {
        machineWillChange(endpoint)
        if intents.remove(endpoint.id) != nil { saveIntents() }
    }

    /// Invoke after the store's durable Forget succeeds. A failed Forget leaves
    /// its endpoint present and keeps the recoverable preference intent.
    public func reconcileEndpoints() {
        guard let store else { return }
        let present = Set(store.machines.map { $0.endpoint.id })
        let retained = intents.intersection(present)
        if retained != intents { intents = retained; saveIntents() }
    }

    public func acceptPushToken(_ token: Data) {
        guard !token.isEmpty, token.count <= 256 else { finishToken(nil); return }
        latestToken = token
        finishToken(token)
        guard foreground, let current = store else { return }
        let epoch = lifecycle
        tokenTask?.cancel()
        tokenTask = Task { [weak self, weak current] in
            guard let self, let current,
                  let environment = await RemiPushStore.runtimeAPNsEnvironment(stillCurrent: { [weak self, weak current] in
                      guard let self, let current else { return false }
                      return self.isCurrent(current, epoch) && self.latestToken == token && !Task.isCancelled
                  }), self.isCurrent(current, epoch), self.latestToken == token, !Task.isCancelled else { return }
            current.updateRelayPushToken(token, environment: environment)
        }
    }

    public func pushRegistrationFailed() {
        finishToken(nil)
        if enabling { notice = "APNs registration failed. Try enabling notifications again." }
    }

    /// Default taps reopen the original capsule. Stale action identifiers and
    /// malformed v2 markers are consumed by delegates and never routed directly.
    public func openDefaultTap(carrier: Data?) {
        let original = carrier ?? Data()
        guard foreground, let store else { pendingCarrier = original; return }
        store.openRelayNotification(carrier: original)
        notificationPresentationID = UUID()
        presentsRelayNotification = true
    }

    public func closeNotification() {
        presentsRelayNotification = false
        notificationPresentationID = nil
        store?.closeRelayNotification()
    }

    public nonisolated static func carrier(from userInfo: [AnyHashable: Any]) -> Data? {
        guard let value = userInfo["remiPush"], JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              data.count <= 16_384 else { return nil }
        return data
    }

    /// No Dpk read or creation is needed for either presentation or quiet dismiss.
    public nonisolated static func allowsPresentation(_ content: UNNotificationContent) -> Bool {
        guard content.userInfo["remiPush"] != nil,
              let push = try? RemiPushStore.configured() else { return false }
        return push.allowsPresentation(content)
    }

    public nonisolated static func receiveDismiss(carrier: Data?, completion: @escaping @Sendable (Bool?) -> Void) {
        guard let carrier, let push = try? RemiPushStore.configured() else { completion(nil); return }
        push.receiveDismiss(carrier: carrier, completion: completion)
    }

    private func isCurrent(_ current: MachineStore, _ epoch: UUID) -> Bool {
        foreground && lifecycle == epoch && store === current
    }
    private func isEnableCurrent(_ current: MachineStore, _ epoch: UUID, _ attempt: UUID,
                                 _ endpoint: MachineEndpoint) -> Bool {
        isCurrent(current, epoch) && enableAttempt == attempt && current.persistableEndpoints.contains(endpoint)
    }
    private func cancelEnable() {
        enableAttempt = nil; enablingEndpointID = nil
        enableTask?.cancel(); enableTask = nil
        finishPermission(false); finishToken(nil)
        enabling = false
    }
    private func saveIntents() {
        guard !intentKey.isEmpty else { return }
        UserDefaults.standard.set(intents.sorted(), forKey: intentKey)
    }
    private static func clientID() -> String {
        let key = "remi.native.client-id"
        if let value = UserDefaults.standard.string(forKey: key) { return value }
        let value = UUID().uuidString.lowercased()
        UserDefaults.standard.set(value, forKey: key)
        return value
    }
    private func registerWithAPNs() {
        #if os(iOS)
        UIApplication.shared.registerForRemoteNotifications()
        #elseif os(macOS)
        NSApplication.shared.registerForRemoteNotifications()
        #endif
    }
    private func requestPermission() async -> Bool {
        let id = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                permissionWait = (id, continuation)
                permissionTimeout = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(60)) } catch { return }
                    self?.finishPermission(false, id: id)
                }
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { [weak self] allowed, _ in
                    Task { @MainActor in self?.finishPermission(allowed, id: id) }
                }
            }
        } onCancel: { [weak self] in
            Task { @MainActor in self?.finishPermission(false, id: id) }
        }
    }
    private func requestToken() async -> Data? {
        let id = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                tokenWait = (id, continuation)
                tokenTimeout = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(15)) } catch { return }
                    self?.finishToken(nil, id: id)
                }
                registerWithAPNs()
            }
        } onCancel: { [weak self] in
            Task { @MainActor in self?.finishToken(nil, id: id) }
        }
    }
    private func finishPermission(_ result: Bool, id: UUID? = nil) {
        guard let wait = permissionWait, id == nil || wait.0 == id else { return }
        permissionWait = nil; permissionTimeout?.cancel(); permissionTimeout = nil
        wait.1.resume(returning: result)
    }
    private func finishToken(_ result: Data?, id: UUID? = nil) {
        guard let wait = tokenWait, id == nil || wait.0 == id else { return }
        tokenWait = nil; tokenTimeout?.cancel(); tokenTimeout = nil
        wait.1.resume(returning: result)
    }
}
