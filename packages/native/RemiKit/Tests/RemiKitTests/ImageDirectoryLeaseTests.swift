import Darwin
import Foundation
import Testing
@testable import RemiKit

@Suite struct ImageDirectoryLeaseTests {
    private func withDirectory(_ body: (URL, Int32, Int32) throws -> Void) throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("remi-image-lease-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: url) }
        let descriptor = open(url.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw POSIXError(.EIO) }
        defer { close(descriptor) }
        let parent = open(url.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard parent >= 0 else { throw POSIXError(.EIO) }
        defer { close(parent) }
        try body(url, parent, descriptor)
    }

    @Test func lockIsExclusiveAcrossProcessesAndReleasesOnClose() throws {
        try withDirectory { url, parent, directory in
            var lease: ImageDirectoryLease? = try ImageDirectoryLease(parent: parent, rootName: url.lastPathComponent, directory: directory)
            #expect(lease != nil)
            let lockPath = url.appendingPathComponent(".image-lock").path
            func childAcquiresLock() throws -> Bool {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
                process.arguments = ["-MFcntl=:flock", "-e", "open(my $f, '+<', $ARGV[0]) or exit 2; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 1)", lockPath]
                try process.run()
                process.waitUntilExit()
                guard process.terminationReason == .exit, [0, 1].contains(process.terminationStatus) else { throw POSIXError(.EIO) }
                return process.terminationStatus == 0
            }
            #expect(try !childAcquiresLock())
            lease = nil
            #expect(try childAcquiresLock())
        }
    }

    @Test func refusesSymlinkOrHardlinkLockWithoutAlteringIt() throws {
        try withDirectory { url, parent, directory in
            let target = url.appendingPathComponent("unrelated")
            let lock = url.appendingPathComponent(".image-lock")
            try Data([1, 2, 3]).write(to: target)
            #expect(symlink(target.path, lock.path) == 0)
            #expect(throws: (any Error).self) { try ImageDirectoryLease(parent: parent, rootName: url.lastPathComponent, directory: directory) }
            #expect(try Data(contentsOf: target) == Data([1, 2, 3]))
            #expect(unlink(lock.path) == 0)
            #expect(link(target.path, lock.path) == 0)
            #expect(throws: (any Error).self) { try ImageDirectoryLease(parent: parent, rootName: url.lastPathComponent, directory: directory) }
            #expect(try Data(contentsOf: target) == Data([1, 2, 3]))
        }
    }

    @Test func refusesNonPrivateRoot() throws {
        try withDirectory { url, parent, directory in
            #expect(fchmod(directory, 0o755) == 0)
            #expect(throws: (any Error).self) { try ImageDirectoryLease(parent: parent, rootName: url.lastPathComponent, directory: directory) }
        }
    }

    @Test func replacedLockNameInvalidatesTheLease() throws {
        try withDirectory { url, parent, directory in
            let lease = try ImageDirectoryLease(parent: parent, rootName: url.lastPathComponent, directory: directory)
            let name = url.appendingPathComponent(".image-lock")
            let saved = url.appendingPathComponent("saved-lock")
            #expect(rename(name.path, saved.path) == 0)
            let replacement = open(name.path, O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
            #expect(replacement >= 0)
            if replacement >= 0 { close(replacement) }
            #expect(throws: (any Error).self) { try lease.verifyIdentity() }
            #expect(unlink(name.path) == 0)
            #expect(rename(saved.path, name.path) == 0)
            #expect(throws: (any Error).self) { try lease.verifyIdentity() }
        }
    }

    @Test func replacedRootDirectoryInvalidatesTheLease() throws {
        try withDirectory { url, parent, directory in
            let lease = try ImageDirectoryLease(parent: parent, rootName: url.lastPathComponent, directory: directory)
            let saved = url.deletingLastPathComponent().appendingPathComponent("saved-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: saved) }
            #expect(rename(url.path, saved.path) == 0)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
            #expect(throws: (any Error).self) { try lease.verifyIdentity() }
        }
    }
}
