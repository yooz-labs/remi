import CryptoKit
import Foundation
import Security
import RemiPush

/// Remi's persistent Ed25519 client identity.
///
/// Wire values are raw bytes encoded as base64. Challenges are decoded from base64 before
/// signing. The private key never leaves the Keychain-backed value held by this type.
public struct ClientIdentity: Sendable {
    let privateKey: Curve25519.Signing.PrivateKey
    public let revision: String
    public let requiresAppUnlock: Bool
    private let validateDurable: (@Sendable () throws -> Void)?

    public init() {
        privateKey = Curve25519.Signing.PrivateKey()
        revision = UUID().uuidString; requiresAppUnlock = false; validateDurable = nil
    }

    init(rawPrivateKey: Data) throws {
        privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: rawPrivateKey)
        revision = UUID().uuidString; requiresAppUnlock = false; validateDurable = nil
    }

    init(privateKey: Curve25519.Signing.PrivateKey, revision: String = UUID().uuidString,
         requiresAppUnlock: Bool = false, validateDurable: (@Sendable () throws -> Void)? = nil) {
        self.privateKey = privateKey; self.revision = revision
        self.requiresAppUnlock = requiresAppUnlock; self.validateDurable = validateDurable
    }

    public var pushAuthority: PushDeviceAuthority {
        .init(publicKey: publicKeyRaw, revision: revision, requiresAppUnlock: requiresAppUnlock)
    }

    var rawPrivateKey: Data { privateKey.rawRepresentation }

    public var publicKeyRaw: Data { privateKey.publicKey.rawRepresentation }

    public var publicKeyBase64: String { publicKeyRaw.base64EncodedString() }

    public var fingerprint: String {
        Self.fingerprint(ofPublicKeyRaw: publicKeyRaw)
    }

    public var authorizeCommand: String {
        "remi authorize \(fingerprint) --label device"
    }

    public var publicIdentity: PublicClientIdentity {
        PublicClientIdentity(publicKey: publicKeyBase64, fingerprint: fingerprint)
    }

    public func signature(for challenge: Data) throws -> Data {
        try validateForSigning()
        return try privateKey.signature(for: challenge)
    }

    func validateForSigning() throws {
        // No native foreground passphrase unlock exists. Protected records never sign.
        guard !requiresAppUnlock else { throw NativeIdentityError.protected }
        try validateDurable?()
    }

    /// A restricted connection still uses the real durable provider, adding its
    /// original-capsule checks to EVERY admission/H2/final signature.
    func restrictingSignatures(_ restriction: @escaping @Sendable () throws -> Void) -> ClientIdentity {
        ClientIdentity(privateKey: privateKey, revision: revision, requiresAppUnlock: requiresAppUnlock,
            validateDurable: { try self.validateForSigning(); try restriction() })
    }

    public func signatureBase64(for challenge: Data) throws -> String {
        try signature(for: challenge).base64EncodedString()
    }

    public static func fingerprint(ofPublicKeyRaw raw: Data) -> String {
        let digest = SHA256.hash(data: raw)
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    /// The reviewed low-order Ed25519 encodings rejected by the shared implementation.
    public static func isSmallOrderPublicKey(_ raw: Data) -> Bool {
        smallOrderPublicKeys.contains(raw.map { String(format: "%02x", $0) }.joined())
    }

    private static let smallOrderPublicKeys: Set<String> = [
        "0100000000000000000000000000000000000000000000000000000000000000",
        "0100000000000000000000000000000000000000000000000000000000000080",
        "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0000000000000000000000000000000000000000000000000000000000000080",
        "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    ]
}

public struct PublicClientIdentity: Sendable, Equatable {
    public let publicKey: String
    public let fingerprint: String

    public init(publicKey: String, fingerprint: String) {
        self.publicKey = publicKey
        self.fingerprint = fingerprint
    }

    public var exportJSON: String {
        #"{"publicKey":"\#(publicKey)"}"#
    }

    public func authorizeCommand(label: String) -> String {
        let normalizedLabel = label.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        let safeLabel = (normalizedLabel.isEmpty ? "device" : normalizedLabel)
            .replacingOccurrences(of: "'", with: "'\\''")
        return "remi authorize \(fingerprint) --label '\(safeLabel)'"
    }
}

/// The app-exclusive Dpk item preserves the legacy version2 format and its protection policy.
/// Every persisted identity signs only after a fresh no-UI durable revision check.
public struct ClientIdentityStore: Sendable {
    public static let shared = ClientIdentityStore(service: NativeIdentityRecordStore.defaultService,
        account: NativeIdentityRecordStore.defaultAccount)
    private let service: String
    private let account: String
    private let suppliedPushStore: RemiPushStore?
    private let suppliedAccessGroup: String?

    public init(service: String, account: String, pushStore: RemiPushStore? = nil, accessGroup: String? = nil) {
        self.service = service; self.account = account
        suppliedPushStore = pushStore; suppliedAccessGroup = accessGroup
    }
    #if DEBUG
    public func isOwnedTestIdentity(for push: RemiPushStore) -> Bool {
        push.isOwnedTestStore && suppliedPushStore === push && suppliedAccessGroup == nil &&
            service.hasPrefix("live.yooz.remi.tests.") && UUID(uuidString: account) != nil
    }
    #endif
    private func context() throws -> (RemiPushStore, String?) {
        if let suppliedPushStore {
            #if DEBUG
            if service.hasPrefix("live.yooz.remi.tests.") { return (suppliedPushStore, suppliedAccessGroup) }
            #endif
            return (suppliedPushStore, try suppliedAccessGroup ?? RemiPushStore.configuredAccessGroup("RemiIdentityAccessGroup"))
        }
        return (try RemiPushStore.configured(), try RemiPushStore.configuredAccessGroup("RemiIdentityAccessGroup"))
    }
    public func loadOrCreate() throws -> ClientIdentity {
        let (push, group) = try context()
        let value = try NativeIdentityRecordStore.loadOrCreate(authority: NativePushAuthorityAdapter(push),
            accessGroup: group, service: service, account: account)
        return validated(value, push: push, group: group)
    }
    public func load() throws -> ClientIdentity? {
        let (push, group) = try context()
        return try NativeIdentityRecordStore.load(authority: NativePushAuthorityAdapter(push),
            accessGroup: group, service: service, account: account).map { validated($0, push: push, group: group) }
    }
    /// Cold background launch/load-only path. It never migrates or creates Dpk.
    public func loadCurrent() throws -> ClientIdentity? {
        let (push, group) = try context()
        return try NativeIdentityRecordStore.currentRecord(accessGroup: group, service: service, account: account)
            .map { validated($0, push: push, group: group) }
    }
    private func validated(_ value: ClientIdentity, push: RemiPushStore, group: String?) -> ClientIdentity {
        let expected = value.pushAuthority
        return ClientIdentity(privateKey: value.privateKey, revision: value.revision,
            requiresAppUnlock: value.requiresAppUnlock, validateDurable: {
                guard let current = try NativeIdentityRecordStore.currentRecord(
                    accessGroup: group, service: self.service, account: self.account),
                    current.pushAuthority == expected, !current.requiresAppUnlock else { throw NativeIdentityError.changed }
            })
    }
}
