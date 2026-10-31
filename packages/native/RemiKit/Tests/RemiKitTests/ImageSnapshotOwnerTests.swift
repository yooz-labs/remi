import CryptoKit
import Darwin
import Foundation
import Testing
@testable import RemiKit

/// Real synthetic files only. iOS data protection, provider lifetimes and the full cleanup
/// owner are separate gates; these tests do not authorize an image transport.
@Suite struct ImageSnapshotOwnerTests {
    private let secret = Data(repeating: 0x41, count: 32)

    private func withFixture(_ bytes: Data, body: (URL, URL, Int32, ImageRecoveryJournal, ImageSnapshotOwner) throws -> Void) throws {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent("remi-image-owner-\(UUID().uuidString)")
        let root = parent.appendingPathComponent("images")
        let input = parent.appendingPathComponent("selected")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: parent) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try bytes.write(to: input)
        let parentFD = open(parent.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        let rootFD = open(root.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        let source = open(input.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard parentFD >= 0, rootFD >= 0, source >= 0 else { throw POSIXError(.EIO) }
        defer { close(parentFD); close(rootFD); close(source) }
        let lease = try ImageDirectoryLease(parent: parentFD, rootName: "images", directory: rootFD)
        let disk = ImageJournalDisk(lease: lease, secret: secret)
        try disk.initializeIfProvenFresh(ImageRecoveryLedger().encodeJournal(secret: secret))
        let journal = try ImageRecoveryJournal(disk: disk, secret: secret)
        let owner = ImageSnapshotOwner(lease: lease, journal: journal)
        try body(root, input, source, journal, owner)
    }

    @Test func captureRegistersActualDescriptorBeforeBoundedCopy() throws {
        let bytes = Data(repeating: 0x5a, count: 75_000)
        try withFixture(bytes) { root, input, source, journal, owner in
            let id = try journal.reserveCopy()
            let result = try owner.capture(id: id, source: source)
            let snapshot = root.appendingPathComponent("image-\(id.uuidString.lowercased())")
            let attrs = try FileManager.default.attributesOfItem(atPath: snapshot.path)
            let inode = try #require((attrs[.systemFileNumber] as? NSNumber)?.uint64Value)
            #expect(journal.snapshot.records.first?.snapshotIdentity?.inode == inode)
            #expect(result.byteCount == bytes.count)
            #expect(result.digest == Data(SHA256.hash(data: bytes)))
            #expect(try Data(contentsOf: snapshot) == bytes)
            #expect(try Data(contentsOf: input) == bytes)
        }
    }

    @Test func existingSymlinkIsPreservedAndNeverRegistered() throws {
        try withFixture(Data([4, 5, 6])) { root, input, source, journal, owner in
            let id = try journal.reserveCopy()
            let snapshot = root.appendingPathComponent("image-\(id.uuidString.lowercased())")
            #expect(symlink(input.path, snapshot.path) == 0)
            #expect(throws: (any Error).self) { try owner.capture(id: id, source: source) }
            #expect(journal.snapshot.records.first?.snapshotIdentity == nil)
            #expect(try Data(contentsOf: input) == Data([4, 5, 6]))
            var metadata = stat()
            #expect(lstat(snapshot.path, &metadata) == 0 && (metadata.st_mode & S_IFMT) == S_IFLNK)
        }
    }

    @Test func interruptedCopyLeavesRegisteredPartialForLaterOwnedCleanup() throws {
        try withFixture(Data(repeating: 7, count: 100_000)) { root, _, source, journal, owner in
            let id = try journal.reserveCopy()
            var checks = 0
            #expect(throws: ImageSnapshotCopy.Failure.cancelled) {
                try owner.capture(id: id, source: source) {
                    checks += 1
                    return checks > 1
                }
            }
            let snapshot = root.appendingPathComponent("image-\(id.uuidString.lowercased())")
            #expect(FileManager.default.fileExists(atPath: snapshot.path))
            #expect(journal.snapshot.records.first?.snapshotIdentity != nil)
            #expect(journal.snapshot.localSnapshotID == id)
        }
    }
}
