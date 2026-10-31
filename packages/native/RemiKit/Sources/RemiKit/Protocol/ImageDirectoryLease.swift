import Darwin

/// A process-shared lock on an already-open private directory. The parent must be an
/// OS-provided app-private directory opened by the future owner, not a user-selected path.
/// The owner must apply platform protection, verify before each operation, and close all
/// dependent descriptors before releasing the lease. This does not protect against an
/// arbitrary same-authority process that can tamper with the app container.
final class ImageDirectoryLease {
    enum Failure: Error, Equatable {
        case invalidDirectory
        case invalidLock
        case busy
    }

    private let directory: Int32
    private let parent: Int32
    private let rootName: String
    private let lock: Int32
    private var retired = false
    private static let lockName = ".image-lock"

    init(parent parentSource: Int32, rootName: String, directory source: Int32) throws {
        guard !rootName.isEmpty, rootName.utf8.count <= 128,
              rootName.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) ||
                                         (97...122).contains($0) || $0 == 45 || $0 == 95 }) else {
            throw Failure.invalidDirectory
        }
        var parentStat = stat()
        var root = stat()
        guard fstat(parentSource, &parentStat) == 0, Self.validDirectory(parentStat),
              fstat(source, &root) == 0, Self.validDirectory(root),
              Self.sameRoot(parent: parentSource, name: rootName, root: source) else {
            throw Failure.invalidDirectory
        }
        let parent = fcntl(parentSource, F_DUPFD_CLOEXEC, 0)
        guard parent >= 0 else { throw Failure.invalidDirectory }
        let directory = fcntl(source, F_DUPFD_CLOEXEC, 0)
        guard directory >= 0 else { close(parent); throw Failure.invalidDirectory }
        let lock = openat(directory, Self.lockName, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard lock >= 0 else { close(directory); close(parent); throw Failure.invalidLock }
        var keep = false
        defer {
            if !keep { close(lock); close(directory); close(parent) }
        }
        var file = stat()
        guard fstat(lock, &file) == 0, Self.validLock(file) else { throw Failure.invalidLock }
        if flock(lock, LOCK_EX | LOCK_NB) != 0 {
            throw errno == EWOULDBLOCK ? Failure.busy : Failure.invalidLock
        }
        guard Self.sameRoot(parent: parent, name: rootName, root: directory),
              Self.sameLock(directory: directory, lock: lock) else { throw Failure.invalidLock }
        self.parent = parent
        self.rootName = rootName
        self.directory = directory
        self.lock = lock
        keep = true
    }

    deinit {
        close(lock)
        close(directory)
        close(parent)
    }

    func verifyIdentity() throws {
        guard !retired else { throw Failure.invalidLock }
        var parentStat = stat()
        guard fstat(parent, &parentStat) == 0, Self.validDirectory(parentStat),
              Self.sameRoot(parent: parent, name: rootName, root: directory),
              Self.sameLock(directory: directory, lock: lock) else {
            retired = true
            throw Failure.invalidLock
        }
    }

    /// Synchronous descriptor-relative work only. The owner must confine this lease to a
    /// single isolation domain and must not let the descriptor escape the closure.
    func withVerifiedDirectory<T>(_ body: (Int32) throws -> T) throws -> T {
        try verifyIdentity()
        do {
            let value = try body(directory)
            try verifyIdentity()
            return value
        } catch {
            try? verifyIdentity()
            throw error
        }
    }

    private static func validDirectory(_ value: stat) -> Bool {
        (value.st_mode & S_IFMT) == S_IFDIR && value.st_uid == geteuid() && (value.st_mode & 0o7777) == 0o700
    }

    private static func sameRoot(parent: Int32, name: String, root: Int32) -> Bool {
        var descriptor = stat()
        var entry = stat()
        guard fstat(root, &descriptor) == 0, validDirectory(descriptor),
              fstatat(parent, name, &entry, AT_SYMLINK_NOFOLLOW) == 0, validDirectory(entry) else { return false }
        return descriptor.st_dev == entry.st_dev && descriptor.st_ino == entry.st_ino
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
