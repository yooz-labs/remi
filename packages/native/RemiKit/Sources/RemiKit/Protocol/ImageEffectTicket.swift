import Foundation

/// One possible network effect in an image operation (#1313).
///
/// The transfer owner retires the ticket synchronously on cancellation or phase change. The
/// connection actor must enter it after any send-queue wait, immediately before invoking the
/// send on the separately verified concrete socket. Entry is the local linearization point:
/// cancellation after entry must be reported as possibly effective, even if sending later fails.
/// This ticket is not authentication, socket identity, a transport gate, or a sender by itself.
final class ImageEffectTicket: @unchecked Sendable {
    enum Retirement: Sendable, Equatable { case noEffect, effectPossible }
    private enum State { case pending, entered, retired(Retirement) }
    private let lock = NSLock()
    private var state: State = .pending

    /// Called once, at the final send boundary on the verified connection actor.
    func enter() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard case .pending = state else { return false }
        state = .entered
        return true
    }

    /// Idempotently prevents entry, or records that entry already made an effect possible.
    @discardableResult func retire() -> Retirement {
        lock.lock(); defer { lock.unlock() }
        switch state {
        case .pending:
            state = .retired(.noEffect)
            return .noEffect
        case .entered:
            state = .retired(.effectPossible)
            return .effectPossible
        case .retired(let result):
            return result
        }
    }
}
