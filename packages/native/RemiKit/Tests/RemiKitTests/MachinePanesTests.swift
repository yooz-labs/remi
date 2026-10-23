import Foundation
import Testing

@testable import RemiKit

#if DEBUG
/// The store's pane entry points against real decoded frames at its post-verification boundary
/// (as ChildRouteOriginTests does). The transport policy and the frame sink are injected through
/// the store's internal seams, so the send, route, binding and cleanup paths run for real while
/// no socket is involved.
@MainActor
struct MachinePanesTests {
    static let sessionA = "00000000-0000-4000-8000-0000000000a1"
    static let sessionB = "00000000-0000-4000-8000-0000000000b2"
    static let stamp = "2026-10-22T00:00:00.000Z"
    static let view = "AAECAwQFBgcICQoLDA0ODw"

    final class Sent { var frames: [String] = [] }

    @MainActor struct Fixture {
        let store: MachineStore
        let origin: MachineEndpoint
        let machine: String
        let childA: MachineEndpoint
        let childB: MachineEndpoint
        let sent: Sent

        func generation(_ endpoint: MachineEndpoint) throws -> UUID {
            try #require(store.connectionGenerations[endpoint])
        }

        func deliver(_ event: RemiInboundEvent, from endpoint: MachineEndpoint) throws {
            store.receive(event, from: endpoint, generation: try generation(endpoint))
        }

        func decodedTerminal() throws -> [TerminalViewMessage] { sent.frames.compactMap { try? TerminalViewMessage.decode($0) } }
        func decodedFile() throws -> [FileFetchMessage] { sent.frames.compactMap { try? FileFetchMessage.decode($0) } }
    }

    private static func descriptor() throws -> [String: Any] {
        ["id": try MachineIdentityVerifier.machineID(forPublicKey: Data(repeating: 9, count: 32)),
         "name": "Pane Mac", "platform": "darwin", "remiVersion": "0.8.0", "harnesses": ["claude"], "capabilities": []]
    }

    private static func frame<T: Decodable>(_ fields: [String: Any]) throws -> T {
        var object = fields
        object["id"] = UUID().uuidString
        object["timestamp"] = "2026-10-20T06:00:00Z"
        return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private static func session(_ id: String, port: Int, _ extra: [String: Any] = [:]) -> [String: Any] {
        var s: [String: Any] = [
            "sessionId": id, "projectPath": "/p", "status": "active", "source": "daemon", "wsPort": port,
            "canAttach": true,
        ]
        for (key, value) in extra { s[key] = value }
        return s
    }

    /// A connected machine with two daemon sessions on two child routes, and a permissive policy.
    private func fixture(
        capabilities: [String] = ["terminal_view", "file_download"], permissive: Bool = true,
        a: [String: Any] = [:]
    ) throws -> Fixture {
        let origin = MachineEndpoint(host: "192.0.2.50", port: 28050)
        let store = MachineStore(endpoints: [origin], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        let generation = try #require(store.connectionGenerations[origin])
        let ack: HelloAckMessage = try Self.frame([
            "type": "hello_ack", "serverVersion": "1.0.0", "protocolVersion": 1, "capabilities": capabilities,
            "machine": try Self.descriptor(),
        ])
        store.receive(.hello(ack), from: origin, generation: generation)
        store.receive(.connected(sessionId: nil), from: origin, generation: generation)
        let list: SessionListResponse = try Self.frame([
            "type": "session_list_response", "requestId": "list",
            "sessions": [
                Self.session(Self.sessionA, port: 28051, ["claudeSessionId": "claude-a", "harness": "claude"].merging(a) { $1 }),
                Self.session(Self.sessionB, port: 28052, ["claudeSessionId": "claude-b"]),
            ],
            "daemonPorts": [28051, 28052], "machine": try Self.descriptor(),
        ])
        store.receive(.sessions(list), from: origin, generation: generation)
        // A session daemon's own traffic (a question, a transcript) routes its session to that
        // connection; the test sets the same routes directly.
        let machineID = try #require(store.machines.first?.id)
        for (port, session) in [(28051, Self.sessionA), (28052, Self.sessionB)] {
            store.routeBySession[store.sessionKey(machineID: machineID, sessionID: session)] =
                MachineEndpoint(host: origin.host, port: port)
        }
        let sent = Sent()
        if permissive {
            store.paneTransportPolicy = PaneTransportPolicy(directSecureTransport: true, relaySemanticChild: true)
            store.paneFrameSender = { sent.frames.append($0) }
        }
        return Fixture(
            store: store, origin: origin, machine: try #require(store.machines.first?.id),
            childA: MachineEndpoint(host: origin.host, port: 28051), childB: MachineEndpoint(host: origin.host, port: 28052),
            sent: sent)
    }

    private func terminalHeader(_ id: String = "00000000-0000-4000-8000-000000000001", session: String = sessionA) -> WireHeader {
        WireHeader(id: id, timestamp: Self.stamp, sessionId: session)
    }

    private func openedFor(_ open: SessionTerminalOpen, session: String = sessionA) -> TerminalViewMessage {
        .opened(SessionTerminalOpened(
            header: terminalHeader(session: session), requestId: open.header.id, viewId: Self.view,
            expiresAt: "2099-01-01T00:00:00.000Z"))
    }

    // MARK: Gate

    @Test func sessionListKeepsTheHarnessSessionId() throws {
        let f = try fixture(a: ["harnessSessionId": "h-a"])
        defer { f.store.stop() }
        #expect(f.store.machines.first?.sessions.first { $0.sessionId == Self.sessionA }?.harnessSessionId == "h-a")
    }

    @Test func machineWithoutTheCapabilityIsToldToUpdate() throws {
        let f = try fixture(capabilities: ["workspaces"])
        defer { f.store.stop() }
        guard case .blocked(let reason) = f.store.openTerminal(machineID: f.machine, sessionID: Self.sessionA) else {
            Issue.record("started")
            return
        }
        #expect(reason.contains("cannot show the terminal of the attached session"))
        guard case .blocked(let files) = f.store.beginFileDownload(machineID: f.machine, sessionID: Self.sessionA, path: "a.txt")
        else {
            Issue.record("started")
            return
        }
        #expect(files.contains("download a file from the attached session"))
        #expect(f.store.terminalViews.isEmpty && f.store.fileDownloads.isEmpty && f.sent.frames.isEmpty)
    }

    @Test func advertisedCapabilityIsBlockedByTheRealPolicyOnARealRoute() throws {
        let f = try fixture(permissive: false)
        defer { f.store.stop() }
        #expect(f.store.routeBySession[f.store.sessionKey(machineID: f.machine, sessionID: Self.sessionA)] == f.childA)
        #expect(
            f.store.openTerminal(machineID: f.machine, sessionID: Self.sessionA)
                == .blocked(PaneTransportPolicy.current.reason(viaRelay: false)!))
        #expect(
            f.store.beginFileDownload(machineID: f.machine, sessionID: Self.sessionA, path: "a.txt")
                == .blocked(PaneTransportPolicy.current.reason(viaRelay: false)!))
        #expect(f.store.terminalViews.isEmpty && f.store.fileDownloads.isEmpty)
    }

    // MARK: Binding

    @Test func claudeFallsBackToClaudeSessionId() throws {
        let f = try fixture()
        defer { f.store.stop() }
        #expect(f.store.openTerminal(machineID: f.machine, sessionID: Self.sessionA) == .started)
        guard case .open(let open)? = try f.decodedTerminal().first else { Issue.record("no open"); return }
        #expect(open.binding == AttachedBinding(harness: .claude, harnessSessionId: "claude-a"))
        #expect(open.header.sessionId == Self.sessionA)
    }

    @Test func harnessSessionIdWinsAndCodexUsesIt() throws {
        let f = try fixture(a: ["harness": "codex", "harnessSessionId": "codex-1", "claudeSessionId": NSNull()])
        defer { f.store.stop() }
        #expect(f.store.openTerminal(machineID: f.machine, sessionID: Self.sessionA) == .started)
        guard case .open(let open)? = try f.decodedTerminal().first else { Issue.record("no open"); return }
        #expect(open.binding == AttachedBinding(harness: .codex, harnessSessionId: "codex-1"))
    }

    @Test func codexWithoutAHarnessSessionIdDoesNotBorrowClaudesId() throws {
        let f = try fixture(a: ["harness": "codex", "claudeSessionId": "claude-a"])
        defer { f.store.stop() }
        guard case .blocked(let reason) = f.store.openTerminal(machineID: f.machine, sessionID: Self.sessionA) else {
            Issue.record("started"); return
        }
        #expect(reason.contains("not reported its conversation"))
        #expect(f.sent.frames.isEmpty)
    }

    @Test func aSessionThatIsNotDaemonOwnedHasNoBinding() throws {
        let f = try fixture(a: ["source": "transcript"])
        defer { f.store.stop() }
        // Give it a route anyway, so the binding is the check that stops it.
        f.store.routeBySession[f.store.sessionKey(machineID: f.machine, sessionID: Self.sessionA)] = f.childA
        guard case .blocked(let reason) = f.store.openTerminal(machineID: f.machine, sessionID: Self.sessionA) else {
            Issue.record("started"); return
        }
        #expect(reason.contains("not reported its conversation"))
    }

    // MARK: Terminal sending and receiving

    @Test func terminalOpensReadsAndClosesThroughRealFrames() throws {
        let f = try fixture()
        defer { f.store.stop() }
        #expect(f.store.openTerminal(machineID: f.machine, sessionID: Self.sessionA) == .started)
        guard case .open(let open)? = try f.decodedTerminal().last else { Issue.record("no open"); return }

        try f.deliver(.terminalView(openedFor(open)), from: f.childA)
        guard case .read(let read)? = try f.decodedTerminal().last else { Issue.record("no read"); return }
        #expect(read.viewId == Self.view && read.afterRevision == nil)

        let snapshot = SessionTerminalSnapshot(
            header: terminalHeader(), requestId: read.header.id, viewId: Self.view, revision: 4, columns: 10, rows: 1,
            lines: ["hello"], cursor: nil)
        try f.deliver(.terminalView(.snapshot(snapshot)), from: f.childA)
        #expect(f.store.terminalView(machineID: f.machine, sessionID: Self.sessionA)?.screen?.lines == ["hello"])

        f.store.leaveTerminal(machineID: f.machine, sessionID: Self.sessionA)
        guard case .close(let close)? = try f.decodedTerminal().last else { Issue.record("no close"); return }
        #expect(close.viewId == Self.view)
        #expect(f.store.terminalView(machineID: f.machine, sessionID: Self.sessionA)?.screen == nil)
    }

    @Test func blockedLeaveSendsNothingAndLeavesNothingBehind() throws {
        let f = try fixture()
        defer { f.store.stop() }
        _ = f.store.openTerminal(machineID: f.machine, sessionID: Self.sessionA)
        guard case .open(let open)? = try f.decodedTerminal().last else { Issue.record("no open"); return }
        try f.deliver(.terminalView(openedFor(open)), from: f.childA)
        let before = f.sent.frames.count
        f.store.paneTransportPolicy = .current  // the route stops qualifying
        f.store.leaveTerminal(machineID: f.machine, sessionID: Self.sessionA)
        #expect(f.sent.frames.count == before)  // nothing could go out; the host retires the view with the connection
        #expect(f.store.terminalView(machineID: f.machine, sessionID: Self.sessionA)?.state == .closed)
    }

    @Test func framesFromTheWrongEndpointAreDropped() throws {
        let f = try fixture()
        defer { f.store.stop() }
        _ = f.store.openTerminal(machineID: f.machine, sessionID: Self.sessionA)
        guard case .open(let open)? = try f.decodedTerminal().last else { Issue.record("no open"); return }
        let framesBefore = f.sent.frames.count
        // Another session's daemon, and the machine's own hub, both claim to answer for session A.
        for wrong in [f.childB, f.origin] {
            try f.deliver(.terminalView(openedFor(open)), from: wrong)
            #expect(f.store.terminalView(machineID: f.machine, sessionID: Self.sessionA)?.state == .opening)
        }
        #expect(f.sent.frames.count == framesBefore)
        try f.deliver(.terminalView(openedFor(open)), from: f.childA)  // the right one is accepted
        #expect(f.sent.frames.count == framesBefore + 1)
    }

    @Test func unsolicitedFramesWithoutAViewAreIgnored() throws {
        let f = try fixture()
        defer { f.store.stop() }
        let snapshot = SessionTerminalSnapshot(
            header: terminalHeader(), requestId: "00000000-0000-4000-8000-000000000002", viewId: Self.view, revision: 1,
            columns: 4, rows: 1, lines: ["x"], cursor: nil)
        try f.deliver(.terminalView(.snapshot(snapshot)), from: f.childA)
        #expect(f.store.terminalViews.isEmpty)
        f.store.tickPanes()
        #expect(f.sent.frames.isEmpty)
    }

    // MARK: Files

    private func download(_ f: Fixture, path: String = "src/report.txt") throws -> FileFetchBegin {
        #expect(f.store.beginFileDownload(machineID: f.machine, sessionID: Self.sessionA, path: path) == .started)
        guard case .begin(let begin)? = try f.decodedFile().last else {
            Issue.record("no begin")
            throw CancellationError()
        }
        return begin
    }

    @Test func fileDownloadSendsBeginReadCompleteAndNeverExposesPartials() throws {
        let f = try fixture()
        defer { f.store.stop() }
        let begin = try download(f)
        #expect(begin.relativePath == "src/report.txt")
        #expect(begin.binding == AttachedBinding(harness: .claude, harnessSessionId: "claude-a"))

        let data = FileFetchStateMachineTests.payload(FileFetchLimits.chunkBytes + 7)
        let transfer = FileFetchStateMachineTests.transfer
        let header = { (n: Int) in WireHeader(id: String(format: "00000000-0000-4000-8000-%012x", n), timestamp: Self.stamp, sessionId: Self.sessionA) }
        try f.deliver(.fileFetch(.accepted(FileFetchAccepted(
            header: header(1), requestId: begin.header.id, transferId: transfer, fileName: "report.txt",
            byteLength: data.count, digest: FileFetchStateMachineTests.digest(data), expiresAt: "2099-01-01T00:00:00.000Z"))),
            from: f.childA)
        guard case .read(let first)? = try f.decodedFile().last else { Issue.record("no read"); return }
        #expect(first.seq == 0)
        func chunk(_ seq: Int) -> FileFetchMessage {
            let start = seq * FileFetchLimits.chunkBytes
            let slice = data.subdata(in: start..<min(data.count, start + FileFetchLimits.chunkBytes))
            return .chunk(FileFetchChunk(
                header: header(10 + seq), requestId: header(20 + seq).id, transferId: transfer, seq: seq,
                data: WireGuards.encodeBase64URL(slice)))
        }
        try f.deliver(.fileFetch(chunk(0)), from: f.childA)
        #expect(f.store.fileDownload(machineID: f.machine, sessionID: Self.sessionA)?.verifiedFile == nil)
        try f.deliver(.fileFetch(chunk(1)), from: f.childA)
        guard case .complete? = try f.decodedFile().last else { Issue.record("no complete"); return }
        try f.deliver(.fileFetch(.result(FileFetchResult(header: header(30), requestId: header(31).id, transferId: transfer))), from: f.childA)
        #expect(f.store.fileDownload(machineID: f.machine, sessionID: Self.sessionA)?.verifiedFile?.data == data)

        f.store.discardFileDownload(machineID: f.machine, sessionID: Self.sessionA)
        #expect(f.store.fileDownload(machineID: f.machine, sessionID: Self.sessionA) == nil)
    }

    @Test func cancelSendsCancelAndDiscardCancelsARunningDownload() throws {
        let f = try fixture()
        defer { f.store.stop() }
        let begin = try download(f)
        f.store.cancelFileDownload(machineID: f.machine, sessionID: Self.sessionA)
        guard case .cancel(let cancel)? = try f.decodedFile().last else { Issue.record("no cancel"); return }
        #expect(cancel.beginId == begin.header.id)
        #expect(f.store.fileDownload(machineID: f.machine, sessionID: Self.sessionA)?.status == .cancelled)

        let second = try download(f)  // a finished one may be replaced
        f.store.discardFileDownload(machineID: f.machine, sessionID: Self.sessionA)
        guard case .cancel(let again)? = try f.decodedFile().last else { Issue.record("no cancel"); return }
        #expect(again.beginId == second.header.id)
        #expect(f.store.fileDownloads.isEmpty)
    }

    @Test func aRunningDownloadBlocksASecondAndBadPathsSendNothing() throws {
        let f = try fixture()
        defer { f.store.stop() }
        #expect(f.store.beginFileDownload(machineID: f.machine, sessionID: Self.sessionA, path: "a\\b") == .invalidPath(.unsafeCharacter))
        #expect(f.sent.frames.isEmpty)
        _ = try download(f)
        guard case .blocked = f.store.beginFileDownload(machineID: f.machine, sessionID: Self.sessionA, path: "b.txt") else {
            Issue.record("second started"); return
        }
        #expect(f.sent.frames.count == 1)
    }

    @Test func offerForAnotherFileEndsTheDownloadAndCancels() throws {
        let f = try fixture()
        defer { f.store.stop() }
        let begin = try download(f)
        let data = Data([1, 2, 3])
        try f.deliver(.fileFetch(.accepted(FileFetchAccepted(
            header: terminalHeader("00000000-0000-4000-8000-000000000001"), requestId: begin.header.id,
            transferId: FileFetchStateMachineTests.transfer, fileName: "evil.sh", byteLength: 3,
            digest: FileFetchStateMachineTests.digest(data), expiresAt: "2099-01-01T00:00:00.000Z"))), from: f.childA)
        #expect(f.store.fileDownload(machineID: f.machine, sessionID: Self.sessionA)?.status
            == .failed(FileDownloadFlow.text(for: .protocolViolation)))
        guard case .cancel? = try f.decodedFile().last else { Issue.record("no cancel"); return }
    }

    @Test func fileFramesFromTheWrongEndpointAreDropped() throws {
        let f = try fixture()
        defer { f.store.stop() }
        let begin = try download(f)
        let data = Data([1])
        let offer = FileFetchMessage.accepted(FileFetchAccepted(
            header: terminalHeader(), requestId: begin.header.id, transferId: FileFetchStateMachineTests.transfer,
            fileName: "report.txt", byteLength: 1, digest: FileFetchStateMachineTests.digest(data),
            expiresAt: "2099-01-01T00:00:00.000Z"))
        try f.deliver(.fileFetch(offer), from: f.childB)
        #expect(f.store.fileDownload(machineID: f.machine, sessionID: Self.sessionA)?.status == .requesting)
        #expect(f.sent.frames.count == 1)
    }

    // MARK: Connection loss and cleanup

    @Test func lostSessionConnectionInterruptsTheViewAndDiscardsTheDownload() throws {
        let f = try fixture()
        defer { f.store.stop() }
        _ = f.store.openTerminal(machineID: f.machine, sessionID: Self.sessionA)
        _ = try download(f)
        try f.deliver(.fileFetch(.refused(FileFetchRefused(
            header: terminalHeader(), requestId: "00000000-0000-4000-8000-000000000009", operation: .read, code: .busy))),
            from: f.childA)  // unrelated; changes nothing
        let framesBefore = f.sent.frames.count
        // A connection other than the session's does not disturb it.
        try f.deliver(.hello(try Self.frame(["type": "hello_ack", "serverVersion": "1"])), from: f.childB)
        #expect(f.store.terminalView(machineID: f.machine, sessionID: Self.sessionA)?.state == .opening)

        f.store.receive(.stopped, from: f.childA, generation: try f.generation(f.childA))
        #expect(f.store.terminalView(machineID: f.machine, sessionID: Self.sessionA)?.state == .interrupted)
        #expect(f.store.fileDownload(machineID: f.machine, sessionID: Self.sessionA)?.status
            == .failed(FileDownloadFlow.text(for: .disconnected)))
        #expect(f.sent.frames.count == framesBefore)  // a dead connection sends no close or cancel
    }

    @Test func removingTheMachineDropsViewsAndPartialDownloads() throws {
        let f = try fixture()
        defer { f.store.stop() }
        _ = f.store.openTerminal(machineID: f.machine, sessionID: Self.sessionA)
        _ = try download(f)
        #expect(!f.store.terminalViews.isEmpty && !f.store.fileDownloads.isEmpty)
        #expect(f.store.removeMachine(f.origin))
        #expect(f.store.terminalViews.isEmpty && f.store.fileDownloads.isEmpty)
    }

    @Test func aKilledSessionDropsItsViewAndDownloadButNotAnotherSessions() throws {
        let f = try fixture()
        defer { f.store.stop() }
        for session in [Self.sessionA, Self.sessionB] {
            _ = f.store.openTerminal(machineID: f.machine, sessionID: session)
        }
        _ = try download(f)
        let key = f.store.sessionKey(machineID: f.machine, sessionID: Self.sessionA)
        f.store.sessionByKillRequest["kill-1"] = key
        let response: KillSessionResponseMessage = try Self.frame([
            "type": "kill_session_response", "requestId": "kill-1", "success": true, "sessionId": Self.sessionA,
        ])
        try f.deliver(.killSessionResponse(response), from: f.origin)
        #expect(f.store.terminalViews[key] == nil && f.store.fileDownloads[key] == nil)
        #expect(f.store.terminalViews[f.store.sessionKey(machineID: f.machine, sessionID: Self.sessionB)] != nil)
    }

    @Test func sendFailureOnARealConnectionInterruptsInsteadOfHanging() async throws {
        // No injected sink: the real connection is not open, so the send throws and the view is interrupted.
        let f = try fixture()
        defer { f.store.stop() }
        f.store.paneFrameSender = nil
        #expect(f.store.openTerminal(machineID: f.machine, sessionID: Self.sessionA) == .started)
        for _ in 0..<50 where f.store.terminalView(machineID: f.machine, sessionID: Self.sessionA)?.state == .opening {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(f.store.terminalView(machineID: f.machine, sessionID: Self.sessionA)?.state == .interrupted)
    }
}
#endif
