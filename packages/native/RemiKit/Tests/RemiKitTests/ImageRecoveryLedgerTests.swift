import Foundation
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
        let id = try ledger.reserve(try fingerprint())
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
        let first = try ledger.reserve(try fingerprint())
        try ledger.markPartialPossible(first)
        try ledger.markStagingPossible(first)
        try ledger.markStaged(first, expiry: "2026-10-31T12:00:00.000Z")
        #expect(throws: ImageRecoveryLedger.Failure.localSnapshotStillPresent) { try ledger.markInsertionPossible(first) }
        try ledger.requestStagedLocalCleanup(first)
        try ledger.confirmOwnedSnapshotDeleted(first)
        try ledger.markInsertionPossible(first)
        #expect(throws: ImageRecoveryLedger.Failure.insertionMayHaveOccurred) {
            try ledger.requestLocalAbandonment(first, confirmed: true)
        }
        #expect(throws: ImageRecoveryLedger.Failure.insertionMayHaveOccurred) {
            try ledger.compactNoInsertion(first, confirmed: true)
        }
        #expect(throws: ImageRecoveryLedger.Failure.sameImageInsertionUncertain) {
            _ = try ledger.reserve(fingerprint())
        }
        let other = try ledger.reserve(fingerprint(image: Data(repeating: 0x53, count: 32)))
        #expect(other != first)
        #expect(ledger.records.count == 2)
        #expect(!ledger.hasAggregateUnconfirmedCleanup)
    }

    @Test func capacityIsBoundedAndOnlyExplicitSafeCompactionFreesASlot() throws {
        var ledger = ImageRecoveryLedger()
        var ids: [UUID] = []
        for n in 0..<ImageRecoveryLedger.maximumRecords {
            let id = try ledger.reserve(fingerprint(image: Data(repeating: UInt8(n), count: 32)))
            try ledger.markPartialPossible(id)
            try ledger.requestLocalAbandonment(id, confirmed: true)
            try ledger.confirmOwnedSnapshotDeleted(id)
            ids.append(id)
        }
        #expect(ledger.records.count == ImageRecoveryLedger.maximumRecords)
        #expect(throws: ImageRecoveryLedger.Failure.recordCapacity) {
            _ = try ledger.reserve(fingerprint(image: Data(repeating: 0xee, count: 32)))
        }
        #expect(throws: ImageRecoveryLedger.Failure.consentRequired) { try ledger.compactNoInsertion(ids[0], confirmed: false) }
        #expect(ledger.records.count == ImageRecoveryLedger.maximumRecords)
        try ledger.compactNoInsertion(ids[0], confirmed: true)
        #expect(ledger.hasAggregateUnconfirmedCleanup)
        _ = try ledger.reserve(fingerprint(image: Data(repeating: 0xee, count: 32)))
        #expect(ledger.records.count == ImageRecoveryLedger.maximumRecords)
    }

    @Test func allUncertainInsertionsFailClosedAtCapacity() throws {
        var ledger = ImageRecoveryLedger()
        var ids: [UUID] = []
        for n in 0..<ImageRecoveryLedger.maximumRecords {
            let id = try ledger.reserve(fingerprint(image: Data(repeating: UInt8(n), count: 32)))
            try ledger.markPartialPossible(id)
            try ledger.markStagingPossible(id)
            try ledger.markStaged(id, expiry: "2026-10-31T12:00:00.000Z")
            try ledger.requestStagedLocalCleanup(id)
            try ledger.confirmOwnedSnapshotDeleted(id)
            try ledger.markInsertionPossible(id)
            ids.append(id)
        }
        #expect(throws: ImageRecoveryLedger.Failure.recordCapacity) {
            _ = try ledger.reserve(fingerprint(image: Data(repeating: 0xee, count: 32)))
        }
        #expect(throws: ImageRecoveryLedger.Failure.insertionMayHaveOccurred) {
            try ledger.compactNoInsertion(ids[0], confirmed: true)
        }
        #expect(ledger.records.count == ImageRecoveryLedger.maximumRecords)
        #expect(!ledger.hasAggregateUnconfirmedCleanup)
    }

    @Test func anUnverifiedDeletionCannotReleaseTheLocalSlot() throws {
        var ledger = ImageRecoveryLedger()
        let id = try ledger.reserve(try fingerprint())
        #expect(throws: ImageRecoveryLedger.Failure.cleanupNotRequested) { try ledger.confirmOwnedSnapshotDeleted(id) }
        #expect(throws: ImageRecoveryLedger.Failure.localSlotBusy) {
            _ = try ledger.reserve(fingerprint(image: Data(repeating: 0x53, count: 32)))
        }
        #expect(ledger.localSnapshotID == id)
    }

    @Test func confirmedHostCancellationAndOwnedLocalDeletionClearTheRecord() throws {
        var ledger = ImageRecoveryLedger()
        let id = try ledger.reserve(try fingerprint())
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
        let id = try ledger.reserve(try fingerprint())
        try ledger.requestLocalAbandonment(id, confirmed: true)
        try ledger.confirmOwnedSnapshotDeleted(id)
        #expect(ledger.records.isEmpty)
        #expect(!ledger.hasAggregateUnconfirmedCleanup)
    }
}
