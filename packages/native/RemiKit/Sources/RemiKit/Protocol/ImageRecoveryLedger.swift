import CryptoKit
import Foundation

/// Privacy-preserving comparison keys for local recovery (#1313). These are not host
/// authority, transfer IDs, or proof that a previous socket can be reused.
struct ImageRecoveryFingerprint: Sendable, Equatable {
    private let scope: Data
    private let image: Data

    enum Failure: Error { case invalidIdentity }

    static func make(secret: Data, machineKey: Data, sessionID: String,
                     binding: AttachedBinding, imageDigest: Data) throws -> Self {
        guard secret.count == 32, machineKey.count == 32,
              !ClientIdentity.isSmallOrderPublicKey(machineKey), WireGuards.isUUID(sessionID),
              binding.harness == .claude, WireGuards.isHarnessSessionId(binding.harnessSessionId),
              imageDigest.count == 32 else { throw Failure.invalidIdentity }
        let key = SymmetricKey(data: secret)
        let scopeInput = tuple([Data("remi-image-scope-v1".utf8), machineKey, Data(sessionID.utf8),
                                Data(binding.harness.rawValue.utf8), Data(binding.harnessSessionId.utf8)])
        let imageInput = tuple([Data("remi-image-digest-v1".utf8), imageDigest])
        return Self(scope: Data(HMAC<SHA256>.authenticationCode(for: scopeInput, using: key)),
                    image: Data(HMAC<SHA256>.authenticationCode(for: imageInput, using: key)))
    }

    private static func tuple(_ fields: [Data]) -> Data {
        var result = Data()
        for field in fields {
            var count = UInt32(field.count).bigEndian
            withUnsafeBytes(of: &count) { result.append(contentsOf: $0) }
            result.append(field)
        }
        return result
    }
}

/// Bounded recovery *decisions*, with no storage, socket, clock, or deletion effects (#1313).
///
/// This model is not itself a durable journal. A future owner must atomically persist every
/// transition before its effect, hold the installation-wide file lock, and call the deletion
/// receipt only after descriptor-confined deletion and directory sync actually succeeded.
/// Never expose it as an image feature until those boundaries and the secure route are proven.
struct ImageRecoveryLedger: Sendable {
    static let maximumRecords = 32

    enum Failure: Error, Equatable {
        case invalidTransition
        case notFound
        case localSlotBusy
        case localSnapshotStillPresent
        case recordCapacity
        case sameImageInsertionUncertain
        case insertionMayHaveOccurred
        case consentRequired
        case cleanupNotRequested
        case identityCollision
    }

    enum Exposure: Sendable, Equatable {
        case prepared
        case partialPossible
        case stagingPossible
        case staged(expiry: String)
        case insertionPossible(expiry: String)
    }

    struct Record: Sendable, Equatable {
        let id: UUID
        let fingerprint: ImageRecoveryFingerprint
        fileprivate(set) var exposure: Exposure = .prepared
        fileprivate(set) var localSnapshotPresent = true
        fileprivate(set) var cleanupRequested = false
        fileprivate(set) var remoteCancellationConfirmed = false
    }

    private(set) var records: [Record] = []
    private(set) var localSnapshotID: UUID?
    /// A user explicitly compacted one or more no-insertion records whose host cleanup was
    /// unconfirmed. This warning is not a host quota, a count, or a deletion receipt.
    private(set) var hasAggregateUnconfirmedCleanup = false

    mutating func reserve(_ fingerprint: ImageRecoveryFingerprint) throws -> UUID {
        guard localSnapshotID == nil else { throw Failure.localSlotBusy }
        guard records.count < Self.maximumRecords else { throw Failure.recordCapacity }
        guard !records.contains(where: { record in
            if case .insertionPossible = record.exposure { return record.fingerprint == fingerprint }
            return false
        }) else { throw Failure.sameImageInsertionUncertain }
        for _ in 0..<4 {
            let id = UUID()
            guard !records.contains(where: { $0.id == id }) else { continue }
            records.append(Record(id: id, fingerprint: fingerprint))
            localSnapshotID = id
            return id
        }
        throw Failure.identityCollision
    }

    /// Persist this conservative transition before the begin effect may enter.
    mutating func markPartialPossible(_ id: UUID) throws {
        let index = try recordIndex(id)
        guard records[index].exposure == .prepared, records[index].localSnapshotPresent else { throw Failure.invalidTransition }
        records[index].exposure = .partialPossible
    }

    /// Persist before the complete effect may enter; host staging then may be unknown.
    mutating func markStagingPossible(_ id: UUID) throws {
        let index = try recordIndex(id)
        guard records[index].exposure == .partialPossible, records[index].localSnapshotPresent else { throw Failure.invalidTransition }
        records[index].exposure = .stagingPossible
    }

    /// Only the owner of a strictly correlated, validated staging result may apply this.
    mutating func markStaged(_ id: UUID, expiry: String) throws {
        let index = try recordIndex(id)
        guard records[index].exposure == .stagingPossible, WireGuards.isTimestamp(expiry) else { throw Failure.invalidTransition }
        records[index].exposure = .staged(expiry: expiry)
    }

    /// Normal local cleanup after verified host staging. It makes no host-deletion claim.
    mutating func requestStagedLocalCleanup(_ id: UUID) throws {
        let index = try recordIndex(id)
        guard case .staged = records[index].exposure, records[index].localSnapshotPresent else { throw Failure.invalidTransition }
        records[index].cleanupRequested = true
    }

    /// Persist before a separately authorized insertion effect may enter. Local snapshot
    /// cleanup must have completed first; a later uncertain insertion keeps only its fence.
    mutating func markInsertionPossible(_ id: UUID) throws {
        let index = try recordIndex(id)
        guard case .staged(let expiry) = records[index].exposure else { throw Failure.invalidTransition }
        guard !records[index].localSnapshotPresent else { throw Failure.localSnapshotStillPresent }
        records[index].exposure = .insertionPossible(expiry: expiry)
    }

    /// Explicit per-case local abandonment is allowed only before insertion could occur.
    mutating func requestLocalAbandonment(_ id: UUID, confirmed: Bool) throws {
        guard confirmed else { throw Failure.consentRequired }
        let index = try recordIndex(id)
        if case .insertionPossible = records[index].exposure { throw Failure.insertionMayHaveOccurred }
        guard records[index].localSnapshotPresent else { throw Failure.invalidTransition }
        records[index].cleanupRequested = true
    }

    /// The filesystem owner must call this only after verifying exact owned-file removal and
    /// directory sync. This value type cannot itself verify or perform that deletion.
    mutating func confirmOwnedSnapshotDeleted(_ id: UUID) throws {
        let index = try recordIndex(id)
        guard records[index].cleanupRequested, records[index].localSnapshotPresent,
              localSnapshotID == id else { throw Failure.cleanupNotRequested }
        records[index].localSnapshotPresent = false
        records[index].cleanupRequested = false
        localSnapshotID = nil
        if records[index].exposure == .prepared || records[index].remoteCancellationConfirmed {
            records.remove(at: index)
        }
    }

    /// Only an exactly correlated host cancel result is a remote deletion receipt. A timeout,
    /// refusal, local expiry or process death must never call this operation.
    mutating func confirmRemoteCancellation(_ id: UUID) throws {
        let index = try recordIndex(id)
        if case .insertionPossible = records[index].exposure { throw Failure.insertionMayHaveOccurred }
        guard records[index].exposure == .partialPossible || records[index].exposure == .stagingPossible else {
            throw Failure.invalidTransition
        }
        records[index].remoteCancellationConfirmed = true
        if !records[index].localSnapshotPresent { records.remove(at: index) }
    }

    /// Free one non-insertion record only after explicit per-case acknowledgement; retain an
    /// aggregate warning because compaction says nothing about remote deletion or quota.
    mutating func compactNoInsertion(_ id: UUID, confirmed: Bool) throws {
        guard confirmed else { throw Failure.consentRequired }
        let index = try recordIndex(id)
        if case .insertionPossible = records[index].exposure { throw Failure.insertionMayHaveOccurred }
        guard !records[index].localSnapshotPresent else { throw Failure.localSnapshotStillPresent }
        if records[index].exposure != .prepared && !records[index].remoteCancellationConfirmed {
            hasAggregateUnconfirmedCleanup = true
        }
        records.remove(at: index)
    }

    private func recordIndex(_ id: UUID) throws -> Int {
        guard let index = records.firstIndex(where: { $0.id == id }) else { throw Failure.notFound }
        return index
    }
}
