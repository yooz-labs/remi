import Foundation
import Testing
@testable import RemiKit

struct FileDownloadFlowTests {
    typealias S = FileFetchStateMachineTests
    static let binding = AttachedBinding(harness: .claude, harnessSessionId: "claude-1")
    static let stamp = "2026-10-14T03:00:00.000Z"

    static func started(_ path: String = "src/main.swift") throws -> FileDownloadFlow {
        let result = FileDownloadFlow.begin(
            path: path, binding: binding, sessionId: S.sessionId, requestId: S.beginId, timestamp: stamp, now: 0)
        return try result.get().flow
    }

    // MARK: Path rules equal the wire

    @Test func acceptedPathsAreTheWiresAcceptedPaths() {
        let paths = [
            "a", "dir/file.txt", String(repeating: "a", count: 255), "界/é.txt", "a b/c d", ".hidden/x",
            Array(repeating: "d", count: 64).joined(separator: "/"),
        ]
        for path in paths {
            #expect(FileDownloadPath.issue(in: path) == nil, "\(path)")
            #expect(FileFetchMessage.isRelativePath(path), "\(path)")
        }
    }

    @Test func eachRuleHasItsIssueAndTheWireAgrees() {
        let cases: [(String, FileDownloadPathIssue)] = [
            ("", .empty),
            (String(repeating: "a", count: 4_097), .tooLong),
            (Array(repeating: "d", count: 65).joined(separator: "/"), .tooManyComponents),
            ("/abs", .emptyComponent), ("a//b", .emptyComponent), ("a/", .emptyComponent),
            (String(repeating: "a", count: 256), .componentTooLong),
            ("a\\b", .unsafeCharacter), ("c:x", .unsafeCharacter), ("a\u{0}b", .unsafeCharacter),
            ("a\u{202E}b", .unsafeCharacter), ("a\nb", .unsafeCharacter), ("a\u{85}b", .unsafeCharacter),
        ]
        for (path, issue) in cases {
            #expect(FileDownloadPath.issue(in: path) == issue, "\(path.debugDescription)")
            #expect(!FileFetchMessage.isRelativePath(path), "\(path.debugDescription)")
            #expect(!issue.text.isEmpty)
        }
    }

    @Test func baseNameIsTheLastComponent() {
        #expect(FileDownloadPath.baseName(of: "a/b/c.txt") == "c.txt")
        #expect(FileDownloadPath.baseName(of: "solo") == "solo")
    }

    @Test func invalidPathNeverBecomesARequest() {
        let result = FileDownloadFlow.begin(
            path: "../x\\y", binding: Self.binding, sessionId: S.sessionId, requestId: S.beginId, timestamp: Self.stamp,
            now: 0)
        guard case .failure(let issue) = result else {
            Issue.record("accepted")
            return
        }
        #expect(issue == .unsafeCharacter)
    }

    // MARK: Begin frame

    @Test func beginFrameIsAStrictlyValidRequest() throws {
        let result = FileDownloadFlow.begin(
            path: "src/main.swift", binding: Self.binding, sessionId: S.sessionId, requestId: S.beginId,
            timestamp: Self.stamp, now: 0)
        let message = try result.get().message
        let frame = try message.encodedFrame()
        #expect(try FileFetchMessage.decode(frame) == message)
        guard case .begin(let begin) = message else { Issue.record("not begin"); return }
        #expect(begin.relativePath == "src/main.swift")
        #expect(begin.header.id == S.beginId)
    }

    // MARK: Full flow

    @Test func fullDownloadVerifiesAndOnlyThenExposesBytes() throws {
        let data = S.payload(FileFetchLimits.chunkBytes + 10)
        var flow = try Self.started()
        var ids = 0
        func send(_ event: FileFetchStateMachine.Event, _ now: TimeInterval) -> [FileFetchMessage] {
            flow.handle(event, now: now, makeID: { ids += 1; return String(format: "00000000-0000-4000-8000-%012x", ids) },
                timestamp: Self.stamp)
        }
        #expect(flow.status == .requesting)
        #expect(flow.verifiedFile == nil)

        let afterAccept = send(.message(S.accepted(data)), 1)
        guard case .read(let first)? = afterAccept.first else { Issue.record("no read"); return }
        #expect(first.seq == 0 && first.receivedBytes == 0)
        #expect(first.header.sessionId == S.sessionId)
        #expect(flow.status == .receiving(received: 0, total: data.count, fileName: "report.txt"))

        _ = send(.message(S.chunk(0, of: data)), 2)
        #expect(flow.status == .receiving(received: FileFetchLimits.chunkBytes, total: data.count, fileName: "report.txt"))
        #expect(flow.verifiedFile == nil)  // a partial is never exposed

        let done = send(.message(S.chunk(1, of: data)), 3)
        guard case .complete(let complete)? = done.first else { Issue.record("no complete"); return }
        #expect(complete.receivedBytes == data.count)
        _ = send(.message(S.result()), 4)
        #expect(flow.status == .verified(fileName: "report.txt", byteCount: data.count, hostSettled: true))
        #expect(flow.verifiedFile?.data == data)
        #expect(flow.isFinished)
        // Every frame the flow produced survives the strict codec.
        for message in afterAccept + done { _ = try message.encodedFrame() }
    }

    @Test func badDigestFailsWithPlainTextAndKeepsNothing() throws {
        let data = S.payload(100)
        var flow = try Self.started()
        _ = flow.handle(.message(S.accepted(data, digest: S.digest(Data("other".utf8)))), now: 0, makeID: { S.beginId }, timestamp: Self.stamp)
        let out = flow.handle(.message(S.chunk(0, of: data)), now: 1, makeID: { S.beginId }, timestamp: Self.stamp)
        #expect(flow.status == .failed("The file did not arrive intact, so nothing was kept. Try again."))
        #expect(flow.verifiedFile == nil)
        guard case .cancel? = out.first else { Issue.record("no cancel"); return }
    }

    @Test func cancelDiscardsAndSendsCancel() throws {
        let data = S.payload(FileFetchLimits.chunkBytes * 2)
        var flow = try Self.started()
        _ = flow.handle(.message(S.accepted(data)), now: 0, makeID: { S.beginId }, timestamp: Self.stamp)
        _ = flow.handle(.message(S.chunk(0, of: data)), now: 1, makeID: { S.beginId }, timestamp: Self.stamp)
        let out = flow.handle(.cancelRequested, now: 2, makeID: { S.beginId }, timestamp: Self.stamp)
        guard case .cancel(let cancel)? = out.first else { Issue.record("no cancel"); return }
        #expect(cancel.beginId == S.beginId)
        #expect(flow.status == .cancelled)
        #expect(flow.verifiedFile == nil)
    }

    @Test func disconnectDiscardsPartialData() throws {
        let data = S.payload(FileFetchLimits.chunkBytes * 2)
        var flow = try Self.started()
        _ = flow.handle(.message(S.accepted(data)), now: 0, makeID: { S.beginId }, timestamp: Self.stamp)
        _ = flow.handle(.message(S.chunk(0, of: data)), now: 1, makeID: { S.beginId }, timestamp: Self.stamp)
        _ = flow.handle(.disconnected, now: 2, makeID: { S.beginId }, timestamp: Self.stamp)
        #expect(flow.status == .failed(FileDownloadFlow.text(for: .disconnected)))
        #expect(flow.verifiedFile == nil)
    }

    @Test func frameForAnotherSessionIsIgnored() throws {
        var flow = try Self.started()
        let foreign = FileFetchMessage.accepted(
            FileFetchAccepted(
                header: WireHeader(id: S.header().id, timestamp: Self.stamp, sessionId: "00112233-4455-7677-8899-000000000000"),
                requestId: S.beginId, transferId: S.transfer, fileName: "x", byteLength: 1, digest: S.digest(Data([1])),
                expiresAt: "2026-10-14T03:05:00.000Z"))
        #expect(flow.handle(.message(foreign), now: 0, makeID: { S.beginId }, timestamp: Self.stamp).isEmpty)
        #expect(flow.status == .requesting)
    }

    @Test func everyRefusalCodeHasDistinctPlainText() {
        let texts = FileFetchRefusalCode.allCases.map(FileDownloadFlow.text(for:))
        #expect(texts.allSatisfy { !$0.isEmpty && !$0.contains("_") && !$0.contains("—") })
        // sequence and integrity share one text on purpose; the rest are distinct.
        #expect(Set(texts).count == FileFetchRefusalCode.allCases.count - 1)
    }

    @Test func hostRefusalAtBeginEndsTheDownload() throws {
        var flow = try Self.started()
        _ = flow.handle(.message(S.refused(.begin, .unavailable)), now: 0, makeID: { S.beginId }, timestamp: Self.stamp)
        #expect(flow.status == .failed(FileDownloadFlow.text(for: .unavailable)))
    }
}

struct PaneTransportPolicyTests {
    @Test func noCurrentRouteCanCarryTheFamilies() throws {
        #expect(PaneTransportPolicy.directSecureTransport == false)
        #expect(PaneTransportPolicy.relaySemanticChild == false)
        let direct = MachineEndpoint(host: "127.0.0.1", port: 28100)
        let reason = try #require(PaneTransportPolicy.blockReason(for: direct))
        #expect(reason.contains("secure connection"))
        let pin = try RelayMachinePin(
            relayURL: "wss://relay.example.test", machinePublicKey: RelayCrypto.b64(Data(repeating: 7, count: 32)))
        let relay = MachineEndpoint(host: "relay.example.test", port: 443, relayPin: pin)
        #expect(try #require(PaneTransportPolicy.blockReason(for: relay)).contains("relay"))
    }
}
