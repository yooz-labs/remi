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
        let chunk = try #require(flow.supplyChunk(Data([1, 2, 3, 4]), requestID: chunkID, timestamp: time, now: 2))
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
        let insertion = try #require(flow.addToDraft(requestID: insertID, timestamp: time, now: 5))
        guard case .request(let request) = insertion else { Issue.record("expected insertion request"); return }
        #expect(request.artifactId == artifact && request.header.id == insertID)
        flow.receiveInsertion(.result(ImageInsertResult(header: header(hostID), requestId: insertID, outcome: .inserted)), now: 6)
        #expect(flow.status == .inserted(expiry: artifactExpiry))
        #expect(flow.addToDraft(requestID: cancelID, timestamp: time, now: 7) == nil)
    }

    @Test func wrongCorrelationDoesNotAdvanceOrRetireThePendingRequest() throws {
        var flow = try begin()
        #expect(flow.receive(accepted(requestId: chunkID), now: 1, nextID: { chunkID }, timestamp: time).isEmpty)
        #expect(flow.receive(accepted(sessionId: "00112233-4455-4677-8899-aabbccddeefa"), now: 1,
                             nextID: { chunkID }, timestamp: time).isEmpty)
        #expect(flow.status == .awaitingAcceptance)
        #expect(flow.receive(accepted(), now: 2, nextID: { chunkID }, timestamp: time) == [.read(offset: 0, count: 4)])
        _ = try #require(flow.supplyChunk(Data([1, 2, 3, 4]), requestID: chunkID, timestamp: time, now: 3))
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
        #expect(flow.receive(accepted(), now: 17, nextID: { chunkID }, timestamp: time).isEmpty)
    }

    @Test func lostInsertionReceiptCannotTriggerASecondEffect() throws {
        var flow = try begin()
        _ = flow.receive(accepted(), now: 1, nextID: { chunkID }, timestamp: time)
        _ = try #require(flow.supplyChunk(Data([1, 2, 3, 4]), requestID: chunkID, timestamp: time, now: 2))
        _ = flow.receive(.chunkAck(ImageUploadChunkAck(header: header(hostID), requestId: chunkID,
            transferId: transfer, seq: 0, receivedBytes: 4)), now: 3, nextID: { completeID }, timestamp: time)
        _ = flow.receive(.result(ImageUploadResult(header: header(hostID), requestId: completeID,
            transferId: transfer, artifactId: artifact, artifactExpiresAt: artifactExpiry,
            byteLength: 4, mediaType: .png, digest: digest)), now: 4, nextID: { cancelID }, timestamp: time)
        _ = try #require(flow.addToDraft(requestID: insertID, timestamp: time, now: 5))
        flow.tick(now: 21)
        #expect(flow.status == .uncertain(.insertion))
        #expect(flow.addToDraft(requestID: cancelID, timestamp: time, now: 22) == nil)
        flow.receiveInsertion(.result(ImageInsertResult(header: header(hostID), requestId: insertID, outcome: .inserted)), now: 23)
        #expect(flow.status == .uncertain(.insertion))
    }
}
