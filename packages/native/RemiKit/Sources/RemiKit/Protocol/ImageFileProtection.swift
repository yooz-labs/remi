#if os(iOS)
import Darwin
import Foundation

/// Applies iOS file attributes to an already-owned, descriptor-verified empty file. This
/// does not grant transfer authority or prove behavior while the device locks. The future
/// owner must close protected descriptors on lifecycle changes and reapply/check attributes
/// after renames. Backup exclusion is advisory, not proof that a file cannot be backed up.
enum ImageFileProtection {
    enum Failure: Error { case unavailable }

    static func prepareRoot(lease: ImageDirectoryLease, rootURL: URL) throws {
        try lease.withVerifiedDirectory { directory in
            try verifyRoot(directory, url: rootURL)
            try applyValues(rootURL)
            try verifyRoot(directory, url: rootURL)
            guard fsync(directory) == 0 else { throw Failure.unavailable }
        }
    }

    static func apply(lease: ImageDirectoryLease, rootURL: URL, name: String, descriptor: Int32) throws {
        guard allowedName(name) else { throw Failure.unavailable }
        try lease.withVerifiedDirectory { directory in
            try verifyRoot(directory, url: rootURL)
            try verifyValues(rootURL)
            try verifyFile(directory, name: name, descriptor: descriptor)
            let fileURL = rootURL.appendingPathComponent(name, isDirectory: false)
            try applyValues(fileURL)
            try verifyRoot(directory, url: rootURL)
            try verifyFile(directory, name: name, descriptor: descriptor)
            guard fsync(descriptor) == 0, fsync(directory) == 0 else { throw Failure.unavailable }
        }
    }

    private static func applyValues(_ value: URL) throws {
        do {
            var url = value
            var attributes = URLResourceValues()
            attributes.isExcludedFromBackup = true
            try (url as NSURL).setResourceValue(URLFileProtection.complete, forKey: .fileProtectionKey)
            try url.setResourceValues(attributes)
            try verifyValues(url)
        } catch { throw Failure.unavailable }
    }

    private static func verifyValues(_ value: URL) throws {
        do {
            var url = value
            url.removeAllCachedResourceValues()
            let values = try url.resourceValues(forKeys: [.fileProtectionKey, .isExcludedFromBackupKey])
            guard values.fileProtection == .complete, values.isExcludedFromBackup == true else { throw Failure.unavailable }
        } catch { throw Failure.unavailable }
    }

    private static func verifyRoot(_ directory: Int32, url: URL) throws {
        guard url.isFileURL else { throw Failure.unavailable }
        var descriptor = stat()
        var entry = stat()
        guard fstat(directory, &descriptor) == 0, lstat(url.path, &entry) == 0,
              (descriptor.st_mode & S_IFMT) == S_IFDIR, (entry.st_mode & S_IFMT) == S_IFDIR,
              descriptor.st_uid == geteuid(), entry.st_uid == geteuid(),
              (descriptor.st_mode & 0o7777) == 0o700, (entry.st_mode & 0o7777) == 0o700,
              descriptor.st_dev == entry.st_dev, descriptor.st_ino == entry.st_ino else { throw Failure.unavailable }
    }

    private static func verifyFile(_ directory: Int32, name: String, descriptor: Int32) throws {
        var opened = stat()
        var entry = stat()
        guard fstat(descriptor, &opened) == 0, fstatat(directory, name, &entry, AT_SYMLINK_NOFOLLOW) == 0,
              validFile(opened), validFile(entry), opened.st_size == 0, entry.st_size == 0,
              opened.st_dev == entry.st_dev, opened.st_ino == entry.st_ino else {
            throw Failure.unavailable
        }
    }

    private static func validFile(_ value: stat) -> Bool {
        (value.st_mode & S_IFMT) == S_IFREG && value.st_uid == geteuid() && value.st_nlink == 1 &&
            (value.st_mode & 0o7777) == 0o600
    }

    private static func allowedName(_ name: String) -> Bool {
        if WireGuards.same(name, ".image-journal") || WireGuards.same(name, ".image-installation") { return true }
        let bytes = Array(name.utf8)
        for prefix in ["image-", ".image-journal-"] {
            let prefixBytes = Array(prefix.utf8)
            guard bytes.starts(with: prefixBytes) else { continue }
            return WireGuards.isUUID4(String(decoding: bytes.dropFirst(prefixBytes.count), as: UTF8.self))
        }
        return false
    }
}
#endif
