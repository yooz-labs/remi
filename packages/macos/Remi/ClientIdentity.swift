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

    init(privateKey: Curve25519.Signing.PrivateKey, revision: String = UUID().uuidString) {
        self.privateKey = privateKey
        self.revision = revision
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

    /// Cross-language copy of the reviewed 14 encodings in shared/ed25519-public-key.ts.
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
        init(_ identity: ClientIdentity) {
            version = 2
            pkcs8 = Ed25519PKCS8.encode(identity.privateKey)
            publicKey = identity.publicKeyRaw
            revision = identity.revision
        }
        func identity() throws -> ClientIdentity {
            guard version == 2, UUID(uuidString: revision) != nil else {
                throw NativeIdentityError.malformed
            }
            return ClientIdentity(privateKey: try Ed25519PKCS8.decode(pkcs8, publicKey: publicKey),
                                  revision: revision)
        }
    }

    static func loadOrCreate(service: String = defaultService, account: String = defaultAccount) throws -> ClientIdentity {
        if let identity = try load(service: service, account: account) { return identity }
        let fresh = ClientIdentity(privateKey: .init())
        do { try persist(fresh, service: service, account: account, updating: false) }
        catch NativeIdentityError.keychain(errSecDuplicateItem) {
            // A concurrent first creation won. Use its durable identity, never overwrite it.
            guard let winner = try load(service: service, account: account) else { throw NativeIdentityError.changed }
            return winner
        }
        return fresh
    }

    static func load(service: String = defaultService, account: String = defaultAccount) throws -> ClientIdentity? {
        guard let data = try read(service: service, account: account) else { return nil }
        if data.count == 32 {
            // One-time inward migration of the existing native seed, with no deletion.
            let identity = ClientIdentity(privateKey: try .init(rawRepresentation: data))
            try persist(identity, service: service, account: account, updating: true)
            return identity
        }
        let record: Record
        do { record = try JSONDecoder().decode(Record.self, from: data) }
        catch { throw NativeIdentityError.malformed }
        return try record.identity()
    }

    /// An explicit inward import. A conflicting durable identity is untouched unless
    /// the caller presents its exact revision after a human chose replacement.
    static func importIdentity(pkcs8: Data, publicKey: Data, replacing revision: String? = nil,
                               service: String = defaultService, account: String = defaultAccount) throws -> ClientIdentity {
        let key = try Ed25519PKCS8.decode(pkcs8, publicKey: publicKey)
        let existing = try load(service: service, account: account)
        if let existing, existing.publicKeyRaw == publicKey { return existing }
        if let existing {
            guard revision == existing.revision else { throw NativeIdentityError.conflict }
        } else if revision != nil { throw NativeIdentityError.changed }
        let imported = ClientIdentity(privateKey: key)
        try persist(imported, service: service, account: account, updating: existing != nil)
        return imported
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
    private static func read(service: String, account: String) throws -> Data? {
        var q = query(service: service, account: account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw NativeIdentityError.keychain(status) }
        guard let data = result as? Data else { throw NativeIdentityError.malformed }
        return data
    }
    private static func persist(_ identity: ClientIdentity, service: String, account: String, updating: Bool) throws {
        let data = try JSONEncoder().encode(Record(identity))
        let q = query(service: service, account: account)
        let status: OSStatus
        if updating {
            status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        } else {
            var attributes = q
            attributes[kSecValueData as String] = data
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(attributes as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw NativeIdentityError.keychain(status) }
        guard let verified = try read(service: service, account: account), verified == data else {
            throw NativeIdentityError.changed
        }
        _ = try JSONDecoder().decode(Record.self, from: verified).identity()
    }
}
