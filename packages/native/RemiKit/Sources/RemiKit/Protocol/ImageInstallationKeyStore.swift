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

    fileprivate func holds(_ candidate: ImageDirectoryLease) -> Bool { lease === candidate }

    /// Only the composed owner in this file can promote after validating the marker and journal.
    fileprivate func promotePending(_ expected: Record) throws -> Record {
        guard expected.phase == .pending, let current = try load(), current == expected else {
            throw Failure.malformed
        }
        let ready = Record(phase: .ready, installation: expected.installation, secret: expected.secret)
        var request = query
        let context = LAContext()
        context.interactionNotAllowed = true
        request[kSecUseAuthenticationContext as String] = context
        let status = operations.update(request as CFDictionary, [kSecValueData as String: Self.encode(ready)] as CFDictionary)
        guard status == errSecSuccess else { throw Failure.unavailable(status) }
        guard try load() == ready else { throw Failure.malformed }
        return ready
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

/// Composes the installation witness, private marker and authenticated journal. This is not
/// a transfer controller: it grants no socket authority and does not choose or validate media.
/// The caller must supply the OS-provided private parent and serialize all access to the lease.
final class ImageInstallationOwner {
    enum Failure: Error, Equatable { case protectionUnavailable, recoveryRequired }

    let journal: ImageRecoveryJournal
    let snapshots: ImageSnapshotOwner

    private init(journal: ImageRecoveryJournal, snapshots: ImageSnapshotOwner) {
        self.journal = journal
        self.snapshots = snapshots
    }

    static func open(lease: ImageDirectoryLease, keys: ImageInstallationKeyStore) throws -> ImageInstallationOwner {
        #if os(iOS)
        throw Failure.protectionUnavailable
        #else
        guard keys.holds(lease) else { throw Failure.recoveryRequired }
        return try lease.withVerifiedDirectory { directory in
            var key = try keys.load() ?? keys.beginPending()
            if key.phase == .pending {
                try inventory(directory: directory, expected: nil, pending: true)
                if try exists(directory, name: markerName) {
                    try verifyMarker(directory, installation: key.installation)
                } else {
                    try createMarker(directory, installation: key.installation)
                }
            } else {
                try verifyMarker(directory, installation: key.installation)
            }
            let disk = ImageJournalDisk(lease: lease, secret: key.secret)
            if try !exists(directory, name: journalName) {
                guard key.phase == .pending else { throw Failure.recoveryRequired }
                try disk.initializeIfProvenFresh(ImageRecoveryLedger().encodeJournal(secret: key.secret))
            }
            let bytes = try disk.load()
            let restored = try ImageRecoveryLedger.restoreJournal(bytes, secret: key.secret)
            if key.phase == .pending {
                guard restored.ledger.records.isEmpty, restored.ledger.localSnapshotID == nil,
                      !restored.ledger.hasAggregateUnconfirmedCleanup, !restored.needsRewrite else {
                    throw Failure.recoveryRequired
                }
                try inventory(directory: directory, expected: nil, pending: true)
                try verifyMarker(directory, installation: key.installation)
                key = try keys.promotePending(key)
            } else {
                let expected = restored.ledger.localSnapshotID.flatMap { id in
                    restored.ledger.records.first { $0.id == id }
                }
                try inventory(directory: directory, expected: expected, pending: false)
            }
            guard key.phase == .ready else { throw Failure.recoveryRequired }
            let journal = try ImageRecoveryJournal(disk: disk, secret: key.secret)
            return ImageInstallationOwner(journal: journal, snapshots: ImageSnapshotOwner(lease: lease, journal: journal))
        }
        #endif
    }

    private static let markerName = ".image-installation"
    private static let journalName = ".image-journal"

    private static func marker(_ installation: String) -> Data {
        Data("remi-image-installation-v1:\(installation)\n".utf8)
    }

    private static func exists(_ directory: Int32, name: String) throws -> Bool {
        var entry = stat()
        if fstatat(directory, name, &entry, AT_SYMLINK_NOFOLLOW) == 0 { return true }
        guard errno == ENOENT else { throw Failure.recoveryRequired }
        return false
    }

    private static func createMarker(_ directory: Int32, installation: String) throws {
        let fd = openat(directory, markerName, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw Failure.recoveryRequired }
        defer { close(fd) }
        let bytes = marker(installation)
        try bytes.withUnsafeBytes { buffer in
            guard let base = buffer.baseAddress else { throw Failure.recoveryRequired }
            var offset = 0
            while offset < buffer.count {
                let written = Darwin.write(fd, base.advanced(by: offset), buffer.count - offset)
                if written < 0, errno == EINTR { continue }
                guard written > 0 else { throw Failure.recoveryRequired }
                offset += written
            }
        }
        var info = stat()
        guard fsync(fd) == 0, fstat(fd, &info) == 0, validFile(info), info.st_size == bytes.count,
              sameEntry(directory, name: markerName, info: info), fsync(directory) == 0 else {
            throw Failure.recoveryRequired
        }
    }

    private static func verifyMarker(_ directory: Int32, installation: String) throws {
        let fd = openat(directory, markerName, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { throw Failure.recoveryRequired }
        defer { close(fd) }
        let expected = marker(installation)
        var info = stat()
        guard fstat(fd, &info) == 0, validFile(info), info.st_size == expected.count,
              sameEntry(directory, name: markerName, info: info) else { throw Failure.recoveryRequired }
        var result = [UInt8](repeating: 0, count: expected.count)
        var offset = 0
        while offset < result.count {
            let count = result.withUnsafeMutableBytes { buffer in
                guard let base = buffer.baseAddress else { return -1 }
                return Darwin.read(fd, base.advanced(by: offset), buffer.count - offset)
            }
            if count < 0, errno == EINTR { continue }
            guard count > 0 else { throw Failure.recoveryRequired }
            offset += count
        }
        guard Data(result) == expected, sameEntry(directory, name: markerName, info: info) else {
            throw Failure.recoveryRequired
        }
    }

    private static func validFile(_ value: stat) -> Bool {
        (value.st_mode & S_IFMT) == S_IFREG && value.st_uid == geteuid() && value.st_nlink == 1 &&
            (value.st_mode & 0o7777) == 0o600
    }

    private static func sameEntry(_ directory: Int32, name: String, info: stat) -> Bool {
        var entry = stat()
        guard fstatat(directory, name, &entry, AT_SYMLINK_NOFOLLOW) == 0, validFile(entry) else { return false }
        return entry.st_dev == info.st_dev && entry.st_ino == info.st_ino && entry.st_size == info.st_size
    }

    /// Preserve every unknown entry. A registered snapshot is adopted only by exact inode;
    /// an absent expected file is recoverable only if deletion intent was already durable.
    private static func inventory(directory: Int32, expected: ImageRecoveryLedger.Record?, pending: Bool) throws {
        let fd = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { throw Failure.recoveryRequired }
        guard let stream = fdopendir(fd) else { close(fd); throw Failure.recoveryRequired }
        defer { closedir(stream) }
        let snapshotName = expected.map { "image-\($0.id.uuidString.lowercased())" }
        var seenSnapshot = false
        var scanned = 0
        while true {
            errno = 0
            guard let entry = readdir(stream) else {
                if errno != 0 { throw Failure.recoveryRequired }
                break
            }
            scanned += 1
            guard scanned <= 256 else { throw Failure.recoveryRequired }
            let count = Int(entry.pointee.d_namlen)
            guard count <= 1023 else { throw Failure.recoveryRequired }
            let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: count + 1) { String(cString: $0) }
            }
            if [".", "..", ".image-lock", markerName, journalName].contains(where: { WireGuards.same(name, $0) }) { continue }
            guard !pending, let expected, let snapshotName, WireGuards.same(name, snapshotName),
                  let identity = expected.snapshotIdentity else { throw Failure.recoveryRequired }
            var info = stat()
            guard fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) == 0, validFile(info),
                  UInt64(UInt32(bitPattern: info.st_dev)) == identity.device, UInt64(info.st_ino) == identity.inode else {
                throw Failure.recoveryRequired
            }
            seenSnapshot = true
        }
        if let expected, expected.snapshotIdentity != nil, !seenSnapshot, !expected.cleanupRequested {
            throw Failure.recoveryRequired
        }
    }
}
