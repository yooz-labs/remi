import Foundation
import Observation
import RemiPush
import UserNotifications
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// Copies untrusted OS delivery fields across the delegate's actor boundary.
/// Verification still uses the original carrier and every displayed field.
public struct NativeRelayActionDelivery: Sendable {
    let carrier: Data?
    let title: String
    let subtitle: String
    let body: String
    let categoryIdentifier: String
    let identifier: String

    public init(content: UNNotificationContent, identifier: String) {
        carrier = NativeRelayNotifications.carrier(from: content.userInfo)
        title = content.title
        subtitle = content.subtitle
        body = content.body
        categoryIdentifier = content.categoryIdentifier
        self.identifier = identifier
    }
}

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
    public private(set) var lastBackgroundActionOutcome: RelayNotificationAnswerOutcome?
    public var presentsRelayNotification = false

    @ObservationIgnored private var pushStore: RemiPushStore?
    @ObservationIgnored private var identityStore: ClientIdentityStore?
    @ObservationIgnored private let preferences: UserDefaults
    @ObservationIgnored private var actionInFlight = false
    @ObservationIgnored private var backgroundStore: MachineStore?
    #if DEBUG
    @ObservationIgnored private var ownedTesting = false
    @ObservationIgnored private var ownedSession: URLSession?
    @ObservationIgnored public var ownedBeforeActionSend: (@Sendable (String) async throws -> Void)?
    #endif
    @ObservationIgnored private var foreground = false
    @ObservationIgnored private var lifecycle = UUID()
    @ObservationIgnored private var started = false
    @ObservationIgnored private var pendingCarrier: Data?
    @ObservationIgnored private var latestToken: Data?
    @ObservationIgnored private var tokenTask: Task<Void, Never>?
    @ObservationIgnored private var automaticTask: Task<Void, Never>?
    @ObservationIgnored private var tokenEnvironment: String?
    @ObservationIgnored private var disabledHosts: Set<String> = []
    @ObservationIgnored private var pendingRevocations: Set<String> = []
    @ObservationIgnored private var lastRegistrations: [String: Date] = [:]
    @ObservationIgnored private var permissionRevokedHosts: Set<String> = []
    @ObservationIgnored private var lastRevocations: [String: Date] = [:]
    @ObservationIgnored private var lastAPNsRegistration: Date?
    #if DEBUG
    @ObservationIgnored var ownedPushRegistrationRequestCount = 0
    #endif
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
        preferences = .standard
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
            intents = Set((preferences.stringArray(forKey: intentKey) ?? []).prefix(128))
            disabledHosts = Set((preferences.stringArray(forKey: intentKey + ".disabled") ?? []).prefix(128))
            pendingRevocations = disabledHosts
        }
    }

    #if DEBUG
    /// The actual cold action caller can run against UUID Keychain/SQLite state.
    /// This entry point never reads configured app groups or standard preferences.
    public init(ownedPushStore: RemiPushStore, ownedIdentityStore: ClientIdentityStore,
                defaultsSuite: String, ownedSession: URLSession? = nil,
                ownedForegroundEndpoints: [MachineEndpoint]? = nil) throws {
        let prefix = "live.yooz.remi.tests.notifications."
        guard ownedPushStore.isOwnedTestStore,
              ownedIdentityStore.isOwnedTestIdentity(for: ownedPushStore),
              defaultsSuite.hasPrefix(prefix),
              UUID(uuidString: String(defaultsSuite.dropFirst(prefix.count))) != nil,
              let defaults = UserDefaults(suiteName: defaultsSuite) else { throw RemiPushError.invalid }
        preferences = defaults
        pushStore = ownedPushStore
        identityStore = ownedIdentityStore
        ownedTesting = true
        self.ownedSession = ownedSession
        intentKey = "remi.relay.notification-intent.owned"
        intents = Set((defaults.stringArray(forKey: intentKey) ?? []).prefix(128))
        disabledHosts = Set((defaults.stringArray(forKey: intentKey + ".disabled") ?? []).prefix(128))
        pendingRevocations = disabledHosts
        do { _ = try ownedIdentityStore.loadCurrent() }
        catch { startupError = "The owned device identity is unavailable." }
        if let ownedForegroundEndpoints {
            guard let identity = try ownedIdentityStore.loadCurrent(),
                  ownedForegroundEndpoints.allSatisfy({ endpoint in
                      if let pin = endpoint.relayPin { return URLComponents(string: pin.relayURL)?.host == "127.0.0.1" }
                      return endpoint.host == "127.0.0.1"
                  })
            else { throw RemiPushError.unavailable }
            let current = MachineStore(endpoints: ownedForegroundEndpoints, identity: identity,
                clientVersion: "owned-foreground-lifecycle", clientId: UUID().uuidString.lowercased(),
                pushStore: ownedPushStore)
            if let ownedSession { current.useOwnedTestSession(ownedSession) }
            store = current
        }
    }
    #endif

    /// Called only by an active foreground scene. Existing v2 identities use a
    /// strict read; creation and legacy migration are confined to this boundary.
    public func activate() {
        #if DEBUG
        // Cold owned callers still cannot bootstrap identity or OS configuration.
        guard !ownedTesting || store != nil else { return }
        #endif
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
                let saved = try MachineConfigurationStore.shared.loadProfilesValidated()
                let startup = saved.map { profile in
                    MachineRouteProfile(machineID: profile.machineID,
                        routes: Self.startupEndpoints(from: profile.routes), displayName: profile.displayName,
                        connectionPreference: profile.connectionPreference, machinePublicKey: profile.machinePublicKey,
                        navigationID: profile.navigationID)
                }.filter { !$0.routes.isEmpty }
                let current = MachineStore(profiles: startup,
                    identity: identity,
                    clientVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0",
                    clientId: clientID(), pushStore: pushStore)
                // A preference cannot install missing or revoked SQLite trust.
                for endpoint in current.persistableEndpoints where intents.contains(endpoint.id) {
                    current.restoreRelayNotificationIntent(on: endpoint)
                }
                store = current
                startupError = nil
            } catch is MachineConfigurationStore.ReadError {
                startupError = "Saved connection settings could not be read. Recover those settings before connecting."
            } catch {
                startupError = "Device identity is unavailable. Remi cannot sign answers with this identity."
            }
        }
        guard let store else { return }
        let alreadyStarted = started
        startForegroundStoreIfNeeded()
        // Mac background entry keeps its menu-bar transports alive. Returning
        // to the foreground still starts a new bounded recovery episode, without
        // reconnecting healthy roots or clearing configured approval/auth stops.
        if alreadyStarted, !actionInFlight { store.foregroundRecoveryActivated() }
        if let carrier = pendingCarrier {
            pendingCarrier = nil
            store.openRelayNotification(carrier: carrier)
            notificationPresentationID = UUID()
            presentsRelayNotification = true
        }
        startAutomaticRegistration()
        // A first host can be paired later in this scene. Token acquisition is
        // independent of that host's foreground-route census (#1680).
        registerWithAPNs()
        if let latestToken { acceptPushToken(latestToken) }
    }

    /// Retries foreground identity loading after a protected store or provider
    /// was temporarily unavailable. Existing identity material is never replaced.
    public func retryStartup() {
        guard store == nil else { return }
        foreground = false
        activate()
    }

    package static func startupEndpoints(from saved: [MachineEndpoint]) -> [MachineEndpoint] {
        saved
    }

    /// Transient inactive scenes (including the permission dialog) retain the
    /// request. Background entry releases every bounded OS continuation.
    public func background(suspendForegroundConnections: Bool = true) {
        foreground = false
        lifecycle = UUID()
        // #1385: the phone relies on bounded push actions while idle. The Mac
        // explicitly retains its continuous menu-bar monitoring instead.
        if suspendForegroundConnections, started {
            started = false
            store?.suspendForegroundConnections()
        }
        cancelEnable()
        automaticTask?.cancel(); automaticTask = nil
        tokenTask?.cancel(); tokenTask = nil
        finishPermission(false)
        finishToken(nil)
        enabling = false
    }

    public func clearNotice() {
        notice = nil
    }

    public func hasRelayNotificationIntent(for endpoint: MachineEndpoint) -> Bool {
        intents.contains(endpoint.id)
    }

    /// Local categories share the app/NSE publication lease and preserve secure IDs.
    public func mergeLocalNotificationCategories(_ categories: Set<UNNotificationCategory>) async -> Bool {
        guard let pushStore else { return false }
        return await withCheckedContinuation { continuation in
            pushStore.mergeNotificationCategories(categories) { continuation.resume(returning: $0) }
        }
    }

    public func enable(on endpoint: MachineEndpoint) {
        guard foreground, !enabling, let current = store,
              current.persistableEndpoints.contains(endpoint) else {
            notice = "Finish pairing and open Remi before enabling notifications."
            return
        }
        let epoch = lifecycle
        let attempt = UUID()
        enableAttempt = attempt
        enablingEndpointID = endpoint.id
        enabling = true
        notice = "Allow notifications to receive alerts."
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
                    self.notice = "The signed APNs environment is unavailable. Notifications require a signed app."
                    self.enabling = false
                }
                return
            }
            self.tokenEnvironment = environment
            current.updateRelayPushToken(token, environment: environment)
            if endpoint.relayPin != nil {
                await current.enableRelayNotifications(on: endpoint)
            } else {
                await current.registerPairedNotifications(on: endpoint,
                    continueAfterInactivity: current.pairedNotificationState(for: endpoint) == .renewalRequired)
            }
            guard self.isEnableCurrent(current, epoch, attempt, endpoint), !Task.isCancelled else { return }
            if let host = current.machines.first(where: { $0.endpoint == endpoint })?.id {
                self.disabledHosts.remove(host); self.pendingRevocations.remove(host)
                self.lastRegistrations[host] = Date()
                self.saveDisabledHosts()
            }
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

    public func revoke(on endpoint: MachineEndpoint) {
        guard let current = store, let host = current.machines.first(where: { $0.endpoint == endpoint })?.id else { return }
        machineWillChange(endpoint)
        disabledHosts.insert(host); pendingRevocations.insert(host)
        saveDisabledHosts()
        Task { [weak self, weak current] in
            guard let self, let current else { return }
            if await current.revokePairedNotifications(on: endpoint) { self.pendingRevocations.remove(host) }
            self.lastRegistrations[host] = nil
        }
    }

    public func isDisabled(on endpoint: MachineEndpoint) -> Bool {
        guard let host = store?.machines.first(where: { $0.endpoint == endpoint })?.id else { return false }
        return disabledHosts.contains(host)
    }

    /// Invoke after the store's durable Forget succeeds. A failed Forget leaves
    /// its endpoint present and keeps the recoverable preference intent.
    public func reconcileEndpoints() {
        guard let store else { return }
        let present = Set(store.machines.map { $0.endpoint.id })
        let retained = intents.intersection(present)
        if retained != intents { intents = retained; saveIntents() }
        let hosts = Set(store.machines.map(\.id))
        disabledHosts.formIntersection(hosts); pendingRevocations.formIntersection(hosts)
        saveDisabledHosts()
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
            self.tokenEnvironment = environment
            self.lastRegistrations.removeAll()
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

    /// Only the OS delegate's original content and action identifier enter this
    /// boundary. Shared verification supplies an immutable signed-choice context.
    /// No UI card, NSE flag, outer route or saved preference grants authority.
    public func receiveAction(_ delivery: NativeRelayActionDelivery) async -> RelayNotificationAnswerOutcome {
        guard let carrier = delivery.carrier,
              let value = try? JSONSerialization.jsonObject(with: carrier) else {
            lastBackgroundActionOutcome = .refused
            return .refused
        }
        let content = UNMutableNotificationContent()
        content.userInfo = ["remiPush": value]
        content.title = delivery.title
        content.subtitle = delivery.subtitle
        content.body = delivery.body
        content.categoryIdentifier = delivery.categoryIdentifier
        return await receiveAction(content: content, identifier: delivery.identifier)
    }

    public func receiveAction(content: UNNotificationContent, identifier: String) async -> RelayNotificationAnswerOutcome {
        guard !actionInFlight else { return .busy }
        actionInFlight = true
        defer {
            backgroundStore = nil
            actionInFlight = false
            startForegroundStoreIfNeeded()
        }
        do {
            guard let pushStore, let identityStore, !Task.isCancelled else { throw RemiPushError.unavailable }
            let verified = try pushStore.verifyAction(content: content, identifier: identifier)
            let current: MachineStore
            if let store {
                current = store
            } else {
                // Strict-read only: a cold notification must never create,
                // migrate or reconcile private/public identity authority.
                guard let identity = try identityStore.loadCurrent(), !identity.requiresAppUnlock else {
                    throw RemiPushError.unavailable
                }
                #if DEBUG
                if !ownedTesting {
                    MachineConnectionPolicyFence.shared.seed(try MachineConfigurationStore.shared.loadProfilesValidated())
                }
                #else
                MachineConnectionPolicyFence.shared.seed(try MachineConfigurationStore.shared.loadProfilesValidated())
                #endif
                current = MachineStore(endpoints: [], identity: identity,
                    clientVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0",
                    clientId: UUID().uuidString.lowercased(), pushStore: pushStore)
                #if DEBUG
                if let ownedSession { current.useOwnedTestSession(ownedSession) }
                #endif
                backgroundStore = current
            }
            #if DEBUG
            if ownedTesting, let observer = ownedBeforeActionSend {
                current.ownedBeforeNativeSend = { proof in try await observer(proof.id) }
            }
            #endif
            try pushStore.recheckAction(verified)
            guard !Task.isCancelled else { throw RemiPushError.unavailable }
            let result = await current.answerRelayNotification(action: verified)
            lastBackgroundActionOutcome = result
            return result
        } catch {
            lastBackgroundActionOutcome = .refused
            return .refused
        }
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
        preferences.set(intents.sorted(), forKey: intentKey)
    }
    private func saveDisabledHosts() {
        guard !intentKey.isEmpty else { return }
        preferences.set(disabledHosts.sorted(), forKey: intentKey + ".disabled")
    }

    /// Polls readiness without opening another foreground route. Only actual app use renews.
    private func startAutomaticRegistration() {
        automaticTask?.cancel()
        automaticTask = Task { [weak self] in
            while let self, self.foreground, !Task.isCancelled {
                await self.refreshPairedNotifications()
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
    }
    private func refreshPairedNotifications() async {
        guard foreground, let current = store, !enabling else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        let allowed = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
        guard foreground, store === current, !Task.isCancelled else { return }
        for machine in current.machines where machine.status == .connected {
            let host = machine.id, endpoint = machine.endpoint
            if !allowed || disabledHosts.contains(host) {
                if !allowed, permissionRevokedHosts.insert(host).inserted { pendingRevocations.insert(host) }
                if pendingRevocations.contains(host), Date().timeIntervalSince(lastRevocations[host] ?? .distantPast) >= 60 {
                    lastRevocations[host] = Date()
                    if await current.revokePairedNotifications(on: endpoint) { pendingRevocations.remove(host) }
                }
                continue
            }
            if permissionRevokedHosts.remove(host) != nil { lastRegistrations[host] = nil }
            guard endpoint.relayPin == nil else { continue }
            guard tokenEnvironment != nil, latestToken != nil else { registerWithAPNs(); continue }
            let state = current.pairedNotificationState(for: endpoint)
            if state == .renewalRequired || state == .registering { continue }
            let interval: TimeInterval = state == .registered ? 15 * 60 : 60
            if let last = lastRegistrations[host], Date().timeIntervalSince(last) < interval { continue }
            lastRegistrations[host] = Date()
            await current.registerPairedNotifications(on: endpoint)
            guard foreground, store === current, !Task.isCancelled else { return }
        }
    }
    private func clientID() -> String {
        let key = "remi.native.client-id"
        if let value = preferences.string(forKey: key) { return value }
        let value = UUID().uuidString.lowercased()
        preferences.set(value, forKey: key)
        return value
    }
    private func startForegroundStoreIfNeeded() {
        guard foreground, !actionInFlight, !started, let store else { return }
        started = true
        store.start()
    }
    private func registerWithAPNs(force: Bool = false) {
        guard force || Date().timeIntervalSince(lastAPNsRegistration ?? .distantPast) >= 30 else { return }
        lastAPNsRegistration = Date()
        #if DEBUG
        ownedPushRegistrationRequestCount += 1
        guard !ownedTesting else { return }
        #endif
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
                registerWithAPNs(force: true)
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
