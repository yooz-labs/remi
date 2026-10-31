import Darwin
import Foundation

/// A narrow snapshot-creation step. The caller must hold the one installation lease, open
/// the selected file without following links while provider access is valid, and later verify
/// media and perform descriptor-confined cleanup. This does not authorize a network effect.
/// iOS is deliberately unavailable until complete file protection and backup exclusion are
/// implemented and verified before any snapshot bytes are written.
final class ImageSnapshotOwner {
    enum Failure: Error, Equatable { case unavailable, unsupportedProtection, invalidReservation }

    private let lease: ImageDirectoryLease
    private let journal: ImageRecoveryJournal

    init(lease: ImageDirectoryLease, journal: ImageRecoveryJournal) {
        self.lease = lease
        self.journal = journal
    }

    func capture(id: UUID, source: Int32, cancelled: () -> Bool = { false }) throws -> ImageSnapshotCopy.Result {
        #if os(iOS)
        throw Failure.unsupportedProtection
        #else
        guard !journal.retired, journal.snapshot.localSnapshotID == id,
              let record = journal.snapshot.records.first(where: { $0.id == id }),
              record.exposure == .copyReserved, record.snapshotIdentity == nil, !record.cleanupRequested else {
            throw Failure.invalidReservation
        }
        let name = "image-\(id.uuidString.lowercased())"
        return try lease.withVerifiedDirectory { directory in
            let fd = openat(directory, name, O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
            guard fd >= 0 else { throw Failure.unavailable }
            defer { close(fd) }
            var info = stat()
            guard fstat(fd, &info) == 0, Self.validFile(info), info.st_size == 0,
                  Self.sameEntry(directory: directory, name: name, descriptor: info), fsync(directory) == 0 else {
                throw Failure.unavailable
            }
            let device = UInt64(UInt32(bitPattern: info.st_dev))
            let inode = UInt64(info.st_ino)
            guard device > 0, inode > 0 else { throw Failure.unavailable }
            // Persist the new file identity before the first selected byte is written.
            try journal.registerSnapshot(id, device: device, inode: inode)
            guard Self.sameEntry(directory: directory, name: name, descriptor: info) else { throw Failure.unavailable }
            let result = try ImageSnapshotCopy.capture(source: source, destination: fd, cancelled: cancelled)
            var after = stat()
            guard fstat(fd, &after) == 0, Self.validFile(after), after.st_size == result.byteCount,
                  after.st_dev == info.st_dev, after.st_ino == info.st_ino,
                  Self.sameEntry(directory: directory, name: name, descriptor: after) else { throw Failure.unavailable }
            return result
        }
        #endif
    }

    /// Explicit local abandonment only. This never asserts remote deletion, and leaves an
    /// unknown or substituted entry untouched. The caller must serialize all use of this owner.
    func abandon(id: UUID, confirmed: Bool) throws {
        #if os(iOS)
        throw Failure.unsupportedProtection
        #else
        try journal.requestLocalAbandonment(id, confirmed: confirmed)
        guard let record = journal.snapshot.records.first(where: { $0.id == id }),
              record.cleanupRequested, record.localSnapshotPresent else { throw Failure.invalidReservation }
        let name = "image-\(id.uuidString.lowercased())"
        try lease.withVerifiedDirectory { directory in
            var entry = stat()
            if fstatat(directory, name, &entry, AT_SYMLINK_NOFOLLOW) == 0 {
                guard let identity = record.snapshotIdentity, Self.validFile(entry),
                      UInt64(UInt32(bitPattern: entry.st_dev)) == identity.device,
                      UInt64(entry.st_ino) == identity.inode else { throw Failure.unavailable }
                let fd = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
                guard fd >= 0 else { throw Failure.unavailable }
                defer { close(fd) }
                var descriptor = stat()
                guard fstat(fd, &descriptor) == 0, Self.validFile(descriptor),
                      descriptor.st_dev == entry.st_dev, descriptor.st_ino == entry.st_ino,
                      Self.sameEntry(directory: directory, name: name, descriptor: descriptor),
                      unlinkat(directory, name, 0) == 0, fsync(directory) == 0 else { throw Failure.unavailable }
                var removed = stat()
                guard fstat(fd, &removed) == 0, removed.st_nlink == 0 else { throw Failure.unavailable }
            } else {
                guard errno == ENOENT, fsync(directory) == 0 else { throw Failure.unavailable }
                if let identity = record.snapshotIdentity {
                    guard try !Self.containsOwnedInode(directory: directory, identity: identity) else {
                        throw Failure.unavailable
                    }
                }
            }
            var remaining = stat()
            guard fstatat(directory, name, &remaining, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else {
                throw Failure.unavailable
            }
            try lease.verifyIdentity()
            try journal.confirmOwnedSnapshotDeleted(id)
        }
        #endif
    }

    private static func validFile(_ value: stat) -> Bool {
        (value.st_mode & S_IFMT) == S_IFREG && value.st_uid == geteuid() && value.st_nlink == 1 &&
            (value.st_mode & 0o7777) == 0o600
    }

    /// An absent expected name is not a deletion receipt while the recorded inode still
    /// exists elsewhere in the owned root. Leave it for a separate explicit repair flow.
    private static func containsOwnedInode(directory: Int32, identity: ImageRecoveryLedger.SnapshotIdentity) throws -> Bool {
        let scanFD = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard scanFD >= 0 else { throw Failure.unavailable }
        guard let stream = fdopendir(scanFD) else { close(scanFD); throw Failure.unavailable }
        defer { closedir(stream) }
        var scanned = 0
        while true {
            errno = 0
            guard let entry = readdir(stream) else {
                if errno != 0 { throw Failure.unavailable }
                return false
            }
            scanned += 1
            guard scanned <= 256 else { throw Failure.unavailable }
            let count = Int(entry.pointee.d_namlen)
            guard count <= 1023 else { throw Failure.unavailable }
            let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: count + 1) { String(cString: $0) }
            }
            if name == "." || name == ".." { continue }
            var metadata = stat()
            guard fstatat(directory, name, &metadata, AT_SYMLINK_NOFOLLOW) == 0 else { throw Failure.unavailable }
            if UInt64(UInt32(bitPattern: metadata.st_dev)) == identity.device && UInt64(metadata.st_ino) == identity.inode {
                return true
            }
        }
    }

    private static func sameEntry(directory: Int32, name: String, descriptor: stat) -> Bool {
        var entry = stat()
        guard fstatat(directory, name, &entry, AT_SYMLINK_NOFOLLOW) == 0, validFile(entry) else { return false }
        return descriptor.st_dev == entry.st_dev && descriptor.st_ino == entry.st_ino
    }
}
