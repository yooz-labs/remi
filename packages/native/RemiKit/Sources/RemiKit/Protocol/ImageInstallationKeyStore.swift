import CryptoKit
import Darwin
import Foundation
import LocalAuthentication
import Security
import RemiPush

/// Installation witness for the image recovery journal. A pending key alone grants no
/// authority. The future composed owner must bind a protected marker and an authenticated,
/// empty journal to the same installation before promoting it or admitting any effect.
/// A missing item means fresh only when the verified private root is also empty.
final class ImageInstallationKeyStore {
    static let defaultService = "live.yooz.remi.image-recovery"
    static let defaultAccount = "installation-v1"
    enum Failure: Error, Equatable {
        case alreadyExists
        case notFresh
        case malformed
        case unavailable(OSStatus)
    }

    struct Record: Sendable, Equatable {
        enum Phase: Sendable, Equatable { case pending, ready }
        let phase: Phase
        let installation: String
        let secret: Data
    }

    private let lease: ImageDirectoryLease
    private let service: String
    private let account: String
    private let accessGroup: String
    private let operations: NativeKeychainOperations

    init(lease: ImageDirectoryLease, accessGroup: String, service: String = defaultService, account: String = defaultAccount,
         operations: NativeKeychainOperations = .system) {
        self.lease = lease
        self.accessGroup = accessGroup
        self.service = service
        self.account = account
        self.operations = operations
    }

    /// A locked or unavailable Keychain is not an absent key and never triggers creation.
    func load() throws -> Record? {
        var request = query
        let context = LAContext()
        context.interactionNotAllowed = true
        request[kSecUseAuthenticationContext as String] = context
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = operations.copyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure.unavailable(status) }
        guard let data = result as? Data else { throw Failure.malformed }
        return try Self.decode(data)
    }

    /// The lease and an actual bounded empty-root inventory establish the precondition;
    /// a caller-provided freshness flag cannot authorize key creation.
    func beginPending() throws -> Record {
        #if os(iOS)
        // iOS storage cannot be initialized until complete protection and lifecycle are proven.
        throw Failure.unavailable(errSecNotAvailable)
        #else
        return try lease.withVerifiedDirectory { directory in
            try Self.requireEmptyRoot(directory)
            guard try load() == nil else { throw Failure.alreadyExists }
            let key = SymmetricKey(size: .bits256)
            let record = Record(phase: .pending, installation: UUID().uuidString.lowercased(),
                                secret: key.withUnsafeBytes { Data($0) })
            var item = query
            item[kSecValueData as String] = Self.encode(record)
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let status = operations.add(item as CFDictionary, nil)
            if status == errSecDuplicateItem { throw Failure.alreadyExists }
            guard status == errSecSuccess else { throw Failure.unavailable(status) }
            return record
        }
        #endif
    }

    private var query: [String: Any] {
        var value: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: account, kSecAttrAccessGroup as String: accessGroup]
        #if os(macOS)
        value[kSecUseDataProtectionKeychain as String] = true
        #endif
        return value
    }

    private static func encode(_ record: Record) -> Data {
        let fields: [(String, WireJSON)] = [
            ("version", .number(1)), ("phase", .string(record.phase == .pending ? "pending" : "ready")),
            ("installation", .string(record.installation)), ("key", .string(WireGuards.encodeBase64URL(record.secret))),
        ]
        let object = WireObject(members: fields.map { .init(key: $0.0, value: $0.1) })
        return Data(WireJSON.object(object).serialized().utf8)
    }

    private static func decode(_ data: Data) throws -> Record {
        do {
            let fields = try WireFields(WireJSON.parse(data, maxBytes: 512, maxNodes: 16),
                                        keys: ["version", "phase", "installation", "key"])
            _ = try fields.integer("version", in: 1...1)
            let text = try fields.string("phase")
            let phase: Record.Phase
            if WireGuards.same(text, "pending") { phase = .pending }
            else if WireGuards.same(text, "ready") { phase = .ready }
            else { throw Failure.malformed }
            let installation = try fields.uuid4("installation")
            guard let secret = WireGuards.decodeBase64URL(try fields.encoded("key", bytes: 32...32)) else {
                throw Failure.malformed
            }
            return Record(phase: phase, installation: installation, secret: secret)
        } catch { throw Failure.malformed }
    }

    /// The root is a dedicated, verified app-private directory under the held process lease.
    /// Unknown entries are never removed or treated as proof of a fresh installation.
    private static func requireEmptyRoot(_ directory: Int32) throws {
        let fd = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { throw Failure.notFresh }
        guard let stream = fdopendir(fd) else { close(fd); throw Failure.notFresh }
        defer { closedir(stream) }
        var count = 0
        while true {
            errno = 0
            guard let entry = readdir(stream) else {
                if errno != 0 { throw Failure.notFresh }
                return
            }
            count += 1
            guard count <= 256 else { throw Failure.notFresh }
            let length = Int(entry.pointee.d_namlen)
            guard length <= 1023 else { throw Failure.notFresh }
            let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: length + 1) { String(cString: $0) }
            }
            guard WireGuards.same(name, ".") || WireGuards.same(name, "..") ||
                    WireGuards.same(name, ".image-lock") else { throw Failure.notFresh }
        }
    }
}
