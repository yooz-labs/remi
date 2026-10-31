import Foundation

/// Persists a narrow part of the image recovery model before exposing a transition.
/// This is not the filesystem owner: its caller must supply an existing protected Keychain
/// key, prove snapshot creation and validation, and provide one serialized owner per lease.
/// It cannot authorize a socket, delete a file, or establish remote cleanup.
final class ImageRecoveryJournal {
    enum Failure: Error, Equatable { case retired, invalidClaim, copyActive, readerActive }

    private let disk: ImageJournalDisk
    private let claim: ImageDirectoryLease.OwnerClaim
    private let secret: Data
    private let witness: ImageJournalRevision?
    private var bytes: Data
    private var storedSnapshot: ImageRecoveryLedger
    private var isRetired = false
    private var copyActive = false
    private var activeReader: UUID?
    var snapshot: ImageRecoveryLedger { claim.synchronized { storedSnapshot } }
    var retired: Bool { claim.synchronized { isRetired } }

    /// Restart never revives a pending copy or old socket. The normalized record is made
    /// durable before this object returns; failure cannot be retried through this object.
    /// The unbound form is a disk primitive only and cannot authorize a transfer. The composed
    /// installation owner supplies the Keychain witness before exposing persisted transitions.
    convenience init(disk: ImageJournalDisk, secret: Data, claim: ImageDirectoryLease.OwnerClaim) throws {
        try self.init(disk: disk, secret: secret, claim: claim, witness: nil)
    }

    init(disk: ImageJournalDisk, secret: Data, claim: ImageDirectoryLease.OwnerClaim,
         witness: ImageJournalRevision?) throws {
        guard disk.accepts(claim) else { throw Failure.invalidClaim }
        try claim.attachJournal()
        let original = try disk.load()
        try witness?.verify(original)
        let restored = try ImageRecoveryLedger.restoreJournal(original, secret: secret)
        let stored: Data
        if restored.needsRewrite {
            stored = try restored.ledger.encodeJournal(secret: secret)
            try disk.replace(expected: original, with: stored)
            try witness?.advance(from: original, to: stored)
        } else {
            stored = original
        }
        self.disk = disk
        self.claim = claim
        self.secret = secret
        self.witness = witness
        self.bytes = stored
        self.storedSnapshot = restored.ledger
    }

    /// A durable reservation comes before opening or writing the selected image copy.
    func reserveCopy() throws -> UUID {
        try transition { try $0.reserveCopy() }
    }

    /// The caller must open the new file exclusively and verify both the descriptor and its
    /// entry in the owned directory before recording the identity, and before writing data.
    func registerSnapshot(_ id: UUID, device: UInt64, inode: UInt64) throws {
        try transition(allowDuringCopy: true) { try $0.registerSnapshot(id, device: device, inode: inode) }
    }

    /// The caller must first prove that the owned copy is complete, protected and validated.
    func finishCopy(_ id: UUID, fingerprint: ImageRecoveryFingerprint) throws {
        try transition { try $0.finishCopy(id, fingerprint: fingerprint) }
    }

    /// Persist the conservative boundary before the corresponding network effect may enter.
    func markPartialPossible(_ id: UUID) throws { try transition { try $0.markPartialPossible(id) } }
    /// Record only the exact deadline from a validated response; never extend it on retry.
    func rememberPartialExpiry(_ id: UUID, expiry: String) throws { try transition { try $0.rememberPartialExpiry(id, expiry: expiry) } }
    func markStagingPossible(_ id: UUID) throws { try transition { try $0.markStagingPossible(id) } }

    /// The caller must first validate the result on its original authorized socket.
    func markStaged(_ id: UUID, expiry: String) throws { try transition { try $0.markStaged(id, expiry: expiry) } }

    func requestStagedLocalCleanup(_ id: UUID) throws {
        try claim.synchronized {
            guard activeReader == nil else { throw Failure.readerActive }
            try transition { try $0.requestStagedLocalCleanup(id) }
        }
    }

    /// The local snapshot must already be removed before insertion can become possible.
    func markInsertionPossible(_ id: UUID) throws { try transition { try $0.markInsertionPossible(id) } }
    func markInsertionUncertain(_ id: UUID) throws { try transition { try $0.markInsertionUncertain(id) } }

    func requestLocalAbandonment(_ id: UUID, confirmed: Bool) throws {
        try claim.synchronized {
            guard activeReader == nil else { throw Failure.readerActive }
            try transition { try $0.requestLocalAbandonment(id, confirmed: confirmed) }
        }
    }

    /// Only the filesystem owner may call this after proving the owned entry is absent and
    /// synchronizing its directory. The transition never proves remote deletion.
    func confirmOwnedSnapshotDeleted(_ id: UUID) throws {
        try claim.synchronized {
            guard activeReader == nil else { throw Failure.readerActive }
            try transition { try $0.confirmOwnedSnapshotDeleted(id) }
        }
    }

    func holds(_ lease: ImageDirectoryLease) -> Bool { claim.belongs(to: lease) }

    /// Retains the journal/lease and prevents local cleanup during a serialized upload read.
    final class SnapshotReadClaim {
        private let lock = NSLock()
        private var journal: ImageRecoveryJournal?
        private let id: UUID
        fileprivate init(journal: ImageRecoveryJournal, id: UUID) { self.journal = journal; self.id = id }
        func release() {
            lock.lock(); let owner = journal; journal = nil; lock.unlock()
            owner?.releaseSnapshotReader(id)
        }
        deinit { release() }
    }

    func claimSnapshotRead(_ id: UUID) throws -> SnapshotReadClaim {
        try claim.synchronized {
            guard !isRetired else { throw Failure.retired }
            guard !copyActive else { throw Failure.copyActive }
            guard activeReader == nil else { throw Failure.readerActive }
            guard storedSnapshot.localSnapshotID == id,
                  let record = storedSnapshot.records.first(where: { $0.id == id }),
                  record.exposure == .prepared, record.localSnapshotPresent, !record.cleanupRequested,
                  record.snapshotIdentity != nil else { throw Failure.invalidClaim }
            activeReader = id
            return SnapshotReadClaim(journal: self, id: id)
        }
    }

    private func releaseSnapshotReader(_ id: UUID) {
        claim.synchronized { if activeReader == id { activeReader = nil } }
    }

    /// Compare the recorded scope and digest without exposing the installation secret.
    func matchesPreparedCopy(_ id: UUID, begin: ImageUploadBegin, machineKey: Data) throws -> Bool {
        try claim.synchronized {
            guard !isRetired, let digest = WireGuards.decodeBase64URL(begin.digest), digest.count == 32 else {
                return false
            }
            let fingerprint = try ImageRecoveryFingerprint.make(secret: secret, machineKey: machineKey,
                sessionID: begin.header.sessionId, binding: begin.binding, imageDigest: digest)
            guard storedSnapshot.localSnapshotID == id,
                  let record = storedSnapshot.records.first(where: { $0.id == id }),
                  record.exposure == .prepared, record.localSnapshotPresent, !record.cleanupRequested else { return false }
            return record.fingerprint == fingerprint
        }
    }

    /// Reentrant callbacks cannot finalize or abandon the file until the copy scope ends.
    func withActiveCopy<T>(_ body: () throws -> T) throws -> T {
        try claim.synchronized {
            guard !isRetired else { throw Failure.retired }
            guard !copyActive else { throw Failure.copyActive }
            guard activeReader == nil else { throw Failure.readerActive }
            copyActive = true
            defer { copyActive = false }
            return try body()
        }
    }

    private func transition<T>(allowDuringCopy: Bool = false, _ apply: (inout ImageRecoveryLedger) throws -> T) throws -> T {
        try claim.synchronized {
            guard !isRetired else { throw Failure.retired }
            guard allowDuringCopy || !copyActive else { throw Failure.copyActive }
            var candidate = storedSnapshot
            let result = try apply(&candidate)
            let next = try candidate.encodeJournal(secret: secret)
            do {
                try disk.replace(expected: bytes, with: next)
                try witness?.advance(from: bytes, to: next)
            } catch {
                isRetired = true
                throw error
            }
            bytes = next
            storedSnapshot = candidate
            return result
        }
    }
}
