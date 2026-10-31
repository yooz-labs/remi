import CryptoKit
import Darwin
import Foundation
import Testing
@testable import RemiKit

#if os(macOS)
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
        let claim = try disk.claimOwner()
        let journal = try ImageRecoveryJournal(disk: disk, secret: secret, claim: claim)
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

    @Test func selectedFileIsCopiedWhileItsOpenedDescriptorIsHeld() throws {
        let bytes = Data(repeating: 0x42, count: 75_000)
        try withFixture(bytes) { root, input, _, journal, owner in
            let id = try journal.reserveCopy()
            let result = try owner.captureSelectedFile(id: id, url: input)
            let snapshot = root.appendingPathComponent("image-\(id.uuidString.lowercased())")
            #expect(result.byteCount == bytes.count)
            #expect(result.digest == Data(SHA256.hash(data: bytes)))
            #expect(try Data(contentsOf: snapshot) == bytes)
            #expect(try Data(contentsOf: input) == bytes)
        }
    }

    @Test func selectedFileReplacementCannotChangeTheOpenedInput() throws {
        let original = Data(repeating: 0x31, count: 70_000)
        let replacement = Data([4, 5, 6])
        try withFixture(original) { root, input, _, journal, owner in
            let id = try journal.reserveCopy()
            let moved = input.deletingLastPathComponent().appendingPathComponent("original-moved")
            var replaced = false
            _ = try owner.captureSelectedFile(id: id, url: input) {
                if !replaced, rename(input.path, moved.path) == 0 {
                    do { try replacement.write(to: input); replaced = true } catch {}
                }
                return false
            }
            #expect(replaced)
            let snapshot = root.appendingPathComponent("image-\(id.uuidString.lowercased())")
            #expect(try Data(contentsOf: snapshot) == original)
            #expect(try Data(contentsOf: moved) == original)
            #expect(try Data(contentsOf: input) == replacement)
        }
    }

    @Test func selectedFileModifiedDuringCopyIsRefusedAndRetainedForCleanup() throws {
        let original = Data(repeating: 0x31, count: 70_000)
        try withFixture(original) { root, input, _, journal, owner in
            let id = try journal.reserveCopy()
            var modified = false
            #expect(throws: ImageSnapshotOwner.Failure.sourceChanged) {
                try owner.captureSelectedFile(id: id, url: input) {
                    if !modified {
                        let writer = open(input.path, O_WRONLY | O_CLOEXEC | O_NOFOLLOW)
                        if writer >= 0 {
                            var byte: UInt8 = 0x55
                            modified = pwrite(writer, &byte, 1, 0) == 1
                            close(writer)
                        }
                    }
                    return false
                }
            }
            #expect(modified)
            #expect(journal.snapshot.localSnapshotID == id)
            #expect(journal.snapshot.records.first?.snapshotIdentity != nil)
            #expect(FileManager.default.fileExists(atPath: root.appendingPathComponent("image-\(id.uuidString.lowercased())").path))
        }
    }

    @Test func selectedSymlinkAndRemoteURLAreRefusedWithoutReadingTarget() throws {
        try withFixture(Data([1, 2, 3])) { root, input, _, journal, owner in
            let id = try journal.reserveCopy()
            let alias = input.deletingLastPathComponent().appendingPathComponent("alias")
            #expect(symlink(input.path, alias.path) == 0)
            #expect(throws: (any Error).self) { try owner.captureSelectedFile(id: id, url: alias) }
            let remote = try #require(URL(string: "https://example.invalid/image.png"))
            #expect(throws: (any Error).self) {
                try owner.captureSelectedFile(id: id, url: remote)
            }
            let remoteFile = try #require(URL(string: "file://example.invalid/image.png"))
            #expect(throws: (any Error).self) { try owner.captureSelectedFile(id: id, url: remoteFile) }
            #expect(journal.snapshot.records.first?.snapshotIdentity == nil)
            #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("image-\(id.uuidString.lowercased())").path))
            #expect(try Data(contentsOf: input) == Data([1, 2, 3]))
        }
    }

    @Test func emptySelectedFileCanBeAbandonedWithoutCreatingASnapshot() throws {
        try withFixture(Data()) { root, input, _, journal, owner in
            let id = try journal.reserveCopy()
            #expect(throws: (any Error).self) { try owner.captureSelectedFile(id: id, url: input) }
            #expect(journal.snapshot.records.first?.snapshotIdentity == nil)
            #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent("image-\(id.uuidString.lowercased())").path))
            try owner.abandon(id: id, confirmed: true)
            #expect(journal.snapshot.localSnapshotID == nil)
        }
    }

    @Test func existingSymlinkIsPreservedAndNeverRegistered() throws {
        try withFixture(Data([4, 5, 6])) { root, input, source, journal, owner in
            let id = try journal.reserveCopy()
            let snapshot = root.appendingPathComponent("image-\(id.uuidString.lowercased())")
            #expect(symlink(input.path, snapshot.path) == 0)
            #expect(throws: (any Error).self) { try owner.capture(id: id, source: source) }
            #expect(journal.snapshot.records.first?.snapshotIdentity == nil)
            #expect(throws: (any Error).self) { try owner.abandon(id: id, confirmed: true) }
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

    @Test func reentrantCallbackCannotDeleteOrFinalizeAnActiveCopy() throws {
        let bytes = Data(repeating: 7, count: 100_000)
        try withFixture(bytes) { root, _, source, journal, owner in
            let id = try journal.reserveCopy()
            let fingerprint = try ImageRecoveryFingerprint.make(secret: secret, machineKey: Data(repeating: 0x42, count: 32),
                sessionID: "00112233-4455-4677-8899-aabbccddeeff",
                binding: AttachedBinding(harness: .claude, harnessSessionId: "owned-thread"),
                imageDigest: Data(SHA256.hash(data: bytes)))
            var attempted = false
            var cleanupDenied = false
            var finalizeDenied = false
            let result = try owner.capture(id: id, source: source) {
                if !attempted {
                    attempted = true
                    do { try owner.abandon(id: id, confirmed: true) }
                    catch ImageRecoveryJournal.Failure.copyActive { cleanupDenied = true }
                    catch {}
                    do { try journal.finishCopy(id, fingerprint: fingerprint) }
                    catch ImageRecoveryJournal.Failure.copyActive { finalizeDenied = true }
                    catch {}
                }
                return false
            }
            #expect(attempted && cleanupDenied && finalizeDenied)
            #expect(result.byteCount == bytes.count)
            #expect(journal.snapshot.localSnapshotID == id)
            #expect(FileManager.default.fileExists(atPath: root.appendingPathComponent("image-\(id.uuidString.lowercased())").path))
            try journal.finishCopy(id, fingerprint: fingerprint)
        }
    }

    @Test func confirmedAbandonmentDeletesOnlyOwnedSnapshot() throws {
        try withFixture(Data([7, 8, 9])) { root, input, source, journal, owner in
            let id = try journal.reserveCopy()
            _ = try owner.capture(id: id, source: source)
            let snapshot = root.appendingPathComponent("image-\(id.uuidString.lowercased())")
            #expect(throws: ImageRecoveryLedger.Failure.consentRequired) { try owner.abandon(id: id, confirmed: false) }
            #expect(FileManager.default.fileExists(atPath: snapshot.path))
            try owner.abandon(id: id, confirmed: true)
            #expect(!FileManager.default.fileExists(atPath: snapshot.path))
            #expect(try Data(contentsOf: input) == Data([7, 8, 9]))
            #expect(journal.snapshot.records.isEmpty)
            #expect(journal.snapshot.localSnapshotID == nil)
        }
    }

    @Test func recordedStagingCleansLocalCopyBeforeInsertionTransition() throws {
        let bytes = Data([7, 8, 9])
        try withFixture(bytes) { root, _, source, journal, owner in
            let id = try journal.reserveCopy()
            _ = try owner.capture(id: id, source: source)
            let fingerprint = try ImageRecoveryFingerprint.make(secret: secret, machineKey: Data(repeating: 0x42, count: 32),
                sessionID: "00112233-4455-4677-8899-aabbccddeeff",
                binding: AttachedBinding(harness: .claude, harnessSessionId: "owned-thread"),
                imageDigest: Data(SHA256.hash(data: bytes)))
            try journal.finishCopy(id, fingerprint: fingerprint)
            #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) { try owner.clearAfterStaging(id: id) }
            try journal.markPartialPossible(id)
            try journal.rememberPartialExpiry(id, expiry: "2026-10-31T23:59:00.000Z")
            try journal.markStagingPossible(id)
            try journal.markStaged(id, expiry: "2026-11-01T00:00:00.000Z")
            #expect(throws: ImageRecoveryLedger.Failure.localSnapshotStillPresent) { try journal.markInsertionPossible(id) }
            try owner.clearAfterStaging(id: id)
            let snapshot = root.appendingPathComponent("image-\(id.uuidString.lowercased())")
            #expect(!FileManager.default.fileExists(atPath: snapshot.path))
            #expect(journal.snapshot.localSnapshotID == nil)
            #expect(journal.snapshot.records.first?.exposure == .staged(expiry: "2026-11-01T00:00:00.000Z"))
            #expect(!journal.snapshot.hasAggregateUnconfirmedCleanup)
            try journal.markInsertionPossible(id)
            #expect(journal.snapshot.records.first?.exposure == .insertionInFlight(expiry: "2026-11-01T00:00:00.000Z"))
            try journal.markInsertionUncertain(id)
            #expect(throws: ImageRecoveryLedger.Failure.insertionMayHaveOccurred) { try owner.abandon(id: id, confirmed: true) }
            let second = try journal.reserveCopy()
            #expect(lseek(source, 0, SEEK_SET) == 0)
            _ = try owner.capture(id: second, source: source)
            #expect(throws: ImageRecoveryLedger.Failure.sameImageInsertionUncertain) {
                try journal.finishCopy(second, fingerprint: fingerprint)
            }
            try owner.abandon(id: second, confirmed: true)
            #expect(journal.snapshot.records.first?.exposure == .insertionUncertain(expiry: "2026-11-01T00:00:00.000Z"))
            #expect(journal.snapshot.records.first?.knownPartialExpiry == "2026-10-31T23:59:00.000Z")
        }
    }

    @Test func cleanupRefusesAReplacementAndPreservesBothFiles() throws {
        try withFixture(Data([7, 8, 9])) { root, _, source, journal, owner in
            let id = try journal.reserveCopy()
            _ = try owner.capture(id: id, source: source)
            let snapshot = root.appendingPathComponent("image-\(id.uuidString.lowercased())")
            let moved = root.appendingPathComponent("unrelated-owned-file")
            #expect(rename(snapshot.path, moved.path) == 0)
            try Data([3, 2, 1]).write(to: snapshot)
            #expect(chmod(snapshot.path, 0o600) == 0)
            #expect(throws: (any Error).self) { try owner.abandon(id: id, confirmed: true) }
            #expect(try Data(contentsOf: snapshot) == Data([3, 2, 1]))
            #expect(try Data(contentsOf: moved) == Data([7, 8, 9]))
            #expect(journal.snapshot.localSnapshotID == id)
        }
    }

    @Test func cleanupDoesNotReleaseTheSlotWhenTheOwnedInodeWasMoved() throws {
        try withFixture(Data([7, 8, 9])) { root, _, source, journal, owner in
            let id = try journal.reserveCopy()
            _ = try owner.capture(id: id, source: source)
            let snapshot = root.appendingPathComponent("image-\(id.uuidString.lowercased())")
            let moved = root.appendingPathComponent("moved-file")
            #expect(rename(snapshot.path, moved.path) == 0)
            #expect(throws: (any Error).self) { try owner.abandon(id: id, confirmed: true) }
            #expect(try Data(contentsOf: moved) == Data([7, 8, 9]))
            #expect(journal.snapshot.localSnapshotID == id)
        }
    }

    @Test func aConfirmedDeletionCanBeRecoveredAfterInterruption() throws {
        try withFixture(Data([1, 2, 3])) { root, _, source, journal, owner in
            let id = try journal.reserveCopy()
            _ = try owner.capture(id: id, source: source)
            try journal.requestLocalAbandonment(id, confirmed: true)
            let snapshot = root.appendingPathComponent("image-\(id.uuidString.lowercased())")
            #expect(unlink(snapshot.path) == 0)
            try owner.abandon(id: id, confirmed: true)
            #expect(journal.snapshot.localSnapshotID == nil)
            #expect(journal.snapshot.records.isEmpty)
        }
    }
}
#endif
