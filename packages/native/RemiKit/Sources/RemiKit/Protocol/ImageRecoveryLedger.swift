import CryptoKit
import Foundation

/// Privacy-preserving comparison keys for local recovery (#1313). These are not host
/// authority, transfer IDs, or proof that a previous socket can be reused.
struct ImageRecoveryFingerprint: Sendable, Equatable {
    fileprivate let scope: Data
    fileprivate let image: Data

    fileprivate init(scope: Data, image: Data) { self.scope = scope; self.image = image }

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
        case stagedActionOutstanding
        case insertionInFlight
        case sameImageAlreadyInserted
        case recordCapacity
        case sameImageInsertionUncertain
        case insertionMayHaveOccurred
        case consentRequired
        case cleanupNotRequested
        case identityCollision
    }

    enum Exposure: Sendable, Equatable {
        case copyReserved
        case copyOrphaned
        case prepared
        /// A prior process may have stopped before finishing the private snapshot.
        case preparedOrphaned
        case partialPossible
        case stagingPossible
        /// The prior process may have begun a transfer, but its socket is gone.
        case partialOrphaned
        /// Completion may have staged an artifact before the prior process ended.
        case stagingOrphaned
        case staged(expiry: String)
        /// A staged artifact survived this process, but its original socket did not.
        case stagedOrphaned(expiry: String)
        case insertionInFlight(expiry: String)
        case insertionUncertain(expiry: String)
        /// The host confirmed a reference write, not Claude consumption.
        case insertionConfirmed(expiry: String)
        /// A pre-effect refusal cannot be retried until the original socket is revalidated.
        case insertionRefusedAwaitingOrigin(expiry: String)
    }

    struct Record: Sendable, Equatable {
        let id: UUID
        fileprivate(set) var fingerprint: ImageRecoveryFingerprint?
        fileprivate(set) var exposure: Exposure = .prepared
        fileprivate(set) var localSnapshotPresent = true
        fileprivate(set) var cleanupRequested = false
        fileprivate(set) var remoteCancellationConfirmed = false
        fileprivate(set) var knownPartialExpiry: String?
    }

    private(set) var records: [Record] = []
    private(set) var localSnapshotID: UUID?
    /// A user explicitly compacted one or more no-insertion records whose host cleanup was
    /// unconfirmed. This warning is not a host quota, a count, or a deletion receipt.
    private(set) var hasAggregateUnconfirmedCleanup = false

    mutating func reserve(_ fingerprint: ImageRecoveryFingerprint) throws -> UUID {
        try checkFingerprint(fingerprint)
        let id = try reserveCopy()
        try finishCopy(id, fingerprint: fingerprint)
        return id
    }

    /// Reserve a durable local slot before copying any bytes or knowing the image digest.
    mutating func reserveCopy() throws -> UUID {
        guard localSnapshotID == nil else { throw Failure.localSlotBusy }
        guard records.count < Self.maximumRecords else { throw Failure.recordCapacity }
        guard !records.contains(where: {
            switch $0.exposure {
            case .staged, .stagedOrphaned, .insertionRefusedAwaitingOrigin: true
            default: false
            }
        }) else {
            throw Failure.stagedActionOutstanding
        }
        guard !records.contains(where: { if case .insertionInFlight = $0.exposure { return true }; return false }) else {
            throw Failure.insertionInFlight
        }
        for _ in 0..<4 {
            let id = UUID()
            guard !records.contains(where: { $0.id == id }) else { continue }
            records.append(Record(id: id, fingerprint: nil, exposure: .copyReserved))
            localSnapshotID = id
            return id
        }
        throw Failure.identityCollision
    }

    /// Called only after a bounded, durable snapshot has been hashed and validated.
    mutating func finishCopy(_ id: UUID, fingerprint: ImageRecoveryFingerprint) throws {
        let index = try recordIndex(id)
        guard records[index].exposure == .copyReserved, records[index].localSnapshotPresent else { throw Failure.invalidTransition }
        try checkFingerprint(fingerprint)
        records[index].fingerprint = fingerprint
        records[index].exposure = .prepared
    }

    private func checkFingerprint(_ fingerprint: ImageRecoveryFingerprint) throws {
        guard !records.contains(where: { record in
            if case .insertionUncertain = record.exposure { return record.fingerprint == fingerprint }
            return false
        }) else { throw Failure.sameImageInsertionUncertain }
        guard !records.contains(where: { record in
            if case .insertionConfirmed = record.exposure { return record.fingerprint == fingerprint }
            return false
        }) else { throw Failure.sameImageAlreadyInserted }
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

    /// Keep the original host partial deadline once received; never extend or replace it.
    mutating func rememberPartialExpiry(_ id: UUID, expiry: String) throws {
        let index = try recordIndex(id)
        guard records[index].exposure == .partialPossible || records[index].exposure == .stagingPossible,
              WireGuards.isTimestamp(expiry),
              records[index].knownPartialExpiry.map({ WireGuards.same($0, expiry) }) ?? true else {
            throw Failure.invalidTransition
        }
        records[index].knownPartialExpiry = expiry
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
        switch records[index].exposure {
        case .staged, .stagedOrphaned: break
        default: throw Failure.invalidTransition
        }
        guard records[index].localSnapshotPresent else { throw Failure.invalidTransition }
        records[index].cleanupRequested = true
    }

    /// Persist before a separately authorized insertion effect may enter. Local snapshot
    /// cleanup must have completed first; a later uncertain insertion keeps only its fence.
    mutating func markInsertionPossible(_ id: UUID) throws {
        let index = try recordIndex(id)
        guard case .staged(let expiry) = records[index].exposure else { throw Failure.invalidTransition }
        guard !records[index].localSnapshotPresent else { throw Failure.localSnapshotStillPresent }
        records[index].exposure = .insertionInFlight(expiry: expiry)
    }

    /// A lost response or process restart cannot prove whether the entered effect occurred.
    /// Persist this fence before allowing a different explicit selection to start.
    mutating func markInsertionUncertain(_ id: UUID) throws {
        let index = try recordIndex(id)
        guard case .insertionInFlight(let expiry) = records[index].exposure else { throw Failure.invalidTransition }
        records[index].exposure = .insertionUncertain(expiry: expiry)
    }

    /// Only a correlated result from the original socket may confirm this reference write.
    mutating func confirmInsertion(_ id: UUID) throws {
        let index = try recordIndex(id)
        guard case .insertionInFlight(let expiry) = records[index].exposure else { throw Failure.invalidTransition }
        records[index].exposure = .insertionConfirmed(expiry: expiry)
    }

    /// A correlated pre-effect refusal proves no write. Retrying is unavailable here: the
    /// future connection owner must first revalidate the original socket and attachment.
    mutating func recordInsertionRefusal(_ id: UUID) throws {
        let index = try recordIndex(id)
        guard case .insertionInFlight(let expiry) = records[index].exposure else { throw Failure.invalidTransition }
        records[index].exposure = .insertionRefusedAwaitingOrigin(expiry: expiry)
    }

    /// Explicit per-case local abandonment is allowed only before insertion could occur.
    mutating func requestLocalAbandonment(_ id: UUID, confirmed: Bool) throws {
        guard confirmed else { throw Failure.consentRequired }
        let index = try recordIndex(id)
        if records[index].exposure.hasPossibleInsertion { throw Failure.insertionMayHaveOccurred }
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
        if records[index].exposure == .copyReserved || records[index].exposure == .copyOrphaned ||
            records[index].exposure == .prepared || records[index].exposure == .preparedOrphaned || records[index].remoteCancellationConfirmed {
            records.remove(at: index)
        }
    }

    /// Only an exactly correlated host cancel result is a remote deletion receipt. A timeout,
    /// refusal, local expiry or process death must never call this operation.
    mutating func confirmRemoteCancellation(_ id: UUID) throws {
        let index = try recordIndex(id)
        if records[index].exposure.hasPossibleInsertion { throw Failure.insertionMayHaveOccurred }
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
        if records[index].exposure.hasPossibleInsertion { throw Failure.insertionMayHaveOccurred }
        guard !records[index].localSnapshotPresent else { throw Failure.localSnapshotStillPresent }
        if records[index].exposure != .prepared && !records[index].remoteCancellationConfirmed {
            hasAggregateUnconfirmedCleanup = true
        }
        records.remove(at: index)
    }

    /// The person acknowledges a known reference write and its still-unconfirmed host cleanup.
    /// This is never available for an uncertain insertion.
    mutating func compactConfirmedInsertion(_ id: UUID, confirmed: Bool) throws {
        guard confirmed else { throw Failure.consentRequired }
        let index = try recordIndex(id)
        guard case .insertionConfirmed = records[index].exposure,
              !records[index].localSnapshotPresent else { throw Failure.invalidTransition }
        hasAggregateUnconfirmedCleanup = true
        records.remove(at: index)
    }

    private func recordIndex(_ id: UUID) throws -> Int {
        guard let index = records.firstIndex(where: { $0.id == id }) else { throw Failure.notFound }
        return index
    }

    /// Strict authenticated bytes only; the caller still owns atomic file replacement, fsync,
    /// protection, backup exclusion and the per-installation lock. Never create a new key when
    /// an existing journal cannot be authenticated.
    func encodeJournal(secret: Data) throws -> Data {
        guard secret.count == 32 else { throw WireFrameError.invalid("key") }
        let entries = records.map { record -> WireJSON in
            let (name, expiry) = Self.encodeExposure(record.exposure)
            return Self.object([
                ("id", .string(record.id.uuidString.lowercased())),
                ("scope", record.fingerprint.map { .string(WireGuards.encodeBase64URL($0.scope)) } ?? .null),
                ("image", record.fingerprint.map { .string(WireGuards.encodeBase64URL($0.image)) } ?? .null),
                ("exposure", .string(name)), ("expiry", expiry.map(WireJSON.string) ?? .null),
                ("partialExpiry", record.knownPartialExpiry.map(WireJSON.string) ?? .null),
                ("local", .bool(record.localSnapshotPresent)), ("cleanup", .bool(record.cleanupRequested)),
                ("remoteCancelled", .bool(record.remoteCancellationConfirmed)),
            ])
        }
        let payload = Self.object([("version", .number(1)), ("aggregate", .bool(hasAggregateUnconfirmedCleanup)),
                                   ("records", .array(entries))])
        let authenticated = Data(payload.serialized().utf8)
        let tag = HMAC<SHA256>.authenticationCode(for: authenticated, using: SymmetricKey(data: secret))
        let root = Self.object([("payload", payload), ("mac", .string(WireGuards.encodeBase64URL(Data(tag))))])
        let result = Data(root.serialized().utf8)
        guard result.count <= Self.journalBytes else { throw WireFrameError.oversize }
        return result
    }

    struct Restored: Sendable {
        let ledger: ImageRecoveryLedger
        /// The normalized journal must be durably rewritten before the caller admits any work.
        let needsRewrite: Bool
    }

    /// Decode only at process startup with the existing installation key. In-flight insertion
    /// becomes uncertain and staged/live-refused state loses its socket authority. A fresh
    /// authenticated journal must be saved after normalization before any selection or effect.
    static func restoreJournal(_ data: Data, secret: Data) throws -> Restored {
        guard secret.count == 32 else { throw WireFrameError.invalid("key") }
        let root = try WireFields(WireJSON.parse(data, maxBytes: journalBytes, maxNodes: 512), keys: ["payload", "mac"])
        let payload = try root.raw("payload")
        let macText = try root.encoded("mac", bytes: 32...32)
        guard let mac = WireGuards.decodeBase64URL(macText),
              HMAC<SHA256>.isValidAuthenticationCode(mac, authenticating: Data(payload.serialized().utf8),
                                                     using: SymmetricKey(data: secret)) else {
            throw WireFrameError.invalid("mac")
        }
        let fields = try WireFields(payload, keys: ["version", "aggregate", "records"])
        _ = try fields.integer("version", in: 1...1)
        let aggregate = try bool(fields, "aggregate")
        guard case .array(let rawRecords) = try fields.raw("records"), rawRecords.count <= maximumRecords else {
            throw WireFrameError.invalid("records")
        }
        var ledger = ImageRecoveryLedger()
        ledger.hasAggregateUnconfirmedCleanup = aggregate
        var ids = Set<UUID>()
        var needsRewrite = false
        for raw in rawRecords {
            let entry = try WireFields(raw, keys: ["id", "scope", "image", "exposure", "expiry", "partialExpiry",
                                                   "local", "cleanup", "remoteCancelled"])
            let textID = try entry.uuid4("id")
            guard let id = UUID(uuidString: textID), ids.insert(id).inserted else {
                throw WireFrameError.invalid("record")
            }
            let fingerprint: ImageRecoveryFingerprint?
            if case .null = try entry.raw("scope"), case .null = try entry.raw("image") {
                fingerprint = nil
            } else {
                guard let scope = WireGuards.decodeBase64URL(try entry.encoded("scope", bytes: 32...32)),
                      let image = WireGuards.decodeBase64URL(try entry.encoded("image", bytes: 32...32)) else {
                    throw WireFrameError.invalid("fingerprint")
                }
                fingerprint = ImageRecoveryFingerprint(scope: scope, image: image)
            }
            let name = try entry.string("exposure")
            let expiry = try optionalTimestamp(entry, "expiry")
            let partialExpiry = try optionalTimestamp(entry, "partialExpiry")
            let local = try bool(entry, "local")
            let cleanup = try bool(entry, "cleanup")
            let remoteCancelled = try bool(entry, "remoteCancelled")
            var exposure = try decodeExposure(name, expiry: expiry)
            guard validRecord(exposure: exposure, fingerprint: fingerprint, partialExpiry: partialExpiry, local: local,
                              cleanup: cleanup, remoteCancelled: remoteCancelled) else {
                throw WireFrameError.invalid("record")
            }
            switch exposure {
            case .copyReserved:
                exposure = .copyOrphaned; needsRewrite = true
            case .prepared:
                exposure = .preparedOrphaned; needsRewrite = true
            case .partialPossible:
                exposure = .partialOrphaned; needsRewrite = true
            case .stagingPossible:
                exposure = .stagingOrphaned; needsRewrite = true
            case .staged(let value), .insertionRefusedAwaitingOrigin(let value):
                exposure = .stagedOrphaned(expiry: value); needsRewrite = true
            case .insertionInFlight(let value):
                exposure = .insertionUncertain(expiry: value); needsRewrite = true
            default: break
            }
            if local {
                guard ledger.localSnapshotID == nil else { throw WireFrameError.invalid("local") }
                ledger.localSnapshotID = id
            }
            ledger.records.append(Record(id: id, fingerprint: fingerprint,
                exposure: exposure, localSnapshotPresent: local, cleanupRequested: cleanup,
                remoteCancellationConfirmed: remoteCancelled, knownPartialExpiry: partialExpiry))
        }
        return Restored(ledger: ledger, needsRewrite: needsRewrite)
    }

    private static let journalBytes = 16_384

    private static func object(_ pairs: [(String, WireJSON)]) -> WireJSON {
        .object(WireObject(members: pairs.map { .init(key: $0.0, value: $0.1) }))
    }

    private static func bool(_ fields: WireFields, _ name: String) throws -> Bool {
        guard case .bool(let value) = try fields.raw(name) else { throw WireFrameError.invalid(name) }
        return value
    }

    private static func optionalTimestamp(_ fields: WireFields, _ name: String) throws -> String? {
        switch try fields.raw(name) {
        case .null: return nil
        case .string(let value) where WireGuards.isTimestamp(value): return value
        default: throw WireFrameError.invalid(name)
        }
    }

    private static func encodeExposure(_ exposure: Exposure) -> (String, String?) {
        switch exposure {
        case .copyReserved: ("copy_reserved", nil)
        case .copyOrphaned: ("copy_orphaned", nil)
        case .prepared: ("prepared", nil)
        case .preparedOrphaned: ("prepared_orphaned", nil)
        case .partialPossible: ("partial", nil)
        case .stagingPossible: ("staging", nil)
        case .partialOrphaned: ("partial_orphaned", nil)
        case .stagingOrphaned: ("staging_orphaned", nil)
        case .staged(let expiry): ("staged", expiry)
        case .stagedOrphaned(let expiry): ("staged_orphaned", expiry)
        case .insertionInFlight(let expiry): ("insertion_in_flight", expiry)
        case .insertionUncertain(let expiry): ("insertion_uncertain", expiry)
        case .insertionConfirmed(let expiry): ("insertion_confirmed", expiry)
        case .insertionRefusedAwaitingOrigin(let expiry): ("insertion_refused", expiry)
        }
    }

    private static func decodeExposure(_ name: String, expiry: String?) throws -> Exposure {
        switch name {
        case "copy_reserved" where expiry == nil: .copyReserved
        case "copy_orphaned" where expiry == nil: .copyOrphaned
        case "prepared" where expiry == nil: .prepared
        case "prepared_orphaned" where expiry == nil: .preparedOrphaned
        case "partial" where expiry == nil: .partialPossible
        case "staging" where expiry == nil: .stagingPossible
        case "partial_orphaned" where expiry == nil: .partialOrphaned
        case "staging_orphaned" where expiry == nil: .stagingOrphaned
        case "staged": try exposureWithExpiry(expiry, build: Exposure.staged)
        case "staged_orphaned": try exposureWithExpiry(expiry, build: Exposure.stagedOrphaned)
        case "insertion_in_flight": try exposureWithExpiry(expiry, build: Exposure.insertionInFlight)
        case "insertion_uncertain": try exposureWithExpiry(expiry, build: Exposure.insertionUncertain)
        case "insertion_confirmed": try exposureWithExpiry(expiry, build: Exposure.insertionConfirmed)
        case "insertion_refused": try exposureWithExpiry(expiry, build: Exposure.insertionRefusedAwaitingOrigin)
        default: throw WireFrameError.invalid("exposure")
        }
    }

    private static func exposureWithExpiry(_ expiry: String?, build: (String) -> Exposure) throws -> Exposure {
        guard let expiry else { throw WireFrameError.invalid("expiry") }
        return build(expiry)
    }

    private static func validRecord(exposure: Exposure, fingerprint: ImageRecoveryFingerprint?, partialExpiry: String?, local: Bool,
                                    cleanup: Bool, remoteCancelled: Bool) -> Bool {
        if cleanup && !local { return false }
        switch exposure {
        case .copyReserved, .copyOrphaned:
            return fingerprint == nil && local && !remoteCancelled && partialExpiry == nil
        default:
            guard fingerprint != nil else { return false }
        }
        if remoteCancelled {
            guard local, (exposure == .partialPossible || exposure == .stagingPossible ||
                          exposure == .partialOrphaned || exposure == .stagingOrphaned) else { return false }
        }
        switch exposure {
        case .copyReserved, .copyOrphaned: return false // handled above
        case .prepared, .preparedOrphaned: return local && !remoteCancelled && partialExpiry == nil
        case .partialPossible, .stagingPossible, .partialOrphaned, .stagingOrphaned: return true
        case .staged, .stagedOrphaned: return !remoteCancelled
        case .insertionInFlight, .insertionUncertain, .insertionConfirmed, .insertionRefusedAwaitingOrigin:
            return !local && !cleanup && !remoteCancelled
        }
    }
}

private extension ImageRecoveryLedger.Exposure {
    var hasPossibleInsertion: Bool {
        switch self {
        case .insertionInFlight, .insertionUncertain, .insertionConfirmed: true
        default: false
        }
    }
}
