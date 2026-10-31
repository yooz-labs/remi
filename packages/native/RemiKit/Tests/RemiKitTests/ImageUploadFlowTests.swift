import CryptoKit
import Foundation
import Testing
@testable import RemiKit

/// The staging state machine never owns a socket or file: it must correlate strict host
/// replies before the real owner reads the next bounded snapshot chunk (#1313).
@Suite struct ImageUploadFlowTests {
    private let session = "00112233-4455-4677-8899-aabbccddeeff"
    private let beginID = "11112233-4455-4677-8899-aabbccddeeff"
    private let chunkID = "22222233-4455-4677-8899-aabbccddeeff"
    private let completeID = "33332233-4455-4677-8899-aabbccddeeff"
    private let cancelID = "44442233-4455-4677-8899-aabbccddeeff"
    private let insertID = "55552233-4455-4677-8899-aabbccddeeff"
    private let hostID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    private let time = "2026-10-30T12:00:00.000Z"
    private let expiry = "2026-10-30T12:05:00.000Z"
    private let artifactExpiry = "2026-10-31T12:00:00.000Z"
    private let transfer = "AAAAAAAAAAAAAAAAAAAAAA"
    private let artifact = "AQEBAQEBAQEBAQEBAQEBAQ"
    private var digest: String { WireGuards.encodeBase64URL(Data(SHA256.hash(data: Data([1, 2, 3, 4])))) }

    private func header(_ id: String, sessionId: String? = nil) -> WireHeader {
        WireHeader(id: id, timestamp: time, sessionId: sessionId ?? session)
    }

    private func begin() throws -> ImageUploadFlow {
        try ImageUploadFlow(begin: ImageUploadBegin(header: header(beginID),
            binding: AttachedBinding(harness: .claude, harnessSessionId: "owned-thread"),
            mediaType: .png, byteLength: 4, digest: digest), now: 0)
    }

    private func accepted(requestId: String? = nil, sessionId: String? = nil) -> ImageUploadMessage {
        .accepted(ImageUploadAccepted(header: header(hostID, sessionId: sessionId), requestId: requestId ?? beginID,
                                      transferId: transfer, expiresAt: expiry))
    }

    @Test func correlatedUploadAndExplicitInsertion() throws {
        var flow = try begin()
        #expect(flow.receive(accepted(), now: 1, nextID: { chunkID }, timestamp: time) == [.read(offset: 0, count: 4)])
        #expect(flow.knownPartialExpiry == expiry)
        let maybeChunk = flow.supplyChunk(Data([1, 2, 3, 4]), requestID: chunkID, timestamp: time, now: 2)
        let chunk = try #require(maybeChunk)
        guard case .chunk(let sent) = chunk else { Issue.record("expected chunk"); return }
        #expect(sent.seq == 0 && sent.data == "AQIDBA" && sent.transferId == transfer)
        let ack = ImageUploadMessage.chunkAck(ImageUploadChunkAck(header: header(hostID), requestId: chunkID,
            transferId: transfer, seq: 0, receivedBytes: 4))
        let afterAck = flow.receive(ack, now: 3, nextID: { completeID }, timestamp: time)
        guard case .send(.complete(let complete)) = afterAck.first else { Issue.record("expected complete"); return }
        #expect(complete.header.id == completeID && complete.transferId == transfer)
        let result = ImageUploadMessage.result(ImageUploadResult(header: header(hostID), requestId: completeID,
            transferId: transfer, artifactId: artifact, artifactExpiresAt: artifactExpiry,
            byteLength: 4, mediaType: .png, digest: digest))
        #expect(flow.receive(result, now: 4, nextID: { cancelID }, timestamp: time).isEmpty)
        #expect(flow.status == .staged(expiry: artifactExpiry))
        #expect(flow.knownStagedExpiry == artifactExpiry)
        let maybeInsertion = flow.addToDraft(requestID: insertID, timestamp: time, now: 5)
        let insertion = try #require(maybeInsertion)
        guard case .request(let request) = insertion else { Issue.record("expected insertion request"); return }
        #expect(request.artifactId == artifact && request.header.id == insertID)
        flow.receiveInsertion(.result(ImageInsertResult(header: header(hostID), requestId: insertID, outcome: .inserted)), now: 6)
        #expect(flow.status == .inserted(expiry: artifactExpiry))
        #expect(flow.addToDraft(requestID: cancelID, timestamp: time, now: 7) == nil)
        flow.tick(now: ImageUploadFlow.stagedLifetime)
        #expect(flow.status == .insertedExpired(expiry: artifactExpiry))
    }

    @Test func wrongCorrelationDoesNotAdvanceOrRetireThePendingRequest() throws {
        var flow = try begin()
        #expect(flow.receive(accepted(requestId: chunkID), now: 1, nextID: { chunkID }, timestamp: time).isEmpty)
        #expect(flow.receive(accepted(sessionId: "00112233-4455-4677-8899-aabbccddeefa"), now: 1,
                             nextID: { chunkID }, timestamp: time).isEmpty)
        #expect(flow.status == .awaitingAcceptance)
        #expect(flow.receive(accepted(), now: 2, nextID: { chunkID }, timestamp: time) == [.read(offset: 0, count: 4)])
        let maybeChunk = flow.supplyChunk(Data([1, 2, 3, 4]), requestID: chunkID, timestamp: time, now: 3)
        _ = try #require(maybeChunk)
        let wrongTransfer = ImageUploadMessage.chunkAck(ImageUploadChunkAck(header: header(hostID), requestId: chunkID,
            transferId: artifact, seq: 0, receivedBytes: 4))
        #expect(flow.receive(wrongTransfer, now: 4, nextID: { completeID }, timestamp: time).isEmpty)
        #expect(flow.status == .awaitingChunkAck(sent: 0, total: 4))
        let correct = ImageUploadMessage.chunkAck(ImageUploadChunkAck(header: header(hostID), requestId: chunkID,
            transferId: transfer, seq: 0, receivedBytes: 4))
        #expect(flow.receive(correct, now: 5, nextID: { completeID }, timestamp: time).count == 1)
    }

    @Test func cancellationBeforeAcceptanceWaitsForKnownTransferAndHostReceipt() throws {
        var flow = try begin()
        #expect(flow.cancel(requestID: cancelID, timestamp: time, now: 1) == nil)
        #expect(flow.status == .cancellationPending)
        let actions = flow.receive(accepted(), now: 2, nextID: { cancelID }, timestamp: time)
        guard case .send(.cancel(let cancel)) = actions.first else { Issue.record("expected cancel"); return }
        #expect(cancel.transferId == transfer)
        #expect(flow.status == .awaitingCancellation)
        let result = ImageUploadMessage.cancelResult(ImageUploadCancelResult(header: header(hostID),
            requestId: cancelID, transferId: transfer))
        _ = flow.receive(result, now: 3, nextID: { chunkID }, timestamp: time)
        #expect(flow.status == .cancelled)
    }

    @Test func lostAcceptanceIsUncertainRatherThanClaimedCancelled() throws {
        var flow = try begin()
        _ = flow.cancel(requestID: cancelID, timestamp: time, now: 1)
        flow.tick(now: 16)
        #expect(flow.status == .uncertain(.partialCleanup))
        #expect(flow.knownPartialExpiry == nil)
        #expect(flow.receive(accepted(), now: 17, nextID: { chunkID }, timestamp: time).isEmpty)
    }

    @Test func lostInsertionReceiptCannotTriggerASecondEffect() throws {
        var flow = try begin()
        _ = flow.receive(accepted(), now: 1, nextID: { chunkID }, timestamp: time)
        let maybeChunk = flow.supplyChunk(Data([1, 2, 3, 4]), requestID: chunkID, timestamp: time, now: 2)
        _ = try #require(maybeChunk)
        _ = flow.receive(.chunkAck(ImageUploadChunkAck(header: header(hostID), requestId: chunkID,
            transferId: transfer, seq: 0, receivedBytes: 4)), now: 3, nextID: { completeID }, timestamp: time)
        _ = flow.receive(.result(ImageUploadResult(header: header(hostID), requestId: completeID,
            transferId: transfer, artifactId: artifact, artifactExpiresAt: artifactExpiry,
            byteLength: 4, mediaType: .png, digest: digest)), now: 4, nextID: { cancelID }, timestamp: time)
        let maybeInsertion = flow.addToDraft(requestID: insertID, timestamp: time, now: 5)
        _ = try #require(maybeInsertion)
        flow.tick(now: 21)
        #expect(flow.status == .uncertain(.insertion))
        #expect(flow.addToDraft(requestID: cancelID, timestamp: time, now: 22) == nil)
        flow.receiveInsertion(.result(ImageInsertResult(header: header(hostID), requestId: insertID, outcome: .inserted)), now: 23)
        #expect(flow.status == .uncertain(.insertion))
    }

    @Test func stopAndWaitRequiresExactCumulativeAcknowledgment() throws {
        let bytes = Data(repeating: 7, count: ImageStagingLimits.chunkBytes + 1)
        let largeDigest = WireGuards.encodeBase64URL(Data(SHA256.hash(data: bytes)))
        let request = ImageUploadBegin(header: header(beginID),
            binding: AttachedBinding(harness: .claude, harnessSessionId: "owned-thread"),
            mediaType: .jpeg, byteLength: bytes.count, digest: largeDigest)
        var flow = try ImageUploadFlow(begin: request, now: 0)
        let firstRead = flow.receive(accepted(), now: 1, nextID: { chunkID }, timestamp: time)
        #expect(firstRead == [.read(offset: 0, count: ImageStagingLimits.chunkBytes)])
        let firstChunk = flow.supplyChunk(bytes.prefix(ImageStagingLimits.chunkBytes), requestID: chunkID,
                                          timestamp: time, now: 2)
        #expect(firstChunk != nil)
        let firstAck = ImageUploadMessage.chunkAck(ImageUploadChunkAck(header: header(hostID), requestId: chunkID,
            transferId: transfer, seq: 0, receivedBytes: ImageStagingLimits.chunkBytes))
        #expect(flow.receive(firstAck, now: 3, nextID: { completeID }, timestamp: time)
                == [.read(offset: ImageStagingLimits.chunkBytes, count: 1)])
        #expect(flow.receive(firstAck, now: 4, nextID: { completeID }, timestamp: time).isEmpty)
        let secondChunk = flow.supplyChunk(Data([7]), requestID: completeID, timestamp: time, now: 5)
        #expect(secondChunk != nil)
        let wrongCount = ImageUploadMessage.chunkAck(ImageUploadChunkAck(header: header(hostID), requestId: completeID,
            transferId: transfer, seq: 1, receivedBytes: ImageStagingLimits.chunkBytes))
        #expect(flow.receive(wrongCount, now: 6, nextID: { cancelID }, timestamp: time).isEmpty)
        #expect(flow.status == .uncertain(.partialCleanup))
    }

    @Test func aRequestIdentifierCannotBeReusedForAChunk() throws {
        var flow = try begin()
        _ = flow.receive(accepted(), now: 1, nextID: { chunkID }, timestamp: time)
        let reused = flow.supplyChunk(Data([1, 2, 3, 4]), requestID: beginID, timestamp: time, now: 2)
        #expect(reused == nil)
        #expect(flow.status == .uncertain(.partialCleanup))
    }

    @Test func eachNewOperationGetsItsOwnDeadline() throws {
        var flow = try begin()
        _ = flow.receive(accepted(), now: 14, nextID: { chunkID }, timestamp: time)
        let afterBeginDeadline = flow.supplyChunk(Data([1, 2, 3, 4]), requestID: chunkID, timestamp: time, now: 20)
        #expect(afterBeginDeadline != nil)
        flow.tick(now: 35)
        #expect(flow.status == .uncertain(.partialCleanup))
    }

    @Test func backwardTimeCannotExtendTransferAuthority() throws {
        var flow = try begin()
        _ = flow.receive(accepted(), now: 5, nextID: { chunkID }, timestamp: time)
        let result = flow.supplyChunk(Data([1, 2, 3, 4]), requestID: chunkID, timestamp: time, now: 4)
        #expect(result == nil)
        #expect(flow.status == .uncertain(.partialCleanup))
        #expect(flow.knownPartialExpiry == expiry)
    }

    @Test func unavailableBeginRefusalDoesNotClaimCleanup() throws {
        var flow = try begin()
        let refusal = ImageUploadMessage.refused(ImageUploadRefused(header: header(hostID),
            requestId: beginID, operation: .begin, code: .unavailable))
        _ = flow.receive(refusal, now: 1, nextID: { chunkID }, timestamp: time)
        #expect(flow.status == .refused(.unavailable, remoteCleanupUnconfirmed: true))
    }

    @Test func lostCompletionAndRacingCancelNeverClaimRemoteDeletion() throws {
        var flow = try begin()
        _ = flow.receive(accepted(), now: 1, nextID: { chunkID }, timestamp: time)
        _ = flow.supplyChunk(Data([1, 2, 3, 4]), requestID: chunkID, timestamp: time, now: 2)
        _ = flow.receive(.chunkAck(ImageUploadChunkAck(header: header(hostID), requestId: chunkID,
            transferId: transfer, seq: 0, receivedBytes: 4)), now: 3, nextID: { completeID }, timestamp: time)
        let cancel = flow.cancel(requestID: cancelID, timestamp: time, now: 4)
        guard case .cancel = cancel else { Issue.record("expected cancellation request"); return }
        let staged = ImageUploadMessage.result(ImageUploadResult(header: header(hostID), requestId: completeID,
            transferId: transfer, artifactId: artifact, artifactExpiresAt: artifactExpiry,
            byteLength: 4, mediaType: .png, digest: digest))
        _ = flow.receive(staged, now: 5, nextID: { insertID }, timestamp: time)
        #expect(flow.knownStagedExpiry == artifactExpiry)
        let cancelRefusal = ImageUploadMessage.refused(ImageUploadRefused(header: header(hostID),
            requestId: cancelID, operation: .cancel, code: .conflict))
        _ = flow.receive(cancelRefusal, now: 6, nextID: { insertID }, timestamp: time)
        #expect(flow.status == .uncertain(.stagedRetention))
        #expect(flow.knownStagedExpiry == artifactExpiry)
        #expect(flow.addToDraft(requestID: insertID, timestamp: time, now: 7) == nil)
    }
}
