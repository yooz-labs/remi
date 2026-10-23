import CryptoKit
import Foundation
import Testing
@testable import RemiKit

/// The pure file-fetch state machine against synthetic chunk sequences built with the real
/// codec types and real SHA-256: duplicate, gap, size and integrity failures, cancel,
/// disconnect, and the injected clock for the 30 s and 5 min limits.
struct FileFetchStateMachineTests {
    static let sessionId = "00112233-4455-7677-8899-aabbccddeeff"
    static let beginId = "00112233-4455-4677-8899-aabbccddeeff"
    static let transfer = "AAECAwQFBgcICQoLDA0ODw"
    static let chunkSize = FileFetchLimits.chunkBytes

    static func header(_ n: Int = 1) -> WireHeader {
        WireHeader(
            id: String(format: "00000000-0000-4000-8000-%012x", n), timestamp: "2026-10-14T03:00:00.000Z",
            sessionId: sessionId)
    }

    /// A deterministic payload that is not all zeros, and not periodic in the chunk size, so a reordered chunk changes the digest.
    static func payload(_ count: Int) -> Data { Data((0..<count).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ ($0 >> 8) &* 17 &+ 7) }) }

    static func digest(_ data: Data) -> String { WireGuards.encodeBase64URL(Data(SHA256.hash(data: data))) }

    static func accepted(_ data: Data, digest overridden: String? = nil, requestId: String = beginId) -> FileFetchMessage {
        .accepted(
            FileFetchAccepted(
                header: header(), requestId: requestId, transferId: transfer, fileName: "report.txt",
                byteLength: data.count, digest: overridden ?? digest(data), expiresAt: "2026-10-14T03:05:00.000Z"))
    }

    static func chunk(_ seq: Int, of data: Data, transferId: String = transfer) -> FileFetchMessage {
        let start = seq * chunkSize
        let slice = data.subdata(in: start..<min(data.count, start + chunkSize))
        return chunkMessage(seq, slice, transferId: transferId)
    }

    static func chunkMessage(_ seq: Int, _ bytes: Data, transferId: String = transfer) -> FileFetchMessage {
        .chunk(
            FileFetchChunk(
                header: header(10 + seq), requestId: header(100 + seq).id, transferId: transferId, seq: seq,
                data: WireGuards.encodeBase64URL(bytes)))
    }

    static func result() -> FileFetchMessage {
        .result(FileFetchResult(header: header(500), requestId: header(501).id, transferId: transfer))
    }

    static func refused(_ operation: FileFetchOperation, _ code: FileFetchRefusalCode, requestId: String = beginId)
        -> FileFetchMessage
    {
        .refused(FileFetchRefused(header: header(600), requestId: requestId, operation: operation, code: code))
    }

    static func machine(at now: TimeInterval = 0) -> FileFetchStateMachine {
        FileFetchStateMachine(beginId: beginId, now: now)
    }

    /// Accepts `data` and returns the machine ready to receive chunk 0.
    static func accepting(_ data: Data, at now: TimeInterval = 0) -> FileFetchStateMachine {
        var m = machine(at: now)
        _ = m.handle(.message(accepted(data)), at: now)
        return m
    }

    // MARK: Happy paths

    @Test func fullTransferPullsOneChunkAtATimeAndVerifies() {
        let data = Self.payload(Self.chunkSize * 2 + 100)
        var m = Self.machine()
        #expect(m.phase == .awaitingAcceptance)
        #expect(m.handle(.message(Self.accepted(data)), at: 1) == [.sendRead(transferId: Self.transfer, seq: 0, receivedBytes: 0)])
        #expect(m.handle(.message(Self.chunk(0, of: data)), at: 2) == [.sendRead(transferId: Self.transfer, seq: 1, receivedBytes: Self.chunkSize)])
        #expect(m.handle(.message(Self.chunk(1, of: data)), at: 3) == [.sendRead(transferId: Self.transfer, seq: 2, receivedBytes: Self.chunkSize * 2)])
        #expect(m.receivedBytes == Self.chunkSize * 2 && m.nextSequence == 2)
        #expect(m.handle(.message(Self.chunk(2, of: data)), at: 4) == [
            .sendComplete(transferId: Self.transfer, receivedBytes: data.count, digest: Self.digest(data))
        ])
        #expect(m.phase == .awaitingResult)
        #expect(m.outcome == nil)
        #expect(m.handle(.message(Self.result()), at: 5).isEmpty)
        #expect(m.outcome == .verified(.init(fileName: "report.txt", data: data), hostSettled: true))
    }

    @Test func singleByteFile() {
        let data = Data([9])
        var m = Self.accepting(data)
        #expect(m.handle(.message(Self.chunk(0, of: data)), at: 1) == [
            .sendComplete(transferId: Self.transfer, receivedBytes: 1, digest: Self.digest(data))
        ])
    }

    @Test func exactMultipleOfTheChunkSizeEndsWithAFullChunk() {
        let data = Self.payload(Self.chunkSize * 2)
        var m = Self.accepting(data)
        _ = m.handle(.message(Self.chunk(0, of: data)), at: 1)
        let actions = m.handle(.message(Self.chunk(1, of: data)), at: 2)
        #expect(actions == [.sendComplete(transferId: Self.transfer, receivedBytes: data.count, digest: Self.digest(data))])
    }

    @Test func maximumFileUsesAll320ChunkSlots() {
        let data = Self.payload(FileFetchLimits.fileBytes)
        var m = Self.accepting(data)
        var last: [FileFetchStateMachine.Action] = []
        for seq in 0...FileFetchLimits.maxSequence {
            last = m.handle(.message(Self.chunk(seq, of: data)), at: 1)
        }
        #expect(last == [.sendComplete(transferId: Self.transfer, receivedBytes: data.count, digest: Self.digest(data))])
        _ = m.handle(.message(Self.result()), at: 2)
        guard case .verified(let file, true)? = m.outcome else {
            Issue.record("not verified")
            return
        }
        #expect(file.data == data)
    }

    // MARK: Sequence and integrity failures

    @Test func duplicateChunkEndsTheTransferAsSequenceAndDiscardsBytes() {
        let data = Self.payload(Self.chunkSize * 2)
        var m = Self.accepting(data)
        _ = m.handle(.message(Self.chunk(0, of: data)), at: 1)
        #expect(m.handle(.message(Self.chunk(0, of: data)), at: 2) == [.sendCancel(beginId: Self.beginId)])
        #expect(m.outcome == .failed(.sequence))
        #expect(m.handle(.message(Self.chunk(1, of: data)), at: 3).isEmpty)  // no replay, nothing resumes
        #expect(m.outcome == .failed(.sequence))
    }

    @Test func gappedChunkEndsTheTransferAsSequence() {
        let data = Self.payload(Self.chunkSize * 3)
        var m = Self.accepting(data)
        #expect(m.handle(.message(Self.chunk(1, of: data)), at: 1) == [.sendCancel(beginId: Self.beginId)])
        #expect(m.outcome == .failed(.sequence))
    }

    @Test func wrongChunkSizeEndsTheTransferAsIntegrity() {
        let data = Self.payload(Self.chunkSize * 2)
        // A short non-final chunk.
        var short = Self.accepting(data)
        _ = short.handle(.message(Self.chunkMessage(0, data.prefix(100))), at: 1)
        #expect(short.outcome == .failed(.integrity))
        // A final chunk larger than what remains.
        var long = Self.accepting(Self.payload(10))
        _ = long.handle(.message(Self.chunkMessage(0, Self.payload(11))), at: 1)
        #expect(long.outcome == .failed(.integrity))
        // A final chunk smaller than what remains.
        var small = Self.accepting(Self.payload(10))
        _ = small.handle(.message(Self.chunkMessage(0, Self.payload(9))), at: 1)
        #expect(small.outcome == .failed(.integrity))
    }

    @Test func digestMismatchNeverRequestsComplete() {
        let data = Self.payload(Self.chunkSize + 5)
        var m = Self.accepting(data, at: 0)
        var wrong = FileFetchStateMachine(beginId: Self.beginId, now: 0)
        _ = wrong.handle(.message(Self.accepted(data, digest: Self.digest(Self.payload(3)))), at: 0)
        _ = wrong.handle(.message(Self.chunk(0, of: data)), at: 1)
        let actions = wrong.handle(.message(Self.chunk(1, of: data)), at: 2)
        #expect(actions == [.sendCancel(beginId: Self.beginId)])
        #expect(wrong.outcome == .failed(.integrity))
        // The same bytes with the right digest do verify.
        _ = m.handle(.message(Self.chunk(0, of: data)), at: 1)
        #expect(!m.handle(.message(Self.chunk(1, of: data)), at: 2).isEmpty)
        #expect(m.phase == .awaitingResult)
    }

    @Test func aReorderedPayloadFailsTheDigest() {
        let data = Self.payload(Self.chunkSize * 2)
        var swapped = Data(data)
        swapped.replaceSubrange(0..<Self.chunkSize, with: data.subdata(in: Self.chunkSize..<data.count))
        swapped.replaceSubrange(Self.chunkSize..<data.count, with: data.subdata(in: 0..<Self.chunkSize))
        var m = Self.accepting(data)
        _ = m.handle(.message(Self.chunk(0, of: swapped)), at: 1)
        _ = m.handle(.message(Self.chunk(1, of: swapped)), at: 2)
        #expect(m.outcome == .failed(.integrity))
    }

    @Test func messagesForOtherTransfersAndRequestsAreIgnored() {
        let data = Self.payload(50)
        var m = Self.machine()
        #expect(m.handle(.message(Self.accepted(data, requestId: Self.header(77).id)), at: 1).isEmpty)
        #expect(m.phase == .awaitingAcceptance)
        _ = m.handle(.message(Self.accepted(data)), at: 1)
        #expect(m.handle(.message(Self.chunk(0, of: data, transferId: "BBECAwQFBgcICQoLDA0ODw")), at: 2).isEmpty)
        #expect(m.phase == .receiving && m.receivedBytes == 0)
        #expect(m.handle(.message(Self.result()), at: 2).isEmpty)  // a result before the bytes are verified
        #expect(m.phase == .receiving)
        // A second acceptance does not restart the transfer.
        #expect(m.handle(.message(Self.accepted(data)), at: 2).isEmpty)
    }

    // MARK: Cancel, disconnect, refusal

    @Test func cancelWhileReceivingDiscardsAndIgnoresLateResponses() {
        let data = Self.payload(Self.chunkSize * 2)
        var m = Self.accepting(data)
        _ = m.handle(.message(Self.chunk(0, of: data)), at: 1)
        #expect(m.handle(.cancelRequested, at: 2) == [.sendCancel(beginId: Self.beginId)])
        #expect(m.outcome == .cancelled)
        #expect(m.handle(.message(Self.chunk(1, of: data)), at: 3).isEmpty)
        #expect(m.handle(.message(.cancelResult(FileFetchCancelResult(header: Self.header(9), requestId: Self.header(8).id, beginId: Self.beginId))), at: 3).isEmpty)
        #expect(m.outcome == .cancelled)
    }

    @Test func cancelBeforeAcceptanceNeedsNoTransferId() {
        var m = Self.machine()
        #expect(m.handle(.cancelRequested, at: 1) == [.sendCancel(beginId: Self.beginId)])
        #expect(m.outcome == .cancelled)
        #expect(m.handle(.message(Self.accepted(Self.payload(5))), at: 2).isEmpty)  // a late acceptance is ignored
        #expect(m.transferId == nil)
    }

    @Test func cancelAfterVerificationDiscardsTheBytesToo() {
        let data = Self.payload(10)
        var m = Self.accepting(data)
        _ = m.handle(.message(Self.chunk(0, of: data)), at: 1)
        #expect(m.handle(.cancelRequested, at: 2) == [.sendCancel(beginId: Self.beginId)])
        #expect(m.outcome == .cancelled)
    }

    @Test func disconnectDiscardsPartialsAndSendsNothing() {
        let data = Self.payload(Self.chunkSize * 2)
        var m = Self.accepting(data)
        _ = m.handle(.message(Self.chunk(0, of: data)), at: 1)
        #expect(m.handle(.disconnected, at: 2).isEmpty)
        #expect(m.outcome == .failed(.disconnected))
        var early = Self.machine()
        #expect(early.handle(.disconnected, at: 1).isEmpty)
        #expect(early.outcome == .failed(.disconnected))
    }

    @Test func disconnectAfterVerificationKeepsTheVerifiedFileUnsettled() {
        let data = Self.payload(10)
        var m = Self.accepting(data)
        _ = m.handle(.message(Self.chunk(0, of: data)), at: 1)
        #expect(m.handle(.disconnected, at: 2).isEmpty)
        #expect(m.outcome == .verified(.init(fileName: "report.txt", data: data), hostSettled: false))
    }

    @Test func hostRefusalsEndTheTransferWithoutACancel() {
        var begin = Self.machine()
        #expect(begin.handle(.message(Self.refused(.begin, .unavailable)), at: 1).isEmpty)
        #expect(begin.outcome == .failed(.refused(.unavailable)))

        var wrongRequest = Self.machine()
        #expect(wrongRequest.handle(.message(Self.refused(.begin, .busy, requestId: Self.header(5).id)), at: 1).isEmpty)
        #expect(wrongRequest.phase == .awaitingAcceptance)

        let data = Self.payload(Self.chunkSize * 2)
        var read = Self.accepting(data)
        _ = read.handle(.message(Self.chunk(0, of: data)), at: 1)
        #expect(read.handle(.message(Self.refused(.read, .sequence, requestId: Self.header(3).id)), at: 2).isEmpty)
        #expect(read.outcome == .failed(.refused(.sequence)))
    }

    @Test func cleanupFailedAfterVerificationStillKeepsTheVerifiedFile() {
        let data = Self.payload(10)
        var m = Self.accepting(data)
        _ = m.handle(.message(Self.chunk(0, of: data)), at: 1)
        _ = m.handle(.message(Self.refused(.complete, .cleanupFailed, requestId: Self.header(3).id)), at: 2)
        #expect(m.outcome == .verified(.init(fileName: "report.txt", data: data), hostSettled: false))
    }

    @Test func hostIntegrityRefusalAfterCompleteDiscardsTheFile() {
        let data = Self.payload(10)
        var m = Self.accepting(data)
        _ = m.handle(.message(Self.chunk(0, of: data)), at: 1)
        _ = m.handle(.message(Self.refused(.complete, .integrity, requestId: Self.header(3).id)), at: 2)
        #expect(m.outcome == .failed(.refused(.integrity)))
    }

    // MARK: Injected clock

    @Test func thirtySecondsWithoutProgressEndsAnAcceptedTransfer() {
        let data = Self.payload(Self.chunkSize * 2)
        var m = Self.accepting(data, at: 100)
        #expect(m.handle(.tick, at: 129.9).isEmpty)
        #expect(m.phase == .receiving)
        #expect(m.handle(.tick, at: 130) == [.sendCancel(beginId: Self.beginId)])
        #expect(m.outcome == .failed(.noProgress))
    }

    @Test func aValidChunkResetsTheProgressWindow() {
        let data = Self.payload(Self.chunkSize * 2)
        var m = Self.accepting(data, at: 0)
        _ = m.handle(.message(Self.chunk(0, of: data)), at: 20)
        #expect(m.handle(.tick, at: 49.9).isEmpty)
        #expect(m.phase == .receiving)
        #expect(m.handle(.tick, at: 50) == [.sendCancel(beginId: Self.beginId)])
        #expect(m.outcome == .failed(.noProgress))
    }

    @Test func aChunkArrivingAfterTheWindowIsTooLate() {
        let data = Self.payload(Self.chunkSize)
        var m = Self.accepting(data, at: 0)
        #expect(m.handle(.message(Self.chunk(0, of: data)), at: 31) == [.sendCancel(beginId: Self.beginId)])
        #expect(m.outcome == .failed(.noProgress))
    }

    @Test func theNoProgressWindowDoesNotApplyBeforeAcceptance() {
        var m = Self.machine(at: 0)
        #expect(m.handle(.tick, at: 299).isEmpty)
        #expect(m.phase == .awaitingAcceptance)
        #expect(m.handle(.tick, at: 300) == [.sendCancel(beginId: Self.beginId)])
        #expect(m.outcome == .failed(.lifetimeExpired))
    }

    @Test func fiveMinuteLifetimeIncludesPreparationAndSteadyProgress() {
        let data = Self.payload(Self.chunkSize * 10)
        var m = Self.machine(at: 0)
        _ = m.handle(.message(Self.accepted(data)), at: 280)  // preparation took 280 s
        _ = m.handle(.message(Self.chunk(0, of: data)), at: 290)
        _ = m.handle(.message(Self.chunk(1, of: data)), at: 299)
        #expect(m.phase == .receiving)
        #expect(m.handle(.message(Self.chunk(2, of: data)), at: 300) == [.sendCancel(beginId: Self.beginId)])
        #expect(m.outcome == .failed(.lifetimeExpired))
    }

    @Test func expiryWhileAwaitingTheResultKeepsTheVerifiedFile() {
        let data = Self.payload(10)
        var m = Self.accepting(data, at: 0)
        _ = m.handle(.message(Self.chunk(0, of: data)), at: 1)
        #expect(m.handle(.tick, at: 31).isEmpty)
        #expect(m.outcome == .verified(.init(fileName: "report.txt", data: data), hostSettled: false))
    }

    @Test func aClockThatGoesBackwardsDoesNotExpireAnything() {
        let data = Self.payload(Self.chunkSize * 2)
        var m = Self.accepting(data, at: 100)
        #expect(m.handle(.tick, at: 50).isEmpty)
        #expect(m.phase == .receiving)
    }

    @Test func nothingHappensAfterTheTransferEnds() {
        var m = Self.machine()
        _ = m.handle(.cancelRequested, at: 1)
        for event: FileFetchStateMachine.Event in [.tick, .disconnected, .cancelRequested] {
            #expect(m.handle(event, at: 1_000).isEmpty)
        }
        #expect(m.outcome == .cancelled)
    }
}
