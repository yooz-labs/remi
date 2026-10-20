//
//  ClientIdentity.swift
//  Remi
//
//  The app's own Ed25519 identity (#872, part 2 of #869). The CLI proves
//  itself to the daemon with a capability token read from
//  ~/.remi/capability.key (PR #874); this app is sandboxed and can never
//  read that path — Remi.entitlements says so explicitly and that is
//  deliberate (#649/#651). This is the sandboxed equivalent: a keypair
//  generated on first launch, whose private key stays in this app's own
//  Keychain item, that lets it complete the daemon's `auth_challenge`
//  handshake exactly like the web/iOS clients do.
//
//  Wire format MUST match packages/shared/src/crypto.ts and
//  packages/daemon/src/auth/authenticator.ts exactly:
//  - the fingerprint is the first 16 hex characters of SHA-256(raw public
//    key bytes) — see `fingerprint()` in crypto.ts.
//  - `clientPublicKey` / `signature` on the wire are base64 of RAW bytes
//    (32-byte Ed25519 public key, 64-byte signature), never PKCS8/DER.
//  - the daemon signs/verifies over the DECODED challenge bytes, never the
//    base64 string itself.
//

import CryptoKit
import Foundation
import Security

/// A holder for this app's Ed25519 signing keypair. Construction is cheap
/// (no I/O); use `ClientIdentityStore.loadOrCreate()` to get the persisted
/// instance.
struct ClientIdentity {
    let privateKey: Curve25519.Signing.PrivateKey
    let revision: String
    /// A migrated passphrase-protected identity may sign only after foreground unlock.
    /// This is an app policy; Keychain protects the native record at rest (#1199/#1201).
    let requiresAppUnlock: Bool

    init(privateKey: Curve25519.Signing.PrivateKey, revision: String = UUID().uuidString,
         requiresAppUnlock: Bool = false) {
        self.privateKey = privateKey
        self.revision = revision
        self.requiresAppUnlock = requiresAppUnlock
    }

    var publicKey: Curve25519.Signing.PublicKey { privateKey.publicKey }

    /// Raw 32-byte Ed25519 public key — base64-encode this directly for the
    /// wire (`clientPublicKey`), never wrap it in PKCS8/DER.
    var publicKeyRaw: Data { publicKey.rawRepresentation }

    /// First 16 hex characters of SHA-256(publicKeyRaw), matching
    /// `fingerprint()` in packages/shared/src/crypto.ts exactly. The daemon
    /// derives its own copy from the verified public key and does NOT trust
    /// a client-claimed value for authorization (#671) — this is sent for
    /// display/logging only, but it must still be correct.
    var fingerprint: String { Self.fingerprint(ofPublicKeyRaw: publicKeyRaw) }

    /// Approval export (#873): contains only the canonical public key and its fingerprint.
    var publicIdentityJSON: String {
        // Both strings contain only base64/hex, so they need no JSON escaping.
        "{\n  \"publicKey\": \"\(publicKeyRaw.base64EncodedString())\",\n  \"fingerprint\": \"\(fingerprint)\"\n}"
    }

    var authorizeCommand: String { "remi authorize \(fingerprint)" }

    static func isSmallOrderPublicKey(_ raw: Data) -> Bool {
        NativeEd25519PublicKey.isSmallOrder(raw)
    }

    static func fingerprint(ofPublicKeyRaw raw: Data) -> String {
        let digest = SHA256.hash(data: raw)
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return String(hex.prefix(16))
    }

    /// Sign raw bytes — the DECODED challenge, never the base64 string —
    /// with this identity's private key.
    func sign(_ data: Data) throws -> Data {
        try privateKey.signature(for: data)
    }
}

/// Strict RFC8410 encoding is native-only. CryptoKit exports a seed, not PKCS8;
/// this fixed DER wrapper is tested against actual shared WebCrypto exports (#1199).
/// Neither this representation nor its seed is ever returned to JavaScript.
enum NativeIdentityError: Error {
    case malformed, publicMismatch, changed, conflict
    case keychain(OSStatus)
}

enum Ed25519PKCS8 {
    private static let prefix = Data([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
                                     0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
    static func encode(_ key: Curve25519.Signing.PrivateKey) -> Data {
        prefix + key.rawRepresentation
    }
    static func decode(_ pkcs8: Data, publicKey: Data) throws -> Curve25519.Signing.PrivateKey {
        guard pkcs8.count == 48, pkcs8.prefix(16) == prefix, publicKey.count == 32 else {
            throw NativeIdentityError.malformed
        }
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: pkcs8.suffix(32))
        guard key.publicKey.rawRepresentation == publicKey else {
            throw NativeIdentityError.publicMismatch
        }
        let probe = Data("remi native identity validation".utf8)
        guard key.publicKey.isValidSignature(try key.signature(for: probe), for: probe) else {
            throw NativeIdentityError.publicMismatch
        }
        return key
    }
}

/// The native Keychain stores a versioned PKCS8/public record. Only exact
/// errSecItemNotFound permits creation; corruption and read errors never rotate a key.
/// Migration/replacement uses SecItemUpdate, preserving the previous item on failure.
enum ClientIdentityStore {
    static let defaultService = "live.yooz.remi.client-identity"
    static let defaultAccount = "ed25519-private-key"
    private struct Record: Codable {
        let version: Int
        let pkcs8: Data
        let publicKey: Data
        let revision: String
        // Optional only for the initial R4 record format; missing means an unprotected native key.
        let requiresAppUnlock: Bool?
        init(_ identity: ClientIdentity) {
            version = 2
            pkcs8 = Ed25519PKCS8.encode(identity.privateKey)
            publicKey = identity.publicKeyRaw
            revision = identity.revision
            requiresAppUnlock = identity.requiresAppUnlock
        }
        func identity() throws -> ClientIdentity {
            guard version == 2, UUID(uuidString: revision) != nil else {
                throw NativeIdentityError.malformed
            }
            return ClientIdentity(privateKey: try Ed25519PKCS8.decode(pkcs8, publicKey: publicKey),
                                  revision: revision, requiresAppUnlock: requiresAppUnlock ?? false)
        }
    }

    private enum ExpectedRecord {
        case absent
        case nativeSeed(Data)
        case identity(ClientIdentity)
    }

    static func loadOrCreate(authority: NativeIdentityAuthorityBarrier, accessGroup: String?, service: String = defaultService, account: String = defaultAccount,
                             operations: NativeKeychainOperations = .system) throws -> ClientIdentity {
        if let identity = try load(authority: authority, accessGroup: accessGroup, service: service, account: account, operations: operations) { return identity }
        let fresh = ClientIdentity(privateKey: .init())
        do { try persist(fresh, expected: .absent, service: service, account: account, updating: false, accessGroup: accessGroup, operations: operations, authority: authority) }
        catch NativeIdentityError.keychain(errSecDuplicateItem) {
            // A concurrent first creation won. Use its durable identity, never overwrite it.
            guard let winner = try load(authority: authority, accessGroup: accessGroup, service: service, account: account, operations: operations) else { throw NativeIdentityError.changed }
            return winner
        }
        return fresh
    }

    static func load(authority: NativeIdentityAuthorityBarrier, accessGroup: String?, service: String = defaultService, account: String = defaultAccount,
                     operations: NativeKeychainOperations = .system) throws -> ClientIdentity? {
        let data: Data
        do {
            guard let stored = try read(accessGroup: accessGroup, service: service, account: account, operations: operations) else {
                try authority.reconcileObservedIdentity(publicKey: nil, revision: nil, requiresAppUnlock: nil)
                return nil
            }
            data = stored
        } catch {
            try authority.reconcileObservedIdentity(publicKey: nil, revision: nil, requiresAppUnlock: nil)
            throw error
        }
        if data.count == 32 {
            // One-time inward migration of the existing native seed, with no deletion.
            let identity = ClientIdentity(privateKey: try .init(rawRepresentation: data))
            try persist(identity, expected: .nativeSeed(data), service: service, account: account, updating: true, accessGroup: accessGroup, operations: operations, authority: authority)
            return identity
        }
        let identity: ClientIdentity
        do { identity = try JSONDecoder().decode(Record.self, from: data).identity() }
        catch {
            try authority.reconcileObservedIdentity(publicKey: nil, revision: nil, requiresAppUnlock: nil)
            throw error
        }
        try authority.reconcileObservedIdentity(publicKey: identity.publicKeyRaw, revision: identity.revision, requiresAppUnlock: identity.requiresAppUnlock)
        return identity
    }

    /// An explicit inward import. A conflicting durable identity is untouched unless
    /// the caller presents its exact revision after a human chose replacement.
    static func importIdentity(authority: NativeIdentityAuthorityBarrier, accessGroup: String?, pkcs8: Data, publicKey: Data, replacing revision: String? = nil, requiresAppUnlock: Bool = false,
                               service: String = defaultService, account: String = defaultAccount,
                             operations: NativeKeychainOperations = .system) throws -> ClientIdentity {
        let key = try Ed25519PKCS8.decode(pkcs8, publicKey: publicKey)
        let existing = try load(authority: authority, accessGroup: accessGroup, service: service, account: account, operations: operations)
        if let existing, existing.publicKeyRaw == publicKey,
           existing.requiresAppUnlock || !requiresAppUnlock { return existing }
        if let existing {
            guard revision == existing.revision else { throw NativeIdentityError.conflict }
        } else if revision != nil { throw NativeIdentityError.changed }
        // Imports may tighten the policy, never silently remove it.
        let imported = ClientIdentity(privateKey: key,
                                      requiresAppUnlock: requiresAppUnlock || existing?.requiresAppUnlock == true)
        try persist(imported, expected: existing.map(ExpectedRecord.identity) ?? .absent, service: service, account: account, updating: existing != nil, accessGroup: accessGroup, operations: operations, authority: authority)
        return imported
    }

    static func requireAppUnlock(authority: NativeIdentityAuthorityBarrier, accessGroup: String?, revision: String, publicKey: Data,
                                 service: String = defaultService, account: String = defaultAccount,
                             operations: NativeKeychainOperations = .system) throws -> ClientIdentity {
        guard let existing = try load(authority: authority, accessGroup: accessGroup, service: service, account: account, operations: operations),
              existing.revision == revision, existing.publicKeyRaw == publicKey else { throw NativeIdentityError.changed }
        if existing.requiresAppUnlock { return existing }
        let protected = ClientIdentity(privateKey: existing.privateKey, requiresAppUnlock: true)
        try persist(protected, expected: .identity(existing), service: service, account: account, updating: true, accessGroup: accessGroup, operations: operations, authority: authority)
        return protected
    }

    #if DEBUG
    static func resetForTesting(service: String, account: String) {
        SecItemDelete(query(accessGroup: nil, service: service, account: account) as CFDictionary)
    }
    #endif

    private static func query(accessGroup: String?, service: String, account: String) -> [String: Any] {
        var value: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account]
        if let accessGroup { value[kSecAttrAccessGroup as String] = accessGroup }
        return value
    }
    private static func read(accessGroup: String?, service: String, account: String, operations: NativeKeychainOperations) throws -> Data? {
        var q = query(accessGroup: accessGroup, service: service, account: account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = operations.copyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw NativeIdentityError.keychain(status) }
        guard let data = result as? Data else { throw NativeIdentityError.malformed }
        return data
    }
    private static func persist(_ identity: ClientIdentity, expected: ExpectedRecord, service: String, account: String, updating: Bool, accessGroup: String?, operations: NativeKeychainOperations, authority: NativeIdentityAuthorityBarrier) throws {
        let data = try JSONEncoder().encode(Record(identity))
        let lease = try authority.acquireIdentityMutation()
        defer { lease.release() }
        // The policy decision was prepared before acquiring the nonblocking
        // writer lock. Recheck the actual Keychain context before mutation.
        let current = try read(accessGroup: accessGroup, service: service, account: account, operations: operations)
        switch expected {
        case .absent:
            guard current == nil else { throw NativeIdentityError.keychain(errSecDuplicateItem) }
        case .nativeSeed(let seed):
            guard current == seed else {
                _ = try lease.invalidateIdentityAuthority()
                throw NativeIdentityError.changed
            }
        case .identity(let expected):
            guard let current, let record = try? JSONDecoder().decode(Record.self, from: current),
                  let actual = try? record.identity(), actual.revision == expected.revision,
                  actual.publicKeyRaw == expected.publicKeyRaw,
                  actual.requiresAppUnlock == expected.requiresAppUnlock else {
                _ = try lease.invalidateIdentityAuthority()
                throw NativeIdentityError.changed
            }
        }
        // This commit closes public trust before any private-record write.
        // A Keychain failure never restores the older authority.
        let generation = try lease.invalidateIdentityAuthority()
        let q = query(accessGroup: accessGroup, service: service, account: account)
        let status: OSStatus
        if updating {
            status = operations.update(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        } else {
            var attributes = q
            attributes[kSecValueData as String] = data
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = operations.add(attributes as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw NativeIdentityError.keychain(status) }
        guard let verified = try read(accessGroup: accessGroup, service: service, account: account, operations: operations), verified == data else {
            throw NativeIdentityError.changed
        }
        _ = try JSONDecoder().decode(Record.self, from: verified).identity()
        try lease.installIdentityAuthority(publicKey: identity.publicKeyRaw, revision: identity.revision,
                                           requiresAppUnlock: identity.requiresAppUnlock, generation: generation)
    }
}

/// Native direct-answer signer and the existing public session-route storage.
/// Preferences seed import is inward-only for pre-R4 installs; native keys never leave Swift.
enum RemiNativeStore {
    struct Auth { let signature: String; let publicKey: String; let fingerprint: String }
    struct Route { let wsUrl: String; let claudeSessionId: String? }

    private static let identityKey = "CapacitorStorage.remi-native-identity"
    private static let routesKey = "CapacitorStorage.remi-native-routes"

    /// The direct /answer wire remains until R6. Sign with the durable native
    /// provider before legacy Preferences cleanup; return only public bytes/signature.
    /// An existing conflicting legacy key refuses rather than silently selecting a key.
    static func sign(message: String, accessGroup: String?, identity: ClientIdentity? = nil, defaults: UserDefaults = .standard,
                     service: String = ClientIdentityStore.defaultService, account: String = ClientIdentityStore.defaultAccount,
                     authority: NativeIdentityAuthorityBarrier = NativePushConfiguration.identityAuthority) -> Auth? {
        guard message.utf8.count <= 4096 else { return nil }
        do {
            var native = identity
            if native == nil {
                native = try ClientIdentityStore.load(authority: authority, accessGroup: accessGroup, service: service, account: account)
                if let raw = defaults.string(forKey: identityKey) {
                    guard let data = raw.data(using: .utf8),
                        let obj = try JSONSerialization.jsonObject(with: data) as? [String: String],
                        let seed = Data(base64Encoded: obj["seed"] ?? ""), seed.count == 32,
                        let publicKey = Data(base64Encoded: obj["publicKey"] ?? ""), publicKey.count == 32
                    else { return nil }
                    let legacy = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
                    guard legacy.publicKey.rawRepresentation == publicKey else { return nil }
                    if let native, native.publicKeyRaw != publicKey { return nil }
                    if native == nil {
                        native = try ClientIdentityStore.importIdentity(
                            authority: authority, accessGroup: accessGroup, pkcs8: Ed25519PKCS8.encode(legacy), publicKey: publicKey,
                            service: service, account: account)
                    }
                }
            }
            guard let native, !native.requiresAppUnlock else { return nil }
            let signature = try native.sign(Data(message.utf8))
            return Auth(signature: signature.base64EncodedString(),
                        publicKey: native.publicKeyRaw.base64EncodedString(), fingerprint: native.fingerprint)
        } catch {
            NSLog("[remi] Native direct-answer identity unavailable; open the app")
            return nil
        }
    }

    /// Look up the daemon ws URL pinned for a session (written by the web app).
    /// Distinguishes "never set up" (silent nil) from a corrupt blob (logged) so
    /// the two failure modes aren't indistinguishable in the device log.
    static func route(forSession sessionId: String) -> Route? {
        guard let raw = UserDefaults.standard.string(forKey: routesKey) else { return nil }
        guard let data = raw.data(using: .utf8),
              let map = (try? JSONSerialization.jsonObject(with: data)) as? [String: [String: String]]
        else {
            NSLog("[remi] RemiNativeStore: routes blob is corrupt or unreadable")
            return nil
        }
        guard let r = map[sessionId], let wsUrl = r["wsUrl"] else { return nil }
        return Route(wsUrl: wsUrl, claudeSessionId: r["claudeSessionId"])
    }
}
