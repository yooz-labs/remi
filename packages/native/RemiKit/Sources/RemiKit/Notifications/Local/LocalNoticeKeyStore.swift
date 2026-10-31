import Foundation
import Security
import RemiPush

enum LocalNoticeKeyError: Error, Equatable { case locked, missing, corrupt, unavailable, changed }

/// Separate device-only local-notification key. A read failure never rotates an existing key (#1720).
struct LocalNoticeKeyStore: Sendable {
    private let service: String
    private let account: String

    init(service: String = "live.yooz.remi.local-notification-journal", account: String = "hmac-v1") {
        self.service = service; self.account = account
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false]
    }

    /// Missing and locked are intentionally different: neither implies permission to create a key.
    func load(operations: NativeKeychainOperations = .system) throws -> Data {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        let result = operations.copyMatching(request as CFDictionary, &found)
        if result == errSecItemNotFound { throw LocalNoticeKeyError.missing }
        if result == errSecInteractionNotAllowed { throw LocalNoticeKeyError.locked }
        guard result == errSecSuccess else { throw LocalNoticeKeyError.unavailable }
        guard let data = found as? Data, data.count == 32 else { throw LocalNoticeKeyError.corrupt }
        return data
    }

    /// The caller must first prove a fresh install or obtain an explicit local-history reset.
    /// A duplicate means another writer won; never overwrite or silently rotate it.
    func createAfterFreshInstallOrConfirmedReset(operations: NativeKeychainOperations = .system) throws -> Data {
        var bytes = Data(count: 32)
        let random = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard random == errSecSuccess else { throw LocalNoticeKeyError.unavailable }
        var request = query
        request[kSecValueData as String] = bytes
        request[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let result = operations.add(request as CFDictionary, nil)
        if result == errSecDuplicateItem { throw LocalNoticeKeyError.changed }
        if result == errSecInteractionNotAllowed { throw LocalNoticeKeyError.locked }
        guard result == errSecSuccess else { throw LocalNoticeKeyError.unavailable }
        return bytes
    }
}
