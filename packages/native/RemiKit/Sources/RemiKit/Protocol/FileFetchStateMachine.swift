import CryptoKit
import Foundation

/// The client side of one `file_fetch_*` transfer (ADR 0045) as a pure value: no sockets, no
/// timers, no filesystem. A caller feeds it host messages and its own intents together with
/// the current monotonic time, and sends the actions it returns.
///
/// What it enforces, from the ADR:
/// - only the next chunk (`seq`) with the exact decoded size `min(32768, remaining)` advances
///   a transfer; a duplicate, stale or gapped chunk ends it as `sequence`, a wrong size or a
///   digest mismatch as `integrity`, and nothing is replayed or retried;
/// - the received byte count is cumulative and every read acknowledges all earlier bytes;
/// - the whole file is verified (exact length and SHA-256 against the accepted digest) before
///   `file_fetch_complete` is requested, and an unverified partial is never exposed;
/// - cancellation, failure and disconnection discard the buffered bytes;
/// - five minutes after the begin, or 30 seconds after the last valid progress once accepted,
///   the transfer ends. Time is the `now` argument, never a clock read here.
///
/// Locally verified bytes may still be saved when the host's cleanup result is lost or
/// refused (`hostSettled: false`); a host `file_fetch_result` is not a Save receipt.
///
/// Not decided here: which request a `file_fetch_refused` for a read or complete answers
/// (the machine does not track those request IDs), and `accepted.expiresAt` (a wall-clock
/// instant that a monotonic `now` cannot be compared with).
public struct FileFetchStateMachine: Sendable, Equatable {
    /// Seconds without valid progress, once accepted.
    public static let noProgressTimeout: TimeInterval = 30
    /// Seconds from the begin to the end of the transfer.
    public static let lifetime: TimeInterval = 300

    public enum Phase: Sendable, Equatable {
        /// Begin sent; waiting for `file_fetch_accepted`.
        case awaitingAcceptance
        /// Accepted; pulling chunks one read at a time.
        case receiving
        /// Every byte verified and `file_fetch_complete` requested; waiting for the host's result.
        case awaitingResult
        case finished(Outcome)
    }

    public enum Failure: Sendable, Equatable {
        /// A duplicate, stale or gapped chunk.
        case sequence
        /// A wrong chunk size, a length mismatch or a digest mismatch.
        case integrity
        case noProgress
        case lifetimeExpired
        case disconnected
        /// The accepted offer or a host message cannot be what the ADR allows.
        case protocolViolation
        /// The host refused the operation (it has already ended the transfer).
        case refused(FileFetchRefusalCode)
    }

    /// A file whose exact length and digest were checked locally.
    public struct VerifiedFile: Sendable, Equatable {
        /// Inert display and save-name data, never a filesystem path.
        public let fileName: String
        public let data: Data
    }

    public enum Outcome: Sendable, Equatable {
        /// `hostSettled` is false when the host's result never arrived or its cleanup failed.
        case verified(VerifiedFile, hostSettled: Bool)
        case failed(Failure)
        case cancelled
    }

    public enum Event: Sendable, Equatable {
        /// A message from the host. Client request types and unrelated messages are ignored.
        case message(FileFetchMessage)
        /// The person cancelled.
        case cancelRequested
        /// The connection dropped; a transfer never resumes or moves to another connection.
        case disconnected
        /// Time passed with nothing received.
        case tick
    }

    /// What the caller must send. IDs and timestamps are the caller's to generate.
    public enum Action: Sendable, Equatable {
        case sendRead(transferId: String, seq: Int, receivedBytes: Int)
        case sendComplete(transferId: String, receivedBytes: Int, digest: String)
        case sendCancel(beginId: String)
    }

    public let beginId: String
    public private(set) var phase: Phase = .awaitingAcceptance
    public private(set) var transferId: String?
    public private(set) var nextSequence = 0
    public private(set) var receivedBytes = 0

    private let startedAt: TimeInterval
    private var lastProgressAt: TimeInterval
    private var fileName = ""
    private var byteLength = 0
    private var digest = ""
    private var buffer = Data()

    /// `beginId` is the begin request's `id`; `now` is when it was sent.
    public init(beginId: String, now: TimeInterval) {
        self.beginId = beginId
        self.startedAt = now
        self.lastProgressAt = now
    }

    public var outcome: Outcome? {
        if case .finished(let outcome) = phase { return outcome }
        return nil
    }

    public var isFinished: Bool { outcome != nil }

    public mutating func handle(_ event: Event, at now: TimeInterval) -> [Action] {
        guard !isFinished else { return [] }  // late responses for a finished transfer are ignored
        if let actions = expireIfDue(at: now) { return actions }

        switch event {
        case .tick:
            return []
        case .cancelRequested:
            discard()
            phase = .finished(.cancelled)
            return [.sendCancel(beginId: beginId)]
        case .disconnected:
            if case .awaitingResult = phase { return settle(hostSettled: false) }
            return fail(.disconnected, cancel: false)
        case .message(let message):
            return handle(message, at: now)
        }
    }

    private mutating func handle(_ message: FileFetchMessage, at now: TimeInterval) -> [Action] {
        switch (phase, message) {
        case (.awaitingAcceptance, .accepted(let accepted)):
            guard WireGuards.same(accepted.requestId, beginId) else { return [] }
            guard WireGuards.decodeBase64URL(accepted.digest) != nil, (1...FileFetchLimits.fileBytes).contains(accepted.byteLength) else {
                return fail(.protocolViolation, cancel: true)
            }
            transferId = accepted.transferId
            fileName = accepted.fileName
            byteLength = accepted.byteLength
            digest = accepted.digest
            phase = .receiving
            lastProgressAt = now
            return [.sendRead(transferId: accepted.transferId, seq: 0, receivedBytes: 0)]

        case (.awaitingAcceptance, .refused(let refused)):
            guard refused.operation == .begin, WireGuards.same(refused.requestId, beginId) else { return [] }
            return fail(.refused(refused.code), cancel: false)

        case (.receiving, .chunk(let chunk)):
            guard let transferId, WireGuards.same(chunk.transferId, transferId) else { return [] }
            guard (0...FileFetchLimits.maxSequence).contains(chunk.seq), nextSequence <= FileFetchLimits.maxSequence,
                chunk.seq == nextSequence
            else { return fail(.sequence, cancel: true) }
            let expected = min(FileFetchLimits.chunkBytes, byteLength - receivedBytes)
            guard let bytes = chunk.bytes, bytes.count == expected else { return fail(.integrity, cancel: true) }
            buffer.append(bytes)
            receivedBytes += bytes.count
            nextSequence += 1
            lastProgressAt = now
            if receivedBytes < byteLength {
                return [.sendRead(transferId: transferId, seq: nextSequence, receivedBytes: receivedBytes)]
            }
            guard Data(SHA256.hash(data: buffer)) == WireGuards.decodeBase64URL(digest) else {
                return fail(.integrity, cancel: true)
            }
            phase = .awaitingResult
            return [.sendComplete(transferId: transferId, receivedBytes: receivedBytes, digest: digest)]

        case (.receiving, .refused(let refused)):
            guard refused.operation == .read else { return [] }
            return fail(.refused(refused.code), cancel: false)

        case (.awaitingResult, .result(let result)):
            guard let transferId, WireGuards.same(result.transferId, transferId) else { return [] }
            return settle(hostSettled: true)

        case (.awaitingResult, .refused(let refused)):
            guard refused.operation == .complete else { return [] }
            // The bytes were verified here; only the host's cleanup failed.
            if refused.code == .cleanupFailed { return settle(hostSettled: false) }
            return fail(.refused(refused.code), cancel: false)

        default:
            return []
        }
    }

    /// Ends the transfer if its deadline or progress window passed; nil when it did not.
    private mutating func expireIfDue(at now: TimeInterval) -> [Action]? {
        let lifetimeOver = now - startedAt >= Self.lifetime
        var stalled = false
        if case .awaitingAcceptance = phase {} else { stalled = now - lastProgressAt >= Self.noProgressTimeout }
        guard lifetimeOver || stalled else { return nil }
        if case .awaitingResult = phase { return settle(hostSettled: false) }
        return fail(lifetimeOver ? .lifetimeExpired : .noProgress, cancel: true)
    }

    private mutating func settle(hostSettled: Bool) -> [Action] {
        let file = VerifiedFile(fileName: fileName, data: buffer)
        buffer = Data()
        phase = .finished(.verified(file, hostSettled: hostSettled))
        return []
    }

    private mutating func fail(_ failure: Failure, cancel: Bool) -> [Action] {
        discard()
        phase = .finished(.failed(failure))
        return cancel ? [.sendCancel(beginId: beginId)] : []
    }

    private mutating func discard() { buffer = Data() }
}
