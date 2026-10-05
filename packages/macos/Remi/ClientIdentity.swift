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

    /// Cross-language copy of the reviewed 14 encodings in shared/relay/small-order.ts.
    /// ClientIdentityTests validates this against helper-generated public fixtures;
    /// no new curve algorithm is implemented here (#873).
    private static let smallOrderEncodings: Set<String> = [
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

    static func isSmallOrderPublicKey(_ raw: Data) -> Bool {
        smallOrderEncodings.contains(raw.map { String(format: "%02x", $0) }.joined())
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

/// Only the OS boundary is injectable. The production store, codec, migration,
/// durable verification and refusal branches are always constructed unchanged.
struct NativeKeychainOperations {
    var copyMatching: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    var add: (CFDictionary, UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    var update: (CFDictionary, CFDictionary) -> OSStatus
    static var system: Self { .init(copyMatching:SecItemCopyMatching,add:SecItemAdd,update:SecItemUpdate) }
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

    static func loadOrCreate(service: String = defaultService, account: String = defaultAccount,
                             operations: NativeKeychainOperations = .system) throws -> ClientIdentity {
        if let identity = try load(service: service, account: account, operations: operations) { return identity }
        let fresh = ClientIdentity(privateKey: .init())
        do { try persist(fresh, service: service, account: account, updating: false, operations: operations) }
        catch NativeIdentityError.keychain(errSecDuplicateItem) {
            // A concurrent first creation won. Use its durable identity, never overwrite it.
            guard let winner = try load(service: service, account: account, operations: operations) else { throw NativeIdentityError.changed }
            return winner
        }
        return fresh
    }

    static func load(service: String = defaultService, account: String = defaultAccount,
                     operations: NativeKeychainOperations = .system) throws -> ClientIdentity? {
        guard let data = try read(service: service, account: account, operations: operations) else { return nil }
        if data.count == 32 {
            // One-time inward migration of the existing native seed, with no deletion.
            let identity = ClientIdentity(privateKey: try .init(rawRepresentation: data))
            try persist(identity, service: service, account: account, updating: true, operations: operations)
            return identity
        }
        let record: Record
        do { record = try JSONDecoder().decode(Record.self, from: data) }
        catch { throw NativeIdentityError.malformed }
        return try record.identity()
    }

    /// An explicit inward import. A conflicting durable identity is untouched unless
    /// the caller presents its exact revision after a human chose replacement.
    static func importIdentity(pkcs8: Data, publicKey: Data, replacing revision: String? = nil, requiresAppUnlock: Bool = false,
                               service: String = defaultService, account: String = defaultAccount,
                             operations: NativeKeychainOperations = .system) throws -> ClientIdentity {
        let key = try Ed25519PKCS8.decode(pkcs8, publicKey: publicKey)
        let existing = try load(service: service, account: account, operations: operations)
        if let existing, existing.publicKeyRaw == publicKey,
           existing.requiresAppUnlock || !requiresAppUnlock { return existing }
        if let existing {
            guard revision == existing.revision else { throw NativeIdentityError.conflict }
        } else if revision != nil { throw NativeIdentityError.changed }
        // Imports may tighten the policy, never silently remove it.
        let imported = ClientIdentity(privateKey: key,
                                      requiresAppUnlock: requiresAppUnlock || existing?.requiresAppUnlock == true)
        try persist(imported, service: service, account: account, updating: existing != nil, operations: operations)
        return imported
    }

    static func requireAppUnlock(revision: String, publicKey: Data,
                                 service: String = defaultService, account: String = defaultAccount,
                             operations: NativeKeychainOperations = .system) throws -> ClientIdentity {
        guard let existing = try load(service: service, account: account, operations: operations),
              existing.revision == revision, existing.publicKeyRaw == publicKey else { throw NativeIdentityError.changed }
        if existing.requiresAppUnlock { return existing }
        let protected = ClientIdentity(privateKey: existing.privateKey, requiresAppUnlock: true)
        try persist(protected, service: service, account: account, updating: true, operations: operations)
        return protected
    }

    #if DEBUG
    static func resetForTesting(service: String, account: String) {
        SecItemDelete(query(service: service, account: account) as CFDictionary)
    }
    #endif

    private static func query(service: String, account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }
    private static func read(service: String, account: String, operations: NativeKeychainOperations) throws -> Data? {
        var q = query(service: service, account: account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = operations.copyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw NativeIdentityError.keychain(status) }
        guard let data = result as? Data else { throw NativeIdentityError.malformed }
        return data
    }
    private static func persist(_ identity: ClientIdentity, service: String, account: String, updating: Bool, operations: NativeKeychainOperations) throws {
        let data = try JSONEncoder().encode(Record(identity))
        let q = query(service: service, account: account)
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
        guard let verified = try read(service: service, account: account, operations: operations), verified == data else {
            throw NativeIdentityError.changed
        }
        _ = try JSONDecoder().decode(Record.self, from: verified).identity()
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
    static func sign(message: String, identity: ClientIdentity? = nil, defaults: UserDefaults = .standard) -> Auth? {
        guard message.utf8.count <= 4096 else { return nil }
        do {
            var native = identity
            if native == nil {
                native = try ClientIdentityStore.load()
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
                            pkcs8: Ed25519PKCS8.encode(legacy), publicKey: publicKey)
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
