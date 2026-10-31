import Foundation

/// Persists a narrow part of the image recovery model before exposing a transition.
/// This is not the filesystem owner: its caller must supply an existing protected Keychain
/// key, prove snapshot creation and validation, and provide one serialized owner per lease.
/// It cannot authorize a socket, delete a file, or establish remote cleanup.
final class ImageRecoveryJournal {
    enum Failure: Error, Equatable { case retired, invalidClaim, copyActive }

    private let disk: ImageJournalDisk
    private let claim: ImageDirectoryLease.OwnerClaim
    private let secret: Data
    private var bytes: Data
    private var storedSnapshot: ImageRecoveryLedger
    private var isRetired = false
    private var copyActive = false
    var snapshot: ImageRecoveryLedger { claim.synchronized { storedSnapshot } }
    var retired: Bool { claim.synchronized { isRetired } }

    /// Restart never revives a pending copy or old socket. The normalized record is made
    /// durable before this object returns; failure cannot be retried through this object.
    init(disk: ImageJournalDisk, secret: Data, claim: ImageDirectoryLease.OwnerClaim) throws {
        guard disk.accepts(claim) else { throw Failure.invalidClaim }
        try claim.attachJournal()
        let original = try disk.load()
        let restored = try ImageRecoveryLedger.restoreJournal(original, secret: secret)
        let stored: Data
        if restored.needsRewrite {
            stored = try restored.ledger.encodeJournal(secret: secret)
            try disk.replace(expected: original, with: stored)
        } else {
            stored = original
        }
        self.disk = disk
        self.claim = claim
        self.secret = secret
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

    func requestLocalAbandonment(_ id: UUID, confirmed: Bool) throws {
        try transition { try $0.requestLocalAbandonment(id, confirmed: confirmed) }
    }

    /// Only the filesystem owner may call this after proving the owned entry is absent and
    /// synchronizing its directory. The transition never proves remote deletion.
    func confirmOwnedSnapshotDeleted(_ id: UUID) throws {
        try transition { try $0.confirmOwnedSnapshotDeleted(id) }
    }

    func holds(_ lease: ImageDirectoryLease) -> Bool { claim.belongs(to: lease) }

    /// Reentrant callbacks cannot finalize or abandon the file until the copy scope ends.
    func withActiveCopy<T>(_ body: () throws -> T) throws -> T {
        try claim.synchronized {
            guard !isRetired else { throw Failure.retired }
            guard !copyActive else { throw Failure.copyActive }
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
