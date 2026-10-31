import Darwin
import Foundation

/// Disk primitive only. A future owner must prove a genuinely fresh installation before
/// initialization, retain the installation Keychain key, apply iOS complete protection and
/// backup exclusion before storing content, and reconcile owned snapshot files. A failed
/// operation is not proof of either a successful commit or remote cleanup.
final class ImageJournalDisk {
    enum Failure: Error, Equatable { case unavailable, invalid, stale }

    private static let name = ".image-journal"
    private static let limit = 16_384
    private let lease: ImageDirectoryLease
    private let secret: Data
    private var retired = false

    init(lease: ImageDirectoryLease, secret: Data) {
        self.lease = lease
        self.secret = secret
    }

    func load() throws -> Data {
        guard !retired else { throw Failure.unavailable }
        return try lease.withVerifiedDirectory { directory in
            let record = try Self.read(directory: directory)
            try authenticate(record.bytes)
            return record.bytes
        }
    }

    /// Only a separately proven first installation may call this. Failure leaves any created
    /// entry in place, so a partial initialization cannot be silently interpreted as fresh.
    func initializeIfProvenFresh(_ bytes: Data) throws {
        guard !retired else { throw Failure.unavailable }
        try authenticate(bytes)
        retired = true
        try lease.withVerifiedDirectory { directory in
            let fd = openat(directory, Self.name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
            guard fd >= 0 else { throw Failure.unavailable }
            defer { close(fd) }
            try Self.write(bytes, to: fd)
            guard Self.sameEntry(directory: directory, name: Self.name, fd: fd), fsync(directory) == 0 else {
                throw Failure.unavailable
            }
        }
        retired = false
    }

    /// A stale caller cannot replace a later authenticated revision. The root is an
    /// OS-provided private container serialized by the lease, not an arbitrary project path.
    func replace(expected: Data, with bytes: Data) throws {
        guard !retired else { throw Failure.unavailable }
        try authenticate(expected)
        try authenticate(bytes)
        try lease.withVerifiedDirectory { directory in
            let current = try Self.read(directory: directory)
            try authenticate(current.bytes)
            guard current.bytes == expected else { throw Failure.stale }
            retired = true
            let temporary = ".image-journal-\(UUID().uuidString.lowercased())"
            let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
            guard fd >= 0 else { throw Failure.unavailable }
            var renamed = false
            defer {
                if !renamed, Self.sameEntry(directory: directory, name: temporary, fd: fd) {
                    _ = unlinkat(directory, temporary, 0)
                    _ = fsync(directory)
                }
                close(fd)
            }
            try Self.write(bytes, to: fd)
            guard Self.sameEntry(directory: directory, name: temporary, fd: fd),
                  Self.sameIdentity(directory: directory, name: Self.name, identity: current.identity) else {
                throw Failure.unavailable
            }
            guard renameat(directory, temporary, directory, Self.name) == 0 else { throw Failure.unavailable }
            renamed = true
            guard fsync(directory) == 0, Self.sameEntry(directory: directory, name: Self.name, fd: fd) else {
                throw Failure.unavailable
            }
        }
        retired = false
    }

    private func authenticate(_ bytes: Data) throws {
        guard bytes.count <= Self.limit, secret.count == 32 else { throw Failure.invalid }
        do { _ = try ImageRecoveryLedger.restoreJournal(bytes, secret: secret) }
        catch { throw Failure.invalid }
    }

    private struct ReadResult {
        let bytes: Data
        let identity: stat
    }

    private static func read(directory: Int32) throws -> ReadResult {
        let fd = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { throw Failure.unavailable }
        defer { close(fd) }
        var initial = stat()
        guard fstat(fd, &initial) == 0, validFile(initial), initial.st_size > 0, initial.st_size <= limit else {
            throw Failure.invalid
        }
        var bytes = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if count < 0 {
                if errno == EINTR { continue }
                throw Failure.unavailable
            }
            if count == 0 { break }
            guard bytes.count + count <= limit else { throw Failure.invalid }
            bytes.append(contentsOf: buffer.prefix(count))
        }
        var final = stat()
        guard fstat(fd, &final) == 0, validFile(final), final.st_size == initial.st_size,
              bytes.count == initial.st_size, sameEntry(directory: directory, name: name, fd: fd) else {
            throw Failure.invalid
        }
        return ReadResult(bytes: bytes, identity: final)
    }

    private static func write(_ bytes: Data, to fd: Int32) throws {
        guard !bytes.isEmpty, bytes.count <= limit else { throw Failure.invalid }
        try bytes.withUnsafeBytes { buffer in
            guard let base = buffer.baseAddress else { throw Failure.invalid }
            var offset = 0
            while offset < buffer.count {
                let written = Darwin.write(fd, base.advanced(by: offset), buffer.count - offset)
                if written < 0, errno == EINTR { continue }
                guard written > 0 else { throw Failure.unavailable }
                offset += written
            }
        }
        var metadata = stat()
        guard fsync(fd) == 0, fstat(fd, &metadata) == 0, validFile(metadata), metadata.st_size == bytes.count else {
            throw Failure.unavailable
        }
    }

    private static func validFile(_ value: stat) -> Bool {
        (value.st_mode & S_IFMT) == S_IFREG && value.st_uid == geteuid() && value.st_nlink == 1 &&
            (value.st_mode & 0o7777) == 0o600
    }

    private static func sameEntry(directory: Int32, name: String, fd: Int32) -> Bool {
        var descriptor = stat()
        guard fstat(fd, &descriptor) == 0, validFile(descriptor) else { return false }
        return sameIdentity(directory: directory, name: name, identity: descriptor)
    }

    private static func sameIdentity(directory: Int32, name: String, identity: stat) -> Bool {
        var entry = stat()
        guard fstatat(directory, name, &entry, AT_SYMLINK_NOFOLLOW) == 0, validFile(entry) else { return false }
        return entry.st_dev == identity.st_dev && entry.st_ino == identity.st_ino
    }
}
