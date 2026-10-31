import Foundation

/// Correlates one ADR 0041/0042 upload and explicit insertion (#1313).
///
/// This value owns neither a socket nor a file and grants no transfer authority. Its caller
/// must read from one owned snapshot and fence every returned action to the original verified
/// socket, profile and binding. A connection loss or timeout never replays an effect.
struct ImageUploadFlow: Sendable {
    static let operationTimeout: TimeInterval = 15
    static let uploadLifetime: TimeInterval = 300
    static let stagedLifetime: TimeInterval = 86_400
    /// The full 320-chunk transfer fits, with bounded room for explicit insertion attempts.
    static let maxRequestIDs = 512

    enum Uncertainty: Equatable, Sendable {
        /// A partial may remain on the host until cancellation or partial expiry.
        case partialCleanup
        /// Completion may have staged an artifact; its exact expiry is unknown.
        case stagedRetention
        /// The insertion may have written a reference; never repeat it automatically.
        case insertion
    }

    enum Status: Equatable, Sendable {
        case awaitingAcceptance
        case awaitingChunkData(offset: Int, count: Int)
        case awaitingChunkAck(sent: Int, total: Int)
        case awaitingResult
        case cancellationPending
        case awaitingCancellation
        case cancelled
        case staged(expiry: String)
        case awaitingInsertion(expiry: String)
        case inserted(expiry: String)
        /// The terminal draft can still contain a reference that no longer has an image.
        case insertedExpired(expiry: String)
        case expired
        case refused(ImageUploadRefusalCode, remoteCleanupUnconfirmed: Bool)
        case insertionRefused(ImageInsertionRefusalCode, expiry: String)
        /// The host artifact can still exist until the shown original expiry.
        case requestLimit(expiry: String)
        case uncertain(Uncertainty)
    }

    enum Action: Equatable, Sendable {
        /// Read this range from the owned copy. The transfer owner must establish stable bytes
        /// across validation and transfer; a matching size and timestamp alone cannot do that.
        case read(offset: Int, count: Int)
        case send(ImageUploadMessage)
    }

    private let begin: ImageUploadBegin
    private let startedAt: TimeInterval
    private var lastObservedAt: TimeInterval
    private var operationDeadline: TimeInterval
    private var partialDeadline: TimeInterval?
    private var requestID: String
    private var usedRequestIDs: Set<String>
    private var transferID: String?
    private var artifactID: String?
    private var artifactDeadline: TimeInterval?
    private var completeRequestID: String?
    private var stagedWhileCancelling: ImageUploadResult?
    private var sentBytes = 0
    private var sequence = 0
    private(set) var status: Status = .awaitingAcceptance
    /// Original host deadlines, when actually received. Unknown is never fabricated.
    private(set) var knownPartialExpiry: String?
    private(set) var knownStagedExpiry: String?

    init(begin: ImageUploadBegin, now: TimeInterval) throws {
        guard now.isFinite, begin.binding.harness == .claude,
              WireGuards.isHarnessSessionId(begin.binding.harnessSessionId),
              (1...ImageStagingLimits.imageBytes).contains(begin.byteLength),
              WireGuards.decodeBase64URL(begin.digest)?.count == 32 else {
            throw WireFrameError.invalid("begin")
        }
        _ = try ImageUploadMessage.begin(begin).encodedFrame()
        self.begin = begin
        self.startedAt = now
        self.lastObservedAt = now
        self.operationDeadline = now + Self.operationTimeout
        self.requestID = begin.header.id
        self.usedRequestIDs = [begin.header.id]
    }

    mutating func receive(_ message: ImageUploadMessage, now: TimeInterval,
                          nextID: () -> String, timestamp: String) -> [Action] {
        guard live(at: now) else { return [] }
        switch message {
        case .accepted(let response): return accept(response, now: now, nextID: nextID, timestamp: timestamp)
        case .chunkAck(let response): return acknowledge(response, now: now, nextID: nextID, timestamp: timestamp)
        case .result(let response): return complete(response, now: now)
        case .cancelResult(let response): return cancelled(response)
        case .refused(let response): return refuse(response)
        default: return []
        }
    }

    mutating func supplyChunk(_ data: Data, requestID: String, timestamp: String, now: TimeInterval) -> ImageUploadMessage? {
        guard live(at: now), case .awaitingChunkData(let offset, let count) = status,
              let transferID else { return nil }
        guard data.count == count, let header = claimHeader(id: requestID, timestamp: timestamp) else {
            status = .uncertain(.partialCleanup)
            return nil
        }
        let frame = ImageUploadMessage.chunk(ImageUploadChunk(header: header, transferId: transferID,
            seq: sequence, data: WireGuards.encodeBase64URL(data)))
        guard (try? frame.encodedFrame()) != nil else { status = .uncertain(.partialCleanup); return nil }
        self.requestID = requestID
        operationDeadline = now + Self.operationTimeout
        status = .awaitingChunkAck(sent: offset, total: begin.byteLength)
        return frame
    }

    /// A cancel is not a cleanup receipt. Before acceptance, wait only for the original
    /// acceptance; if it is lost, the UI reports uncertain remote partial cleanup.
    mutating func cancel(requestID: String, timestamp: String, now: TimeInterval) -> ImageUploadMessage? {
        guard live(at: now) else { return nil }
        switch status {
        case .awaitingAcceptance:
            status = .cancellationPending
            return nil
        case .awaitingChunkData, .awaitingChunkAck, .awaitingResult:
            return beginCancellation(requestID: requestID, timestamp: timestamp, now: now)
        default:
            return nil
        }
    }

    mutating func addToDraft(requestID: String, timestamp: String, now: TimeInterval) -> ImageInsertionMessage? {
        guard live(at: now), let artifactID else { return nil }
        let expiry: String
        switch status {
        case .staged(let value), .insertionRefused(_, let value): expiry = value
        default: return nil
        }
        guard usedRequestIDs.count < Self.maxRequestIDs else { status = .requestLimit(expiry: expiry); return nil }
        guard let header = claimHeader(id: requestID, timestamp: timestamp) else { return nil }
        let frame = ImageInsertionMessage.request(ImageInsertRequest(header: header, binding: begin.binding,
                                                                     artifactId: artifactID))
        guard (try? frame.encodedFrame()) != nil else { return nil }
        self.requestID = requestID
        operationDeadline = now + Self.operationTimeout
        status = .awaitingInsertion(expiry: expiry)
        return frame
    }

    mutating func receiveInsertion(_ message: ImageInsertionMessage, now: TimeInterval) {
        guard live(at: now), case .awaitingInsertion(let expiry) = status, case .result(let response) = message,
              same(response.header.sessionId, begin.header.sessionId), same(response.requestId, requestID) else { return }
        switch response.outcome {
        case .inserted:
            if let artifactDeadline, now >= artifactDeadline { status = .insertedExpired(expiry: expiry) }
            else { status = .inserted(expiry: expiry) }
        case .uncertain: status = .uncertain(.insertion)
        case .refused(let code): status = .insertionRefused(code, expiry: expiry)
        }
    }

    mutating func tick(now: TimeInterval) { _ = live(at: now) }

    /// Once a socket is lost, neither upload nor insertion can migrate to its replacement.
    mutating func disconnected() {
        switch status {
        case .awaitingAcceptance, .awaitingChunkData, .awaitingChunkAck, .cancellationPending:
            status = .uncertain(.partialCleanup)
        case .awaitingResult, .awaitingCancellation:
            status = .uncertain(completeRequestID == nil ? .partialCleanup : .stagedRetention)
        case .staged, .insertionRefused:
            status = .uncertain(.stagedRetention)
        case .awaitingInsertion:
            status = .uncertain(.insertion)
        default: break
        }
    }

    private mutating func accept(_ response: ImageUploadAccepted, now: TimeInterval,
                                 nextID: () -> String, timestamp: String) -> [Action] {
        guard (status == .awaitingAcceptance || status == .cancellationPending),
              same(response.header.sessionId, begin.header.sessionId), same(response.requestId, requestID) else { return [] }
        guard WireGuards.decodeBase64URL(response.transferId)?.count == 16,
              let lifetime = validLifetime(from: response.header.timestamp, to: response.expiresAt,
                                           maximum: Self.uploadLifetime) else {
            status = .uncertain(.partialCleanup)
            return []
        }
        // Conservatively charge the entire observed request time against the host's remaining
        // partial lifetime; a slow response must never extend the original host deadline.
        partialDeadline = min(startedAt + Self.uploadLifetime, startedAt + lifetime)
        knownPartialExpiry = response.expiresAt
        guard let partialDeadline, now < partialDeadline else { status = .uncertain(.partialCleanup); return [] }
        transferID = response.transferId
        if status == .cancellationPending {
            guard let frame = beginCancellation(requestID: nextID(), timestamp: timestamp, now: now) else { return [] }
            return [.send(frame)]
        }
        return nextRead(now: now)
    }

    private mutating func acknowledge(_ response: ImageUploadChunkAck, now: TimeInterval,
                                      nextID: () -> String, timestamp: String) -> [Action] {
        guard case .awaitingChunkAck(let offset, _) = status, let transferID,
              same(response.header.sessionId, begin.header.sessionId), same(response.requestId, requestID),
              same(response.transferId, transferID) else { return [] }
        let count = min(ImageStagingLimits.chunkBytes, begin.byteLength - offset)
        guard response.seq == sequence, response.receivedBytes == offset + count else {
            status = .uncertain(.partialCleanup)
            return []
        }
        sentBytes = response.receivedBytes
        sequence += 1
        if sentBytes < begin.byteLength { return nextRead(now: now) }
        let id = nextID()
        guard let header = claimHeader(id: id, timestamp: timestamp) else { status = .uncertain(.partialCleanup); return [] }
        let frame = ImageUploadMessage.complete(ImageUploadComplete(header: header, transferId: transferID))
        guard (try? frame.encodedFrame()) != nil else { status = .uncertain(.partialCleanup); return [] }
        requestID = id
        completeRequestID = id
        operationDeadline = now + Self.operationTimeout
        status = .awaitingResult
        return [.send(frame)]
    }

    private mutating func complete(_ response: ImageUploadResult, now: TimeInterval) -> [Action] {
        guard let transferID, let completeRequestID,
              status == .awaitingResult || status == .awaitingCancellation,
              same(response.header.sessionId, begin.header.sessionId), same(response.requestId, completeRequestID),
              same(response.transferId, transferID) else { return [] }
        guard response.byteLength == begin.byteLength, response.mediaType == begin.mediaType,
              same(response.digest, begin.digest), !same(response.artifactId, transferID),
              WireGuards.decodeBase64URL(response.artifactId)?.count == 16,
              let lifetime = validLifetime(from: response.header.timestamp, to: response.artifactExpiresAt,
                                           maximum: Self.stagedLifetime) else {
            status = .uncertain(.stagedRetention)
            return []
        }
        knownStagedExpiry = response.artifactExpiresAt
        if status == .awaitingCancellation {
            stagedWhileCancelling = response
            return []
        }
        remember(response, lifetime: lifetime, now: now)
        return []
    }

    private mutating func cancelled(_ response: ImageUploadCancelResult) -> [Action] {
        guard status == .awaitingCancellation, let transferID,
              same(response.header.sessionId, begin.header.sessionId), same(response.requestId, requestID),
              same(response.transferId, transferID) else { return [] }
        // A success for both racing completion and cancellation is contradictory; do not
        // claim remote deletion if the host also reported a staged artifact.
        status = stagedWhileCancelling == nil ? .cancelled : .uncertain(.stagedRetention)
        return []
    }

    private mutating func refuse(_ response: ImageUploadRefused) -> [Action] {
        guard same(response.header.sessionId, begin.header.sessionId), same(response.requestId, requestID) else { return [] }
        switch (status, response.operation) {
        case (.awaitingAcceptance, .begin):
            // `unavailable` deliberately hides ownership, including whether cleanup failed.
            status = .refused(response.code, remoteCleanupUnconfirmed: response.code == .cleanupFailed || response.code == .unavailable)
        case (.awaitingChunkAck, .chunk), (.awaitingResult, .complete):
            // Refusal does not itself acknowledge deletion of an already-created partial.
            status = .refused(response.code, remoteCleanupUnconfirmed: true)
        case (.cancellationPending, .begin):
            status = .refused(response.code, remoteCleanupUnconfirmed: response.code == .cleanupFailed || response.code == .unavailable)
        case (.awaitingCancellation, .cancel):
            // The staged artifact cannot be cancelled under ADR 0041. Do not infer cleanup.
            status = .uncertain(completeRequestID == nil ? .partialCleanup : .stagedRetention)
        default: break
        }
        return []
    }

    private mutating func nextRead(now: TimeInterval) -> [Action] {
        let count = min(ImageStagingLimits.chunkBytes, begin.byteLength - sentBytes)
        guard count > 0, sequence <= ImageStagingLimits.maxSequence else { status = .uncertain(.partialCleanup); return [] }
        operationDeadline = now + Self.operationTimeout
        status = .awaitingChunkData(offset: sentBytes, count: count)
        return [.read(offset: sentBytes, count: count)]
    }

    private mutating func beginCancellation(requestID: String, timestamp: String, now: TimeInterval) -> ImageUploadMessage? {
        guard let transferID, let header = claimHeader(id: requestID, timestamp: timestamp) else {
            status = .uncertain(completeRequestID == nil ? .partialCleanup : .stagedRetention)
            return nil
        }
        let frame = ImageUploadMessage.cancel(ImageUploadCancel(header: header, transferId: transferID))
        guard (try? frame.encodedFrame()) != nil else {
            status = .uncertain(completeRequestID == nil ? .partialCleanup : .stagedRetention)
            return nil
        }
        self.requestID = requestID
        operationDeadline = now + Self.operationTimeout
        status = .awaitingCancellation
        return frame
    }

    private mutating func remember(_ response: ImageUploadResult, lifetime: TimeInterval, now: TimeInterval) {
        artifactID = response.artifactId
        // The response could have spent up to the full operation time in flight. Retiring
        // early is safe; extending host authority by network latency is not.
        let conservativeLifetime = max(0, lifetime - Self.operationTimeout)
        artifactDeadline = now + conservativeLifetime
        status = conservativeLifetime > 0 ? .staged(expiry: response.artifactExpiresAt) : .expired
    }

    private mutating func live(at now: TimeInterval) -> Bool {
        guard now.isFinite, now >= lastObservedAt else {
            disconnected()
            return false
        }
        lastObservedAt = now
        switch status {
        case .awaitingAcceptance, .awaitingChunkData, .awaitingChunkAck, .cancellationPending:
            if now - startedAt >= Self.uploadLifetime || now >= operationDeadline || partialDeadline.map({ now >= $0 }) == true {
                status = .uncertain(.partialCleanup)
                return false
            }
        case .awaitingResult:
            if now - startedAt >= Self.uploadLifetime || now >= operationDeadline || partialDeadline.map({ now >= $0 }) == true {
                status = .uncertain(.stagedRetention)
                return false
            }
        case .awaitingCancellation:
            if now - startedAt >= Self.uploadLifetime || now >= operationDeadline || partialDeadline.map({ now >= $0 }) == true {
                status = .uncertain(completeRequestID == nil ? .partialCleanup : .stagedRetention)
                return false
            }
        case .awaitingInsertion:
            if now >= operationDeadline { status = .uncertain(.insertion); return false }
        case .staged, .insertionRefused:
            if let artifactDeadline, now >= artifactDeadline { status = .expired; return false }
        case .inserted(let expiry):
            if let artifactDeadline, now >= artifactDeadline { status = .insertedExpired(expiry: expiry) }
            return false
        case .cancelled, .insertedExpired, .expired, .refused, .uncertain, .requestLimit:
            return false
        }
        return true
    }

    private mutating func claimHeader(id: String, timestamp: String) -> WireHeader? {
        guard usedRequestIDs.count < Self.maxRequestIDs, WireGuards.isUUID4(id), WireGuards.isTimestamp(timestamp),
              usedRequestIDs.insert(id).inserted else { return nil }
        return WireHeader(id: id, timestamp: timestamp, sessionId: begin.header.sessionId)
    }

    private func validLifetime(from timestamp: String, to expiry: String, maximum: TimeInterval) -> TimeInterval? {
        guard WireGuards.isTimestamp(timestamp), WireGuards.isTimestamp(expiry),
              let then = WireTimestamp.date(from: timestamp), let until = WireTimestamp.date(from: expiry) else { return nil }
        let remaining = until.timeIntervalSince(then)
        return remaining > 0 && remaining <= maximum ? remaining : nil
    }

    private func same(_ left: String, _ right: String) -> Bool { WireGuards.same(left, right) }
}
