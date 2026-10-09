import Foundation
import UserNotifications

public enum RemiPushError: Error, Sendable { case unavailable, changed, invalid }

public struct PushDeviceAuthority: Sendable, Equatable {
    public let publicKey: Data
    public let revision: String
    public let requiresAppUnlock: Bool
    public init(publicKey: Data, revision: String, requiresAppUnlock: Bool) {
        self.publicKey = publicKey; self.revision = revision; self.requiresAppUnlock = requiresAppUnlock
    }
    fileprivate var native: NativePushState.Authority {
        .init(publicKey: publicKey, revision: revision, requiresAppUnlock: requiresAppUnlock)
    }
    fileprivate init(_ value: NativePushState.Authority) {
        self.init(publicKey: value.publicKey, revision: value.revision, requiresAppUnlock: value.requiresAppUnlock)
    }
}

public struct PushMachineTrust: Sendable, Equatable {
    public let room: Data
    public let machinePublicKey: Data
    public let origin: String
    public let relayURL: String
    public let authority: PushDeviceAuthority
    fileprivate init(_ value: NativePushState.MachineTrust) throws {
        guard let route = value.relayUrl else { throw RemiPushError.unavailable }
        room = value.rid; machinePublicKey = value.machinePublicKey
        origin = value.endpoint; relayURL = route; authority = .init(value.authority)
    }
}

public struct PushRegistrationRecipient: Sendable, Equatable {
    public let publicKey: Data
    public let keyVersion: Int
}

public struct VerifiedPushOption: Sendable, Equatable {
    public let value: String
    public let label: String
    public let isYes: Bool
    public let isNo: Bool
    public let description: String?
    public let standingGrant: String?
}

/// Constructed only by reopening the original signed capsule and committing its lifecycle.
/// The opaque prepared value never supplies an NSE with the device signing key.
public struct VerifiedPushNotification: @unchecked Sendable {
    public enum Kind: Sendable { case question, information, dismiss }
    public let kind: Kind
    public let title: String
    public let body: String
    public let sessionID: String?
    public let questionID: String?
    public let runtimeInstance: String?
    public let category: String
    public let options: [VerifiedPushOption]
    public let machine: PushMachineTrust
    public let collapseID: String
    public let revision: Int64
    public let contentDigest: Data
    public let expiresAt: Int64
    public let originalCarrier: Data
    fileprivate let owner: UUID
    fileprivate let prepared: NativePushEffect.Prepared

    fileprivate init(_ prepared: NativePushEffect.Prepared, owner: UUID) throws {
        self.owner = owner; self.prepared = prepared
        let push = prepared.push
        machine = try .init(push.trust)
        collapseID = push.record.collapseId; revision = push.record.revision
        contentDigest = push.record.digest; expiresAt = push.record.expiresAt
        originalCarrier = try JSONSerialization.data(withJSONObject: push.originalCarrier.userInfo, options: [.sortedKeys])
        switch push.payload {
        case .question(let value):
            kind = .question; title = PushDisplayText.escape(value.title); body = PushDisplayText.escape(value.body)
            sessionID = value.sessionId; questionID = value.questionId
            runtimeInstance = value.runtimeInstance; category = value.category.rawValue
            options = value.options.map { .init(value: $0.value, label: $0.label, isYes: $0.isYes,
                isNo: $0.isNo, description: $0.description, standingGrant: $0.standingGrant?.rawValue) }
        case .informational(let value):
            kind = .information; title = PushDisplayText.escape(value.title); body = PushDisplayText.escape(value.body)
            sessionID = value.sessionId; questionID = nil; runtimeInstance = nil; category = "none"; options = []
        case .dismiss:
            kind = .dismiss; title = ""; body = ""; sessionID = nil; questionID = nil
            runtimeInstance = nil; category = "none"; options = []
        }
    }
}

/// Synchronous lease: the private writer invalidates public authority before Keychain mutation.
public final class PushIdentityMutationLease {
    private let native: NativeIdentityMutationLease
    fileprivate init(_ native: NativeIdentityMutationLease) { self.native = native }
    public func invalidate() throws -> Int64 { try native.invalidateIdentityAuthority() }
    public func install(_ authority: PushDeviceAuthority, generation: Int64) throws {
        try native.installIdentityAuthority(publicKey: authority.publicKey, revision: authority.revision,
            requiresAppUnlock: authority.requiresAppUnlock, generation: generation)
    }
    public func release() { native.release() }
}

/// The facade shares only public authority and the P256 recipient with the NSE.
/// Internal SQLite connections serialize access; Keychain keys are read and rechecked at effects.
public final class RemiPushStore: @unchecked Sendable {
    private let state: NativePushState
    private let keys: NativePushKeyStore
    private let owner = UUID()
    let categoryLockURL: URL
    #if DEBUG
    public let isOwnedTestStore: Bool
    #endif
    private init(state: NativePushState, keys: NativePushKeyStore, file: URL, owned: Bool = false) {
        self.state = state; self.keys = keys
        categoryLockURL = file.appendingPathExtension("category-lock")
        #if DEBUG
        isOwnedTestStore = owned
        #endif
    }

    static func configuredApplicationGroup(bundle: Bundle) throws -> String {
        let accessGroup = try configuredAccessGroup("RemiPushAccessGroup", bundle: bundle)
        #if os(macOS)
        // macOS validates this group against the signing team (#1242). A group.
        // identifier instead needs a profile grant that automatic Mac signing omitted.
        let team = accessGroup.split(separator: ".", maxSplits: 1)[0]
        return "\(team).live.yooz.remi"
        #else
        return "group.live.yooz.remi"
        #endif
    }

    public static func configured(bundle: Bundle = .main) throws -> RemiPushStore {
        let applicationGroup = try configuredApplicationGroup(bundle: bundle)
        guard let namespace = bundle.object(forInfoDictionaryKey: "RemiPushNamespace") as? String,
              ["native-debug", "native-release"].contains(namespace),
              let container = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: applicationGroup) else { throw RemiPushError.unavailable }
        // Resolve declared sharing before opening state or writing any credential.
        let group = try configuredAccessGroup("RemiPushAccessGroup", bundle: bundle)
        let directory = container.appendingPathComponent(namespace, isDirectory: true)
        try NativePushFileProtection.prepareDirectory(directory)
        return try RemiPushStore(state: NativePushState(file: directory.appendingPathComponent("secure-push.sqlite")),
            keys: NativePushKeyStore(service: "live.yooz.remi.native.secure-push.\(namespace)",
                account: "p256-seal-key-v2.\(namespace)", accessGroup: group),
            file: directory.appendingPathComponent("secure-push.sqlite"))
    }

    public static func configuredAccessGroup(_ name: String, bundle: Bundle = .main) throws -> String {
        guard ["RemiIdentityAccessGroup", "RemiPushAccessGroup"].contains(name),
              let group = bundle.object(forInfoDictionaryKey: name) as? String,
              !group.isEmpty, group.utf8.count <= 256,
              let prefix = group.split(separator: ".", maxSplits: 1).first, !prefix.isEmpty,
              prefix.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) }),
              group.contains("."), group.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) ||
                (97...122).contains($0) || $0 == 46 || $0 == 45 }) else { throw RemiPushError.unavailable }
        return group
    }

    #if DEBUG
    /// Explicit owned test state. Production configuration has no file/container fallback.
    public static func ownedTestStore(file: URL, service: String, account: String) throws -> RemiPushStore {
        guard file.isFileURL, service.hasPrefix("live.yooz.remi.tests."), UUID(uuidString: account) != nil else {
            throw RemiPushError.invalid
        }
        let parent = file.deletingLastPathComponent().resolvingSymlinksInPath()
        let temporary = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
        guard parent.path.hasPrefix(temporary.path + "/"), parent.lastPathComponent.hasPrefix("remi-x2-") else {
            throw RemiPushError.invalid
        }
        return try RemiPushStore(state: NativePushState(file: file),
            keys: NativePushKeyStore(service: service, account: account, accessGroup: nil), file: file, owned: true)
    }
    #endif

    public func authority() throws -> PushDeviceAuthority? { try state.currentAuthority().map(PushDeviceAuthority.init) }
    public func generation() throws -> Int64 { try state.authorityGeneration() }
    public func acquireIdentityMutation() throws -> PushIdentityMutationLease { try .init(state.acquireIdentityMutation()) }
    public func reconcileIdentity(_ observed: PushDeviceAuthority?) throws {
        try state.reconcileObservedIdentity(publicKey: observed?.publicKey, revision: observed?.revision,
            requiresAppUnlock: observed?.requiresAppUnlock)
    }
    public func machine(room: Data) throws -> PushMachineTrust? { try state.machineTrust(rid: room).map(PushMachineTrust.init) }
    public func completedMachines() throws -> [PushMachineTrust] { try state.completedMachineTrusts().map(PushMachineTrust.init) }
    public func commitMachine(room: Data, machinePublicKey: Data, origin: String, relayURL: String,
                              authority: PushDeviceAuthority, generation: Int64) throws {
        try state.installMachineTrust(.init(rid: room, machinePublicKey: machinePublicKey, endpoint: origin,
            authority: authority.native, relayUrl: relayURL), generation: generation)
    }
    public func forgetMachine(room: Data) throws { try state.forgetMachine(rid: room) }
    public func recipient(createIfMissing: Bool = false) throws -> PushRegistrationRecipient? {
        let key = try createIfMissing ? keys.loadOrCreate() : keys.load()
        return key.map { .init(publicKey: $0.publicKey, keyVersion: $0.keyVersion) }
    }
    public func repairCorruptRecipient() throws { try keys.repairCorruptItem() }
    public func open(carrier: Data, now: Int64 = Int64(Date().timeIntervalSince1970)) throws -> VerifiedPushNotification {
        let original = try NativePushCodec.parseCarrier(carrier)
        let effect = NativePushEffect(state: state, keys: keys, now: { now })
        return try .init(effect.prepare(userInfo: ["remiPush": original.userInfo]), owner: owner)
    }
    public func recheck(_ notification: VerifiedPushNotification,
                        now: Int64 = Int64(Date().timeIntervalSince1970)) throws {
        guard notification.owner == owner else { throw RemiPushError.changed }
        try NativePushEffect(state: state, keys: keys, now: { now }).recheck(notification.prepared)
    }
    public func allowsPresentation(_ content: UNNotificationContent) -> Bool {
        do {
            guard let carrier = content.userInfo["remiPush"], JSONSerialization.isValidJSONObject(carrier) else { return false }
            let opened = try open(carrier: JSONSerialization.data(withJSONObject: carrier))
            guard opened.kind != .dismiss, Data(content.title.utf8) == Data(opened.title.utf8),
                  Data(content.body.utf8) == Data(opened.body.utf8), content.subtitle.isEmpty else { return false }
            try recheck(opened)
            // Verified alerts can intentionally have no actions when publication
            // fails or the signed shape/protection policy requires the app.
            if content.categoryIdentifier.isEmpty { return true }
            guard let actions = try actionSet(for: opened) else { return false }
            return Data(content.categoryIdentifier.utf8) == Data(actions.categoryIdentifier.utf8)
        } catch { return false }
    }
    public func receiveDismiss(carrier: Data, completion: @escaping @Sendable (Bool?) -> Void) {
        do {
            let original = try NativePushCodec.parseCarrier(carrier)
            NativePushNotificationConsumer(state: state, keys: keys).receiveDismiss(userInfo: ["remiPush": original.userInfo]) { result in
                switch result { case .removed: completion(true); case .ignored: completion(false); case .unavailable: completion(nil) }
            }
        } catch { completion(nil) }
    }
    @MainActor public static func runtimeAPNsEnvironment(stillCurrent: @escaping @MainActor () -> Bool) async -> String? {
        switch await NativeAPNsEnvironment().resolve(stillCurrent: stillCurrent) {
        case .production: "production"
        case .sandbox: "sandbox"
        case .unavailable: nil
        }
    }
}
