import Foundation

/// One bounded staging attempt for one prepared installation record. It cannot open a picker,
/// qualify a route, validate media, insert a draft reference, or replay an effect. Those remaining
/// boundaries must exist before an image feature may be exposed to the user.
@MainActor
final class ImageTransferOwner {
    enum Failure: Error { case invalidPreparedCopy }
    enum State: Equatable {
        case ready, beginning, unavailable, awaitingAcceptance, awaitingChunk(offset: Int, count: Int)
        case sendingChunk, awaitingChunkAck, readyForComplete, completing, awaitingResult
        case staged(expiry: String), stagedCleanupPending(expiry: String)
        case refused(ImageUploadRefusalCode, remoteCleanupUnconfirmed: Bool)
        case cancelled, notInvokedCleanupPending, uncertain
    }

    private let installation: ImageInstallationOwner
    private let connection: RemiConnection
    private let recordID: UUID
    private let beginMessage: ImageUploadBegin
    private let machineKey: Data
    private var authority: ImageBeginAuthority?
    private var ticket: ImageEffectTicket?
    private var reader: ImageSnapshotReader?
    private(set) var state: State = .ready

    init(installation: ImageInstallationOwner, connection: RemiConnection, recordID: UUID,
         begin: ImageUploadBegin, machineKey: Data, now: TimeInterval) throws {
        guard try installation.journal.matchesPreparedCopy(recordID, begin: begin, machineKey: machineKey) else {
            throw Failure.invalidPreparedCopy
        }
        _ = try ImageUploadFlow(begin: begin, now: now)
        self.installation = installation
        self.connection = connection
        self.recordID = recordID
        self.beginMessage = begin
        self.machineKey = machineKey
    }

    /// The caller must have validated media and a stable owned upload reader. The actor's
    /// production authority gate remains closed until those and the secure route are proven.
    func begin() async {
        guard state == .ready else { return }
        state = .beginning
        let operation = ImageEffectTicket()
        ticket = operation
        let authority = await connection.imageBeginAuthority(for: beginMessage, machineKey: machineKey)
        guard state == .beginning else { ticket = nil; return }
        guard let authority else {
            _ = operation.retire()
            ticket = nil
            state = .unavailable
            return
        }
        self.authority = authority
        do {
            guard let digest = WireGuards.decodeBase64URL(beginMessage.digest) else { throw Failure.invalidPreparedCopy }
            reader = try installation.snapshots.openUploadReader(id: recordID, byteCount: beginMessage.byteLength, digest: digest)
            try installation.journal.markPartialPossible(recordID)
        }
        catch {
            reader?.close(); reader = nil
            _ = operation.retire()
            ticket = nil
            state = .notInvokedCleanupPending
            return
        }
        let result = await connection.sendImageBegin(beginMessage, authority: authority, ticket: operation)
        _ = operation.retire()
        ticket = nil
        switch result {
        case .notInvoked:
            reader?.close(); reader = nil
            state = .notInvokedCleanupPending
        case .uncertain:
            reader?.close(); reader = nil
            state = .uncertain
        case .handedOff:
            if state == .cancelled {
                reader?.close(); reader = nil
                state = .uncertain
            } else if state == .beginning {
                state = .awaitingAcceptance
                await refresh()
            }
        }
    }

    /// Queries actor-owned correlation on the original socket. This is a local state read;
    /// it sends nothing and cannot restore a lost connection or stale authority.
    func refresh() async {
        guard state == .awaitingAcceptance || state == .awaitingChunkAck || state == .awaitingResult,
              let authority else { return }
        let previous = state
        let progress = await connection.imageBeginProgress(authority: authority)
        guard state == previous else { return }
        switch progress {
        case .waiting: state = .awaitingAcceptance
        case .readyForChunk(let offset, let count, let expiry):
            do {
                try installation.journal.rememberPartialExpiry(recordID, expiry: expiry)
                state = .awaitingChunk(offset: offset, count: count)
            } catch {
                reader?.close(); reader = nil; state = .uncertain
            }
        case .waitingChunkAck: state = .awaitingChunkAck
        case .readyForComplete: state = .readyForComplete
        case .waitingResult: state = .awaitingResult
        case .staged(let expiry):
            do {
                try installation.journal.markStaged(recordID, expiry: expiry)
                do {
                    try installation.snapshots.clearAfterStaging(id: recordID)
                    state = .staged(expiry: expiry)
                } catch { state = .stagedCleanupPending(expiry: expiry) }
            } catch { state = .uncertain }
        case .refused(let code, let unconfirmed):
            reader?.close(); reader = nil
            state = .refused(code, remoteCleanupUnconfirmed: unconfirmed)
        case .uncertain, nil:
            reader?.close(); reader = nil
            state = .uncertain
        }
    }

    /// Read and send exactly one chunk; a failed or cancelled phase is never replayed.
    func sendNextChunk() async {
        guard case .awaitingChunk(let offset, let count) = state, let authority, let reader else { return }
        let data: Data
        do { data = try reader.read(offset: offset, count: count) }
        catch { self.reader = nil; state = .uncertain; return }
        state = .sendingChunk
        let operation = ImageEffectTicket()
        ticket = operation
        let result = await connection.sendImageChunk(data, authority: authority, ticket: operation)
        _ = operation.retire(); ticket = nil
        guard state == .sendingChunk else { return }
        switch result {
        case .handedOff:
            state = .awaitingChunkAck
            await refresh()
        case .notInvoked, .uncertain:
            reader.close(); self.reader = nil; state = .uncertain
        }
    }

    /// Hash verification and its durable staging boundary precede the complete effect.
    func complete() async {
        guard state == .readyForComplete, let authority, let reader else { return }
        do {
            try reader.finish()
            self.reader = nil
            try installation.journal.markStagingPossible(recordID)
        } catch {
            reader.close(); self.reader = nil; state = .uncertain; return
        }
        state = .completing
        let operation = ImageEffectTicket()
        ticket = operation
        let result = await connection.sendImageComplete(authority: authority, ticket: operation)
        _ = operation.retire(); ticket = nil
        guard state == .completing else { return }
        switch result {
        case .handedOff:
            state = .awaitingResult
            await refresh()
        case .notInvoked, .uncertain: state = .uncertain
        }
    }

    /// Synchronous retirement prevents a queued begin from entering after cancellation.
    func cancel() {
        if state == .beginning, let ticket {
            state = ticket.retire() == .noEffect ? .cancelled : .uncertain
            reader?.close(); reader = nil
        } else if (state == .sendingChunk || state == .completing), let ticket {
            _ = ticket.retire()
            reader?.close(); reader = nil
            state = .uncertain
        } else if state == .awaitingAcceptance || state == .awaitingChunkAck || state == .readyForComplete ||
                    state == .awaitingResult || isAwaitingChunk {
            // A cancel frame/receipt is not wired yet; remote partial cleanup is uncertain.
            reader?.close(); reader = nil
            state = .uncertain
        }
    }

    private var isAwaitingChunk: Bool {
        if case .awaitingChunk = state { return true }
        return false
    }
}
