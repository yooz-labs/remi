import Foundation
import CryptoKit
import Testing
@testable import RemiKit

/// Recovery decisions are independent of a particular filesystem. A production owner must
/// durably persist them and prove its own file removal before applying the deletion event.
@Suite struct ImageRecoveryLedgerTests {
    private let secret = Data(repeating: 0x41, count: 32)
    private let session = "00112233-4455-4677-8899-aabbccddeeff"
    private let digest = Data(repeating: 0x52, count: 32)
    private let key = Data(repeating: 0x42, count: 32)

    private func fingerprint(sessionID: String? = nil, binding: String = "owned-thread", image: Data? = nil) throws -> ImageRecoveryFingerprint {
        try ImageRecoveryFingerprint.make(secret: secret, machineKey: key, sessionID: sessionID ?? session,
            binding: AttachedBinding(harness: .claude, harnessSessionId: binding), imageDigest: image ?? digest)
    }

    // Tests that start after snapshot validation use a value copy to keep failed setup atomic.
    private func reserve(_ ledger: inout ImageRecoveryLedger, _ fingerprint: ImageRecoveryFingerprint) throws -> UUID {
        var candidate = ledger
        let id = try candidate.reserveCopy()
        try candidate.registerSnapshot(id, device: 1, inode: 2)
        try candidate.finishCopy(id, fingerprint: fingerprint)
        ledger = candidate
        return id
    }

    @Test func scopesUseExactUtf8RatherThanCanonicalStringEquality() throws {
        let composed = "\u{00e9}"
        let decomposed = "e\u{0301}"
        #expect(composed == decomposed) // Swift's normal equality is insufficient here.
        #expect(try fingerprint(binding: composed) != fingerprint(binding: decomposed))
        #expect(try fingerprint() == fingerprint())
    }

    @Test func invalidInputsCannotFormARecoveryIdentity() {
        let binding = AttachedBinding(harness: .claude, harnessSessionId: "owned-thread")
        for input in [Data(), Data(repeating: 1, count: 31), Data(repeating: 1, count: 33)] {
            #expect(throws: (any Error).self) {
                try ImageRecoveryFingerprint.make(secret: input, machineKey: key, sessionID: session,
                    binding: binding, imageDigest: digest)
            }
            #expect(throws: (any Error).self) {
                try ImageRecoveryFingerprint.make(secret: secret, machineKey: input, sessionID: session,
                    binding: binding, imageDigest: digest)
            }
            #expect(throws: (any Error).self) {
                try ImageRecoveryFingerprint.make(secret: secret, machineKey: key, sessionID: session,
                    binding: binding, imageDigest: input)
            }
        }
        #expect(throws: (any Error).self) {
            try ImageRecoveryFingerprint.make(secret: secret, machineKey: key, sessionID: session.uppercased(),
                binding: binding, imageDigest: digest)
        }
        #expect(throws: (any Error).self) {
            try ImageRecoveryFingerprint.make(secret: secret, machineKey: key, sessionID: session,
                binding: AttachedBinding(harness: .codex, harnessSessionId: "owned-thread"), imageDigest: digest)
        }
    }

    @Test func localAbandonmentKeepsUnconfirmedRemoteState() throws {
        var ledger = ImageRecoveryLedger()
        let id = try reserve(&ledger, try fingerprint())
        try ledger.markPartialPossible(id)
        #expect(throws: ImageRecoveryLedger.Failure.consentRequired) {
            try ledger.requestLocalAbandonment(id, confirmed: false)
        }
        try ledger.requestLocalAbandonment(id, confirmed: true)
        #expect(ledger.localSnapshotID == id)
        try ledger.confirmOwnedSnapshotDeleted(id)
        #expect(ledger.localSnapshotID == nil)
        #expect(ledger.records.count == 1)
        #expect(!ledger.hasAggregateUnconfirmedCleanup)
        try ledger.compactNoInsertion(id, confirmed: true)
        #expect(ledger.records.isEmpty)
        #expect(ledger.hasAggregateUnconfirmedCleanup)
    }

    @Test func stagedCleanupPrecedesInsertionAndUncertainFenceIsNotEvicted() throws {
        var ledger = ImageRecoveryLedger()
        let first = try reserve(&ledger, try fingerprint())
        try ledger.markPartialPossible(first)
        try ledger.markStagingPossible(first)
        try ledger.markStaged(first, expiry: "2026-10-31T12:00:00.000Z")
        #expect(throws: ImageRecoveryLedger.Failure.localSnapshotStillPresent) { try ledger.markInsertionPossible(first) }
        try ledger.requestStagedLocalCleanup(first)
        try ledger.confirmOwnedSnapshotDeleted(first)
        #expect(throws: ImageRecoveryLedger.Failure.stagedActionOutstanding) {
            _ = try reserve(&ledger, fingerprint(image: Data(repeating: 0x53, count: 32)))
        }
        try ledger.markInsertionPossible(first)
        #expect(throws: ImageRecoveryLedger.Failure.insertionInFlight) {
            _ = try reserve(&ledger, fingerprint(image: Data(repeating: 0x53, count: 32)))
        }
        try ledger.markInsertionUncertain(first)
        #expect(throws: ImageRecoveryLedger.Failure.insertionMayHaveOccurred) {
            try ledger.requestLocalAbandonment(first, confirmed: true)
        }
        #expect(throws: ImageRecoveryLedger.Failure.insertionMayHaveOccurred) {
            try ledger.compactNoInsertion(first, confirmed: true)
        }
        #expect(throws: ImageRecoveryLedger.Failure.sameImageInsertionUncertain) {
            _ = try reserve(&ledger, fingerprint())
        }
        let other = try reserve(&ledger, fingerprint(image: Data(repeating: 0x53, count: 32)))
        #expect(other != first)
        #expect(ledger.records.count == 2)
        #expect(!ledger.hasAggregateUnconfirmedCleanup)
    }

    @Test func confirmedInsertionRequiresExplicitAcknowledgmentBeforeSameImageCanBeSelectedAgain() throws {
        var ledger = ImageRecoveryLedger()
        let first = try reserve(&ledger, try fingerprint())
        try ledger.markPartialPossible(first)
        try ledger.markStagingPossible(first)
        try ledger.markStaged(first, expiry: "2026-10-31T12:00:00.000Z")
        try ledger.requestStagedLocalCleanup(first)
        try ledger.confirmOwnedSnapshotDeleted(first)
        try ledger.markInsertionPossible(first)
        try ledger.confirmInsertion(first)
        #expect(throws: ImageRecoveryLedger.Failure.sameImageAlreadyInserted) {
            _ = try reserve(&ledger, fingerprint())
        }
        #expect(throws: ImageRecoveryLedger.Failure.consentRequired) {
            try ledger.compactConfirmedInsertion(first, confirmed: false)
        }
        try ledger.compactConfirmedInsertion(first, confirmed: true)
        #expect(ledger.hasAggregateUnconfirmedCleanup) // This never claims host deletion.
        _ = try reserve(&ledger, fingerprint())
    }

    @Test func preEffectRefusalCannotRetryWithoutOriginalSocketRevalidation() throws {
        var ledger = ImageRecoveryLedger()
        let id = try reserve(&ledger, try fingerprint())
        try ledger.markPartialPossible(id)
        try ledger.markStagingPossible(id)
        try ledger.markStaged(id, expiry: "2026-10-31T12:00:00.000Z")
        try ledger.requestStagedLocalCleanup(id)
        try ledger.confirmOwnedSnapshotDeleted(id)
        try ledger.markInsertionPossible(id)
        try ledger.recordInsertionRefusal(id)
        #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) { try ledger.markInsertionPossible(id) }
        #expect(throws: ImageRecoveryLedger.Failure.stagedActionOutstanding) {
            _ = try reserve(&ledger, fingerprint(image: Data(repeating: 0x53, count: 32)))
        }
        try ledger.compactNoInsertion(id, confirmed: true)
        #expect(ledger.hasAggregateUnconfirmedCleanup)
    }

    @Test func lateReceiptCannotEraseAnUncertainFence() throws {
        var ledger = ImageRecoveryLedger()
        let id = try reserve(&ledger, try fingerprint())
        try ledger.markPartialPossible(id)
        try ledger.markStagingPossible(id)
        try ledger.markStaged(id, expiry: "2026-10-31T12:00:00.000Z")
        try ledger.requestStagedLocalCleanup(id)
        try ledger.confirmOwnedSnapshotDeleted(id)
        try ledger.markInsertionPossible(id)
        try ledger.markInsertionUncertain(id)
        #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) { try ledger.confirmInsertion(id) }
        #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) { try ledger.recordInsertionRefusal(id) }
        #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) { try ledger.compactConfirmedInsertion(id, confirmed: true) }
        #expect(throws: ImageRecoveryLedger.Failure.sameImageInsertionUncertain) { _ = try reserve(&ledger, fingerprint()) }
    }

    @Test func capacityIsBoundedAndOnlyExplicitSafeCompactionFreesASlot() throws {
        var ledger = ImageRecoveryLedger()
        var ids: [UUID] = []
        for n in 0..<ImageRecoveryLedger.maximumRecords {
            let id = try reserve(&ledger, fingerprint(image: Data(repeating: UInt8(n), count: 32)))
            try ledger.markPartialPossible(id)
            try ledger.requestLocalAbandonment(id, confirmed: true)
            try ledger.confirmOwnedSnapshotDeleted(id)
            ids.append(id)
        }
        #expect(ledger.records.count == ImageRecoveryLedger.maximumRecords)
        #expect(throws: ImageRecoveryLedger.Failure.recordCapacity) {
            _ = try reserve(&ledger, fingerprint(image: Data(repeating: 0xee, count: 32)))
        }
        #expect(throws: ImageRecoveryLedger.Failure.consentRequired) { try ledger.compactNoInsertion(ids[0], confirmed: false) }
        #expect(ledger.records.count == ImageRecoveryLedger.maximumRecords)
        try ledger.compactNoInsertion(ids[0], confirmed: true)
        #expect(ledger.hasAggregateUnconfirmedCleanup)
        _ = try reserve(&ledger, fingerprint(image: Data(repeating: 0xee, count: 32)))
        #expect(ledger.records.count == ImageRecoveryLedger.maximumRecords)
    }

    @Test func allUncertainInsertionsFailClosedAtCapacity() throws {
        var ledger = ImageRecoveryLedger()
        var ids: [UUID] = []
        for n in 0..<ImageRecoveryLedger.maximumRecords {
            let id = try reserve(&ledger, fingerprint(image: Data(repeating: UInt8(n), count: 32)))
            try ledger.markPartialPossible(id)
            try ledger.markStagingPossible(id)
            try ledger.markStaged(id, expiry: "2026-10-31T12:00:00.000Z")
            try ledger.requestStagedLocalCleanup(id)
            try ledger.confirmOwnedSnapshotDeleted(id)
            try ledger.markInsertionPossible(id)
            try ledger.markInsertionUncertain(id)
            ids.append(id)
        }
        #expect(throws: ImageRecoveryLedger.Failure.recordCapacity) {
            _ = try reserve(&ledger, fingerprint(image: Data(repeating: 0xee, count: 32)))
        }
        #expect(throws: ImageRecoveryLedger.Failure.insertionMayHaveOccurred) {
            try ledger.compactNoInsertion(ids[0], confirmed: true)
        }
        #expect(ledger.records.count == ImageRecoveryLedger.maximumRecords)
        #expect(!ledger.hasAggregateUnconfirmedCleanup)
    }

    @Test func anUnverifiedDeletionCannotReleaseTheLocalSlot() throws {
        var ledger = ImageRecoveryLedger()
        let id = try reserve(&ledger, try fingerprint())
        #expect(throws: ImageRecoveryLedger.Failure.cleanupNotRequested) { try ledger.confirmOwnedSnapshotDeleted(id) }
        #expect(throws: ImageRecoveryLedger.Failure.localSlotBusy) {
            _ = try reserve(&ledger, fingerprint(image: Data(repeating: 0x53, count: 32)))
        }
        #expect(ledger.localSnapshotID == id)
    }

    @Test func confirmedHostCancellationAndOwnedLocalDeletionClearTheRecord() throws {
        var ledger = ImageRecoveryLedger()
        let id = try reserve(&ledger, try fingerprint())
        try ledger.markPartialPossible(id)
        try ledger.confirmRemoteCancellation(id)
        #expect(ledger.records.count == 1) // Local bytes still need verified removal.
        try ledger.requestLocalAbandonment(id, confirmed: true)
        try ledger.confirmOwnedSnapshotDeleted(id)
        #expect(ledger.records.isEmpty)
        #expect(!ledger.hasAggregateUnconfirmedCleanup)
    }

    @Test func noRemoteEffectRequiresNoRemoteCleanupWarning() throws {
        var ledger = ImageRecoveryLedger()
        let id = try reserve(&ledger, try fingerprint())
        try ledger.requestLocalAbandonment(id, confirmed: true)
        try ledger.confirmOwnedSnapshotDeleted(id)
        #expect(ledger.records.isEmpty)
        #expect(!ledger.hasAggregateUnconfirmedCleanup)
    }

    @Test func authenticatedJournalRestoresInFlightInsertionAsUncertain() throws {
        var ledger = ImageRecoveryLedger()
        let id = try reserve(&ledger, try fingerprint())
        try ledger.markPartialPossible(id)
        try ledger.rememberPartialExpiry(id, expiry: "2026-10-30T12:05:00.000Z")
        try ledger.markStagingPossible(id)
        try ledger.markStaged(id, expiry: "2026-10-31T12:00:00.000Z")
        try ledger.requestStagedLocalCleanup(id)
        try ledger.confirmOwnedSnapshotDeleted(id)
        try ledger.markInsertionPossible(id)
        let bytes = try ledger.encodeJournal(secret: secret)
        let restored = try ImageRecoveryLedger.restoreJournal(bytes, secret: secret)
        #expect(restored.needsRewrite)
        #expect(restored.ledger.localSnapshotID == nil)
        #expect(restored.ledger.records.first?.exposure == .insertionUncertain(expiry: "2026-10-31T12:00:00.000Z"))
        #expect(restored.ledger.records.first?.knownPartialExpiry == "2026-10-30T12:05:00.000Z")
        #expect(throws: ImageRecoveryLedger.Failure.sameImageInsertionUncertain) {
            var copy = restored.ledger
            _ = try reserve(&copy, fingerprint())
        }
        let rewritten = try restored.ledger.encodeJournal(secret: secret)
        let second = try ImageRecoveryLedger.restoreJournal(rewritten, secret: secret)
        #expect(!second.needsRewrite)
        #expect(throws: ImageRecoveryLedger.Failure.sameImageInsertionUncertain) {
            var copy = second.ledger
            _ = try reserve(&copy, fingerprint())
        }
    }

    @Test func restartNeverRestoresAStagedArtifactsSocketAuthority() throws {
        var ledger = ImageRecoveryLedger()
        let id = try reserve(&ledger, try fingerprint())
        try ledger.markPartialPossible(id)
        try ledger.markStagingPossible(id)
        try ledger.markStaged(id, expiry: "2026-10-31T12:00:00.000Z")
        try ledger.requestStagedLocalCleanup(id)
        try ledger.confirmOwnedSnapshotDeleted(id)
        let restored = try ImageRecoveryLedger.restoreJournal(ledger.encodeJournal(secret: secret), secret: secret)
        #expect(restored.needsRewrite)
        #expect(restored.ledger.records.first?.exposure == .stagedOrphaned(expiry: "2026-10-31T12:00:00.000Z"))
        var recovered = restored.ledger
        #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) { try recovered.markInsertionPossible(id) }
    }

    @Test func restartNeverContinuesAnUnfinishedTransfer() throws {
        for completeMayHaveEntered in [false, true] {
            var ledger = ImageRecoveryLedger()
            let id = try reserve(&ledger, try fingerprint())
            try ledger.markPartialPossible(id)
            try ledger.rememberPartialExpiry(id, expiry: "2026-10-30T12:05:00.000Z")
            if completeMayHaveEntered { try ledger.markStagingPossible(id) }
            let restored = try ImageRecoveryLedger.restoreJournal(ledger.encodeJournal(secret: secret), secret: secret)
            #expect(restored.needsRewrite)
            #expect(restored.ledger.records.first?.exposure == (completeMayHaveEntered ? .stagingOrphaned : .partialOrphaned))
            var recovered = restored.ledger
            #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) { try recovered.markStagingPossible(id) }
            #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) {
                try recovered.markStaged(id, expiry: "2026-10-31T12:00:00.000Z")
            }
            #expect(recovered.localSnapshotID == id)
        }
    }

    @Test func restartCannotSendAnIncompletePreparedSnapshot() throws {
        var ledger = ImageRecoveryLedger()
        let id = try reserve(&ledger, try fingerprint())
        let restored = try ImageRecoveryLedger.restoreJournal(ledger.encodeJournal(secret: secret), secret: secret)
        var recovered = restored.ledger
        #expect(restored.needsRewrite)
        #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) { try recovered.markPartialPossible(id) }
        try recovered.requestLocalAbandonment(id, confirmed: true)
        try recovered.confirmOwnedSnapshotDeleted(id)
        #expect(recovered.records.isEmpty)
        #expect(!recovered.hasAggregateUnconfirmedCleanup)
    }

    @Test func reservationPrecedesSnapshotAndDigestWithoutGrantingSendAuthority() throws {
        var ledger = ImageRecoveryLedger()
        let id = try ledger.reserveCopy()
        #expect(ledger.localSnapshotID == id)
        #expect(throws: ImageRecoveryLedger.Failure.localSlotBusy) { _ = try ledger.reserveCopy() }
        #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) { try ledger.markPartialPossible(id) }
        try ledger.registerSnapshot(id, device: 1, inode: 2)
        try ledger.finishCopy(id, fingerprint: fingerprint())
        try ledger.markPartialPossible(id)
    }

    @Test func aCopyInterruptedBeforeItsDigestCannotResumeAfterRestart() throws {
        var ledger = ImageRecoveryLedger()
        let id = try ledger.reserveCopy()
        let restored = try ImageRecoveryLedger.restoreJournal(ledger.encodeJournal(secret: secret), secret: secret)
        #expect(restored.needsRewrite)
        var recovered = restored.ledger
        #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) { try recovered.finishCopy(id, fingerprint: fingerprint()) }
        try recovered.requestLocalAbandonment(id, confirmed: true)
        try recovered.confirmOwnedSnapshotDeleted(id)
        #expect(recovered.records.isEmpty)
        #expect(!recovered.hasAggregateUnconfirmedCleanup)
    }

    @Test func finalizingCopyStillRespectsExistingUncertainInsertionFence() throws {
        var ledger = ImageRecoveryLedger()
        let first = try reserve(&ledger, try fingerprint())
        try ledger.markPartialPossible(first)
        try ledger.markStagingPossible(first)
        try ledger.markStaged(first, expiry: "2026-10-31T12:00:00.000Z")
        try ledger.requestStagedLocalCleanup(first)
        try ledger.confirmOwnedSnapshotDeleted(first)
        try ledger.markInsertionPossible(first)
        try ledger.markInsertionUncertain(first)
        let copy = try ledger.reserveCopy()
        try ledger.registerSnapshot(copy, device: 1, inode: 2)
        #expect(throws: ImageRecoveryLedger.Failure.sameImageInsertionUncertain) { try ledger.finishCopy(copy, fingerprint: fingerprint()) }
        #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) { try ledger.markPartialPossible(copy) }
        try ledger.requestLocalAbandonment(copy, confirmed: true)
        try ledger.confirmOwnedSnapshotDeleted(copy)
        #expect(ledger.records.count == 1)
    }

    @Test func cleanupRequestRetiresCopyAndSendAuthority() throws {
        var copying = ImageRecoveryLedger()
        let copy = try copying.reserveCopy()
        try copying.requestLocalAbandonment(copy, confirmed: true)
        #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) { try copying.finishCopy(copy, fingerprint: fingerprint()) }
        var prepared = ImageRecoveryLedger()
        let ready = try reserve(&prepared, try fingerprint())
        try prepared.requestLocalAbandonment(ready, confirmed: true)
        #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) { try prepared.markPartialPossible(ready) }
        var partial = ImageRecoveryLedger()
        let started = try reserve(&partial, try fingerprint())
        try partial.markPartialPossible(started)
        try partial.requestLocalAbandonment(started, confirmed: true)
        #expect(throws: ImageRecoveryLedger.Failure.invalidTransition) { try partial.markStagingPossible(started) }
    }

    @Test func journalRejectsTamperingWrongKeyAndOversizedInput() throws {
        var ledger = ImageRecoveryLedger()
        let id = try reserve(&ledger, try fingerprint())
        try ledger.markPartialPossible(id)
        let bytes = try ledger.encodeJournal(secret: secret)
        let text = try #require(String(data: bytes, encoding: .utf8))
        #expect(text.contains("\"aggregate\":false"))
        let changed = Data(text.replacingOccurrences(of: "\"aggregate\":false", with: "\"aggregate\":true").utf8)
        #expect(throws: (any Error).self) { try ImageRecoveryLedger.restoreJournal(changed, secret: secret) }
        #expect(throws: (any Error).self) { try ImageRecoveryLedger.restoreJournal(bytes, secret: Data(repeating: 0x33, count: 32)) }
        #expect(throws: (any Error).self) { try ImageRecoveryLedger.restoreJournal(Data(bytes.dropLast()), secret: secret) }
        #expect(throws: (any Error).self) { try ImageRecoveryLedger.restoreJournal(Data(repeating: 0x20, count: 16_385), secret: secret) }
    }

    @Test func journalRestoresMaximumUncertainFencesWithoutEviction() throws {
        var ledger = ImageRecoveryLedger()
        for n in 0..<ImageRecoveryLedger.maximumRecords {
            let id = try reserve(&ledger, fingerprint(image: Data(repeating: UInt8(n), count: 32)))
            try ledger.markPartialPossible(id)
            try ledger.markStagingPossible(id)
            try ledger.markStaged(id, expiry: "2026-10-31T12:00:00.000Z")
            try ledger.requestStagedLocalCleanup(id)
            try ledger.confirmOwnedSnapshotDeleted(id)
            try ledger.markInsertionPossible(id)
            try ledger.markInsertionUncertain(id)
        }
        let bytes = try ledger.encodeJournal(secret: secret)
        #expect(bytes.count <= 16_384)
        let restored = try ImageRecoveryLedger.restoreJournal(bytes, secret: secret)
        #expect(restored.ledger.records.count == ImageRecoveryLedger.maximumRecords)
        #expect(throws: ImageRecoveryLedger.Failure.recordCapacity) {
            var copy = restored.ledger
            _ = try reserve(&copy, fingerprint(image: Data(repeating: 0xee, count: 32)))
        }
    }

    @Test func authenticatedButInconsistentJournalCannotRestoreAuthority() throws {
        // A valid MAC alone must not make impossible prior-version or corrupted state safe.
        func record(id: String, exposure: String, expiry: String = "null", local: Bool,
                    cleanup: Bool = false, cancelled: Bool = false) -> String {
            let hash = WireGuards.encodeBase64URL(Data(repeating: 1, count: 32))
            let fileID = local ? "\"1\"" : "null"
            return "{\"id\":\"\(id)\",\"scope\":\"\(hash)\",\"image\":\"\(hash)\",\"exposure\":\"\(exposure)\",\"expiry\":\(expiry),\"partialExpiry\":null,\"fileDevice\":\(fileID),\"fileInode\":\(fileID),\"local\":\(local),\"cleanup\":\(cleanup),\"remoteCancelled\":\(cancelled)}"
        }
        func journal(_ records: [String]) -> Data {
            let payload = "{\"version\":1,\"aggregate\":false,\"records\":[\(records.joined(separator: ","))]}"
            let tag = HMAC<SHA256>.authenticationCode(for: Data(payload.utf8), using: SymmetricKey(data: secret))
            return Data("{\"payload\":\(payload),\"mac\":\"\(WireGuards.encodeBase64URL(Data(tag)))\"}".utf8)
        }
        let one = "00112233-4455-4677-8899-aabbccddeeff"
        let two = "00112233-4455-4677-8899-aabbccddee00"
        let expiry = "\"2026-10-31T12:00:00.000Z\""
        let valid = try ImageRecoveryLedger.restoreJournal(journal([record(id: one, exposure: "prepared", local: true)]), secret: secret)
        #expect(valid.ledger.records.count == 1)
        let invalid = [
            [record(id: one, exposure: "prepared", local: false)],
            [record(id: one, exposure: "insertion_in_flight", expiry: expiry, local: true)],
            [record(id: one, exposure: "insertion_confirmed", expiry: expiry, local: false, cancelled: true)],
            [record(id: one, exposure: "prepared", local: true), record(id: two, exposure: "prepared", local: true)],
            [record(id: one, exposure: "partial", local: false), record(id: one, exposure: "partial", local: false)],
            [record(id: one, exposure: "staged", local: false)],
            [record(id: one, exposure: "future_unknown", local: false)],
        ]
        for entries in invalid {
            #expect(throws: (any Error).self) { try ImageRecoveryLedger.restoreJournal(journal(entries), secret: secret) }
        }
    }
}
