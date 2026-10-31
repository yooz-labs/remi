import Foundation

/// One explicit begin for one already-prepared installation record. This owner cannot open a
/// picker, qualify a route, read image chunks, insert a draft reference, or replay an effect.
/// Those remaining boundaries must exist before an image feature may be exposed to the user.
@MainActor
final class ImageTransferOwner {
    enum Failure: Error { case invalidPreparedCopy }
    enum State: Equatable {
        case ready, beginning, unavailable, awaitingAcceptance, cancelled, notInvokedCleanupPending, uncertain
    }

    private let installation: ImageInstallationOwner
    private let connection: RemiConnection
    private let recordID: UUID
    private let beginMessage: ImageUploadBegin
    private let machineKey: Data
    private var flow: ImageUploadFlow
    private var ticket: ImageEffectTicket?
    private(set) var state: State = .ready

    init(installation: ImageInstallationOwner, connection: RemiConnection, recordID: UUID,
         begin: ImageUploadBegin, machineKey: Data, now: TimeInterval) throws {
        guard try installation.journal.matchesPreparedCopy(recordID, begin: begin, machineKey: machineKey) else {
            throw Failure.invalidPreparedCopy
        }
        self.flow = try ImageUploadFlow(begin: begin, now: now)
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
        do { try installation.journal.markPartialPossible(recordID) }
        catch {
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
            state = .notInvokedCleanupPending
        case .uncertain:
            state = .uncertain
        case .handedOff:
            state = state == .cancelled ? .uncertain : .awaitingAcceptance
        }
    }

    /// Synchronous retirement prevents a queued begin from entering after cancellation.
    func cancel() {
        guard state == .beginning, let ticket else { return }
        state = ticket.retire() == .noEffect ? .cancelled : .uncertain
    }
}
