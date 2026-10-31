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

    @Test func unprovenCrashLeftoversBlockUseAndAreNotRemoved() throws {
        try withStore { root, disk in
            let valid = try ImageRecoveryLedger().encodeJournal(secret: secret)
            try disk.initializeIfProvenFresh(valid)
            let leftover = root.appendingPathComponent(".image-journal-unknown")
            let marker = Data([9, 8, 7])
            try marker.write(to: leftover)
            #expect(throws: (any Error).self) { try disk.load() }
            #expect(throws: (any Error).self) { try disk.replace(expected: valid, with: valid) }
            #expect(try Data(contentsOf: leftover) == marker)
        }
        try withStore { root, disk in
            let leftover = root.appendingPathComponent(".image-journal-unknown")
            try Data([1]).write(to: leftover)
            let valid = try ImageRecoveryLedger().encodeJournal(secret: secret)
            #expect(throws: (any Error).self) { try disk.initializeIfProvenFresh(valid) }
            #expect(FileManager.default.fileExists(atPath: leftover.path))
        }
    }

    @Test func observedCorruptionRetiresThisJournalOwner() throws {
        try withStore { root, disk in
            let valid = try ImageRecoveryLedger().encodeJournal(secret: secret)
            try disk.initializeIfProvenFresh(valid)
            let journal = root.appendingPathComponent(".image-journal")
            try Data("corrupt".utf8).write(to: journal)
            #expect(throws: (any Error).self) { try disk.load() }
            try valid.write(to: journal)
            #expect(throws: (any Error).self) { try disk.load() }
            #expect(throws: (any Error).self) { try disk.replace(expected: valid, with: valid) }
        }
        try withStore { root, disk in
            let valid = try ImageRecoveryLedger().encodeJournal(secret: secret)
            try disk.initializeIfProvenFresh(valid)
            let journal = root.appendingPathComponent(".image-journal")
            try Data("corrupt".utf8).write(to: journal)
            #expect(throws: (any Error).self) { try disk.replace(expected: valid, with: valid) }
            try valid.write(to: journal)
            #expect(throws: (any Error).self) { try disk.load() }
        }
    }

    @Test func journalOwnerPersistsReservationAndRetiresInterruptedCopy() throws {
        try withStore { _, disk in
            try disk.initializeIfProvenFresh(ImageRecoveryLedger().encodeJournal(secret: secret))
            let owner = try ImageRecoveryJournal(disk: disk, secret: secret)
            let id = try owner.reserveCopy()
            let onDisk = try ImageRecoveryLedger.restoreJournal(disk.load(), secret: secret)
            #expect(onDisk.needsRewrite)
            #expect(onDisk.ledger.localSnapshotID == id)
            let reopened = try ImageRecoveryJournal(disk: disk, secret: secret)
            #expect(reopened.snapshot.localSnapshotID == id)
            let rewritten = try ImageRecoveryLedger.restoreJournal(disk.load(), secret: secret)
            #expect(!rewritten.needsRewrite)
            let identity = try ImageRecoveryFingerprint.make(secret: secret, machineKey: Data(repeating: 0x42, count: 32),
                sessionID: "00112233-4455-4677-8899-aabbccddeeff",
                binding: AttachedBinding(harness: .claude, harnessSessionId: "owned-thread"),
                imageDigest: Data(repeating: 0x52, count: 32))
            #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) { try reopened.finishCopy(id, fingerprint: identity) }
            #expect(throws: (any Error).self) { try owner.finishCopy(id, fingerprint: identity) }
            #expect(throws: (any Error).self) { try owner.finishCopy(id, fingerprint: identity) }
        }
    }

    @Test func failedDurableTransitionRetiresJournalOwner() throws {
        try withStore { root, disk in
            let initial = try ImageRecoveryLedger().encodeJournal(secret: secret)
            try disk.initializeIfProvenFresh(initial)
            let owner = try ImageRecoveryJournal(disk: disk, secret: secret)
            let journal = root.appendingPathComponent(".image-journal")
            try Data("corrupt".utf8).write(to: journal)
            #expect(throws: (any Error).self) { try owner.reserveCopy() }
            try initial.write(to: journal)
            #expect(throws: (any Error).self) { try owner.reserveCopy() }
            #expect(owner.snapshot.records.isEmpty)
        }
    }

    @Test func snapshotDescriptorIdentityMustBePersistedBeforeCopyFinalization() throws {
        try withStore { _, disk in
            try disk.initializeIfProvenFresh(ImageRecoveryLedger().encodeJournal(secret: secret))
            let owner = try ImageRecoveryJournal(disk: disk, secret: secret)
            let id = try owner.reserveCopy()
            let fingerprint = try ImageRecoveryFingerprint.make(secret: secret, machineKey: Data(repeating: 0x42, count: 32),
                sessionID: "00112233-4455-4677-8899-aabbccddeeff",
                binding: AttachedBinding(harness: .claude, harnessSessionId: "owned-thread"),
                imageDigest: Data(repeating: 0x52, count: 32))
            #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) { try owner.finishCopy(id, fingerprint: fingerprint) }
            try owner.registerSnapshot(id, device: 42, inode: 1234)
            let restored = try ImageRecoveryLedger.restoreJournal(disk.load(), secret: secret)
            #expect(restored.ledger.records.first?.snapshotIdentity?.device == 42)
            #expect(restored.ledger.records.first?.snapshotIdentity?.inode == 1234)
            #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) { try owner.registerSnapshot(id, device: 42, inode: 1235) }
            try owner.finishCopy(id, fingerprint: fingerprint)
        }
    }
}
