import Foundation

/// Persists a narrow part of the image recovery model before exposing a transition.
/// This is not the filesystem owner: its caller must supply an existing protected Keychain
/// key, prove snapshot creation and validation, and provide one serialized owner per lease.
/// It cannot authorize a socket, delete a file, or establish remote cleanup.
final class ImageRecoveryJournal {
    enum Failure: Error, Equatable { case retired }

    private let disk: ImageJournalDisk
    private let secret: Data
    private var bytes: Data
    private(set) var snapshot: ImageRecoveryLedger
    private(set) var retired = false

    /// Restart never revives a pending copy or old socket. The normalized record is made
    /// durable before this object returns; failure cannot be retried through this object.
    init(disk: ImageJournalDisk, secret: Data) throws {
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
        self.secret = secret
        self.bytes = stored
        self.snapshot = restored.ledger
    }

    /// A durable reservation comes before opening or writing the selected image copy.
    func reserveCopy() throws -> UUID {
        try transition { try $0.reserveCopy() }
    }

    /// The caller must open the new file exclusively and verify both the descriptor and its
    /// entry in the owned directory before recording the identity, and before writing data.
    func registerSnapshot(_ id: UUID, device: UInt64, inode: UInt64) throws {
        try transition { try $0.registerSnapshot(id, device: device, inode: inode) }
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

    private func transition<T>(_ apply: (inout ImageRecoveryLedger) throws -> T) throws -> T {
        guard !retired else { throw Failure.retired }
        var candidate = snapshot
        let result = try apply(&candidate)
        let next = try candidate.encodeJournal(secret: secret)
        do {
            try disk.replace(expected: bytes, with: next)
        } catch {
            retired = true
            throw error
        }
        bytes = next
        snapshot = candidate
        return result
    }
}
