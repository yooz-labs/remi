//
//  ClientIdentity.swift
//  Remi
//
//  The app's own Ed25519 identity (#872, part 2 of #869). The CLI proves
//  itself to the daemon with a capability token read from
//  ~/.remi/capability.key (PR #874); this app is sandboxed and can never
//  read that path — Remi.entitlements says so explicitly and that is
//  deliberate (#649/#651). This is the sandboxed equivalent: a keypair
//  generated on first launch, held in this app's own Keychain item, that
//  never leaves the app and lets it complete the daemon's `auth_challenge`
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

/// Loads or creates this app's `ClientIdentity`, persisted in the Keychain
/// so the daemon's TOFU trust survives relaunches — regenerating a new key
/// on every launch would mean re-earning trust (or, once `--no-tofu` is set
/// on the daemon, never connecting at all) every single time.
///
/// No new entitlement is needed: a sandboxed app can create and read its own
/// default-access-group Keychain items without the `keychain-access-groups`
/// entitlement, which is only required to SHARE items with other apps. That
/// matters here — Remi.entitlements is deliberately minimal (#649/#651) and
/// this must not be the thing that grows it.
enum ClientIdentityStore {
    private static let defaultService = "live.yooz.remi.client-identity"
    private static let defaultAccount = "ed25519-private-key"

    /// Idempotent across calls and across relaunches: the first call
    /// generates and persists a fresh keypair, every later call (this
    /// process or a future one) returns the SAME key.
    static func loadOrCreate(
        service: String = defaultService, account: String = defaultAccount
    ) -> ClientIdentity {
        if let raw = read(service: service, account: account),
            let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw)
        {
            return ClientIdentity(privateKey: key)
        }
        let fresh = Curve25519.Signing.PrivateKey()
        write(fresh.rawRepresentation, service: service, account: account)
        return ClientIdentity(privateKey: fresh)
    }

    /// Test-only teardown: deletes the Keychain item so a test can assert
    /// fresh-vs-persisted behavior without leaking state into later runs.
    #if DEBUG
    static func resetForTesting(service: String = defaultService, account: String = defaultAccount)
    {
        SecItemDelete(query(service: service, account: account) as CFDictionary)
    }
    #endif

    private static func query(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private static func read(service: String, account: String) -> Data? {
        var attributes = query(service: service, account: account)
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(attributes as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return data
    }

    @discardableResult
    private static func write(_ data: Data, service: String, account: String) -> Bool {
        // Idempotent even if a previous write left something malformed
        // (e.g. wrong length after a future format change) — always start
        // from a clean slate rather than risk SecItemAdd's "already exists"
        // error hiding a stale, unreadable key underneath.
        SecItemDelete(query(service: service, account: account) as CFDictionary)

        var attributes = query(service: service, account: account)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status != errSecSuccess {
            NSLog("[ClientIdentityStore] Keychain write failed: status \(status)")
        }
        return status == errSecSuccess
    }
}
