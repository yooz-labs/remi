import CryptoKit
import Foundation
import Security

/// The separate native P256 sealing key uses CryptoKit's DER export/import.
/// Exact not-found permits creation; other read errors/corruption preserve the
/// existing item. Only this key is shared with the NSE; Ed25519 stays app-only.
final class NativePushKeyStore {
    struct Key {
        let privateKey: P256.KeyAgreement.PrivateKey
        let keyVersion: Int
        var publicKey: Data { privateKey.publicKey.x963Representation }
    }
    private let service: String
    private let account: String
    private let accessGroup: String?
    private let operations: NativeKeychainOperations
    init(service: String, account: String, accessGroup: String?, operations: NativeKeychainOperations = .system) {
        self.service = service; self.account = account; self.accessGroup = accessGroup; self.operations = operations
    }
    private struct Record: Codable {
        let version: Int
        let privateDER: Data
        let publicKey: Data
        let keyVersion: Int
    }
    private var query: [String: Any] {
        var value: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account]
        if let accessGroup { value[kSecAttrAccessGroup as String] = accessGroup }
        return value
    }
    private func read() throws -> Data? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = operations.copyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw NativeIdentityError.keychain(status) }
        guard let bytes = result as? Data else { throw NativePushStateError.corrupt }
        return bytes
    }
    func load() throws -> Key? {
        guard let data = try read() else { return nil }
        guard data.count <= 4096,
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              Set(object.keys) == Set(["version", "privateDER", "publicKey", "keyVersion"]),
              let record = try? JSONDecoder().decode(Record.self, from: data),
              record.version == 1, record.keyVersion >= 1,
              record.privateDER.count <= 512, record.publicKey.count == 65 else {
            throw NativePushStateError.corrupt
        }
        let key: P256.KeyAgreement.PrivateKey
        do {
            key = try P256.KeyAgreement.PrivateKey(derRepresentation: record.privateDER)
            _ = try P256.KeyAgreement.PublicKey(x963Representation: record.publicKey)
        } catch { throw NativePushStateError.corrupt }
        guard key.derRepresentation == record.privateDER,
              key.publicKey.x963Representation == record.publicKey else { throw NativePushStateError.corrupt }
        return Key(privateKey: key, keyVersion: record.keyVersion)
    }
    func loadOrCreate() throws -> Key {
        if let existing = try load() { return existing }
        let key = P256.KeyAgreement.PrivateKey()
        let data = try JSONEncoder().encode(Record(version: 1, privateDER: key.derRepresentation,
                                                   publicKey: key.publicKey.x963Representation, keyVersion: 1))
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = operations.add(attributes as CFDictionary, nil)
        if status == errSecDuplicateItem {
            guard let winner = try load() else { throw NativePushStateError.changed }
            return winner
        }
        guard status == errSecSuccess else { throw NativeIdentityError.keychain(status) }
        guard try read() == data, let verified = try load(),
              verified.publicKey == key.publicKey.x963Representation else { throw NativePushStateError.changed }
        return verified
    }
}
