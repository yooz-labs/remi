import CryptoKit
import Foundation
import Security

/// #1200 A scaffolding for the separate native P256 sealing key. Construction
/// does no I/O; loading remains fail-closed until durable Keychain behavior pins.
/// Only this key will be shared with the NSE. The Ed25519 seed is app-only.
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
    func loadOrCreate() throws -> Key { throw NativePushStateError.unavailable }
    func load() throws -> Key? { throw NativePushStateError.unavailable }
}
