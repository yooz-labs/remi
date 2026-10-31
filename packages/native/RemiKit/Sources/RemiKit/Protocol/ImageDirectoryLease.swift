import Darwin

/// A process-shared lock on an already-open private directory. The future owner must open
/// the root securely, apply platform file protection, call verifyIdentity immediately before
/// each operation, and close all dependent file descriptors before releasing this lease.
final class ImageDirectoryLease {
    enum Failure: Error, Equatable {
        case invalidDirectory
        case invalidLock
        case busy
    }

    private let directory: Int32
    private let lock: Int32
    private static let lockName = ".image-lock"

    init(directory source: Int32) throws {
        var root = stat()
        guard fstat(source, &root) == 0, (root.st_mode & S_IFMT) == S_IFDIR,
              root.st_uid == geteuid(), (root.st_mode & 0o7777) == 0o700 else {
            throw Failure.invalidDirectory
        }
        let directory = fcntl(source, F_DUPFD_CLOEXEC, 0)
        guard directory >= 0 else { throw Failure.invalidDirectory }
        let lock = openat(directory, Self.lockName, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard lock >= 0 else { close(directory); throw Failure.invalidLock }
        var keep = false
        defer {
            if !keep { close(lock); close(directory) }
        }
        var file = stat()
        guard fstat(lock, &file) == 0, Self.validLock(file) else { throw Failure.invalidLock }
        if flock(lock, LOCK_EX | LOCK_NB) != 0 {
            throw errno == EWOULDBLOCK ? Failure.busy : Failure.invalidLock
        }
        guard Self.sameLock(directory: directory, lock: lock) else { throw Failure.invalidLock }
        self.directory = directory
        self.lock = lock
        keep = true
    }

    deinit {
        close(lock)
        close(directory)
    }

    func verifyIdentity() throws {
        var root = stat()
        guard fstat(directory, &root) == 0, (root.st_mode & S_IFMT) == S_IFDIR,
              root.st_uid == geteuid(), (root.st_mode & 0o7777) == 0o700,
              Self.sameLock(directory: directory, lock: lock) else { throw Failure.invalidLock }
    }

    private static func validLock(_ value: stat) -> Bool {
        (value.st_mode & S_IFMT) == S_IFREG && value.st_uid == geteuid() && value.st_nlink == 1 &&
            (value.st_mode & 0o7777) == 0o600 && value.st_size == 0
    }

    private static func sameLock(directory: Int32, lock: Int32) -> Bool {
        var descriptor = stat()
        var entry = stat()
        guard fstat(lock, &descriptor) == 0, validLock(descriptor),
              fstatat(directory, lockName, &entry, AT_SYMLINK_NOFOLLOW) == 0, validLock(entry) else { return false }
        return descriptor.st_dev == entry.st_dev && descriptor.st_ino == entry.st_ino
    }
}
