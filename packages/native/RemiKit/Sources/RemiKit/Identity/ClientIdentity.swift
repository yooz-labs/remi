import CryptoKit
import Foundation
import Security

/// Remi's persistent Ed25519 client identity.
///
/// Wire values are raw bytes encoded as base64. Challenges are decoded from base64 before
/// signing. The private key never leaves the Keychain-backed value held by this type.
public struct ClientIdentity: Sendable {
    private let privateKey: Curve25519.Signing.PrivateKey

    public init() {
        privateKey = Curve25519.Signing.PrivateKey()
    }

    init(rawPrivateKey: Data) throws {
        privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: rawPrivateKey)
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
        try privateKey.signature(for: challenge)
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

public enum ClientIdentityStoreError: Error, Equatable {
    case keychainRead(OSStatus)
    case keychainWrite(OSStatus)
}

/// Persists one device identity in the app's default Keychain access group.
/// No key-sharing entitlement is required or used.
public struct ClientIdentityStore: Sendable {
    public static let shared = ClientIdentityStore(
        service: "live.yooz.remi.client-identity",
        account: "ed25519-private-key"
    )

    private let service: String
    private let account: String

    public init(service: String, account: String) {
        self.service = service
        self.account = account
    }

    public func loadOrCreate() throws -> ClientIdentity {
        switch read() {
        case .success(let data):
            if let data, let identity = try? ClientIdentity(rawPrivateKey: data) {
                return identity
            }
        case .failure(let error):
            throw error
        }

        let identity = ClientIdentity()
        try replace(with: identity.rawPrivateKey)
        return identity
    }

    private func query() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private func read() -> Result<Data?, ClientIdentityStoreError> {
        var attributes = query()
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(attributes as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            return .success(result as? Data)
        case errSecItemNotFound:
            return .success(nil)
        default:
            return .failure(.keychainRead(status))
        }
    }

    private func replace(with data: Data) throws {
        let deleteStatus = SecItemDelete(query() as CFDictionary)
        guard deleteStatus == errSecSuccess || deleteStatus == errSecItemNotFound else {
            throw ClientIdentityStoreError.keychainWrite(deleteStatus)
        }

        var attributes = query()
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(attributes as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw ClientIdentityStoreError.keychainWrite(addStatus)
        }
    }
}
