import CryptoKit
import Foundation
import Security
@testable import RemiKit

/// One test-only push key record and one identity record in the shapes that
/// `NativePushKeyStore` and `NativeIdentityRecordStore` read (#1768), with fresh
/// keys per instance. Items are written the way the stores write theirs:
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, no access control.
struct KeychainRecordFixtures: Sendable {
    let pushPublicKey: Data
    let pushRecord: Data
    let identityPublicKey: Data
    let identityRecord: Data

    init() throws {
        struct PushRecord: Encodable { let version: Int; let privateDER: Data; let publicKey: Data; let keyVersion: Int }
        struct IdentityRecord: Encodable {
            let version: Int; let pkcs8: Data; let publicKey: Data; let revision: String; let requiresAppUnlock: Bool
        }
        let key = P256.KeyAgreement.PrivateKey()
        pushPublicKey = key.publicKey.x963Representation
        pushRecord = try JSONEncoder().encode(PushRecord(version: 1, privateDER: key.derRepresentation,
            publicKey: pushPublicKey, keyVersion: 3))
        let identity = ClientIdentity()
        identityPublicKey = identity.publicKeyRaw
        identityRecord = try JSONEncoder().encode(IdentityRecord(version: 2,
            pkcs8: Ed25519PKCS8.encode(identity.privateKey), publicKey: identityPublicKey,
            revision: UUID().uuidString, requiresAppUnlock: false))
    }

    static func query(service: String, account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    /// Adds one generic-password item; the caller deletes it.
    static func add(_ data: Data, service: String, account: String) -> OSStatus {
        var item = query(service: service, account: account)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil)
    }

    static func delete(service: String, account: String) {
        SecItemDelete(query(service: service, account: account) as CFDictionary)
    }
}
