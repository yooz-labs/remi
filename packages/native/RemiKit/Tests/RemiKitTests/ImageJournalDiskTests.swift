import Darwin
import Foundation
import Testing
@testable import RemiKit

@Suite struct ImageJournalDiskTests {
    private let secret = Data(repeating: 0x41, count: 32)

    private func withStore(_ body: (URL, ImageJournalDisk) throws -> Void) throws {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent("remi-journal-parent-\(UUID().uuidString)")
        let root = parent.appendingPathComponent("images")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: parent) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let parentFD = open(parent.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        let rootFD = open(root.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard parentFD >= 0, rootFD >= 0 else { throw POSIXError(.EIO) }
        defer { close(parentFD); close(rootFD) }
        let lease = try ImageDirectoryLease(parent: parentFD, rootName: "images", directory: rootFD)
        try body(root, ImageJournalDisk(lease: lease, secret: secret))
    }

    @Test func atomicReplacementRejectsStaleRevision() throws {
        try withStore { _, disk in
            var ledger = ImageRecoveryLedger()
            let original = try ledger.encodeJournal(secret: secret)
            try disk.initializeIfProvenFresh(original)
            #expect(try disk.load() == original)
            _ = try ledger.reserveCopy()
            let changed = try ledger.encodeJournal(secret: secret)
            try disk.replace(expected: original, with: changed)
            #expect(try disk.load() == changed)
            #expect(throws: ImageJournalDisk.Failure.stale) { try disk.replace(expected: original, with: original) }
            #expect(try disk.load() == changed)
        }
    }

    @Test func existingOrCorruptJournalIsNeverOverwrittenOrReinitialized() throws {
        try withStore { root, disk in
            let valid = try ImageRecoveryLedger().encodeJournal(secret: secret)
            try disk.initializeIfProvenFresh(valid)
            #expect(throws: (any Error).self) { try disk.initializeIfProvenFresh(valid) }
            let journal = root.appendingPathComponent(".image-journal")
            try Data("corrupt".utf8).write(to: journal)
            #expect(throws: (any Error).self) { try disk.load() }
            #expect(throws: (any Error).self) { try disk.replace(expected: valid, with: valid) }
            #expect(throws: (any Error).self) { try disk.initializeIfProvenFresh(valid) }
            #expect(try Data(contentsOf: journal) == Data("corrupt".utf8))
        }
    }

    @Test func foreignSymlinkAndHardlinkEntriesArePreserved() throws {
        try withStore { root, disk in
            let target = root.appendingPathComponent("unrelated")
            let journal = root.appendingPathComponent(".image-journal")
            let marker = Data([1, 2, 3])
            try marker.write(to: target)
            let valid = try ImageRecoveryLedger().encodeJournal(secret: secret)
            #expect(symlink(target.path, journal.path) == 0)
            #expect(throws: (any Error).self) { try disk.load() }
            #expect(throws: (any Error).self) { try disk.initializeIfProvenFresh(valid) }
            #expect(unlink(journal.path) == 0)
            #expect(link(target.path, journal.path) == 0)
            #expect(throws: (any Error).self) { try disk.load() }
            #expect(throws: (any Error).self) { try disk.initializeIfProvenFresh(valid) }
            #expect(try Data(contentsOf: target) == marker)
        }
    }
}
