import Foundation

/// Terminal-view and file-download sessions hosted by the store (#1639).
///
/// Every entry point checks, in order: the machine is connected; its `hello_ack` advertises the
/// capability (`HubSupport.check`, never a daemon version); the session's route may carry the
/// family (`PaneTransportPolicy`); the session reported a conversation id to bind to. Any
/// failure returns the reason in plain words and sends nothing. Today `PaneTransportPolicy`
/// blocks every route, so none of this sends a frame; it is built so that a transport can switch
/// it on in one place.
extension MachineStore {
    public enum PaneStart: Sendable, Equatable {
        case started
        case blocked(String)
        case invalidPath(FileDownloadPathIssue)
    }

    private struct PaneRoute {
        let key: MachineSessionKey
        let connection: RemiConnection
        let binding: AttachedBinding
    }

    private static var monotonicNow: TimeInterval { ProcessInfo.processInfo.systemUptime }

    // MARK: Gate

    /// Why a pane cannot be used for this session right now, nil when it can.
    public func paneBlock(machineID: String, sessionID: String, needs capability: HubCapability) -> String? {
        if case .blocked(let reason) = paneRoute(machineID: machineID, sessionID: sessionID, needs: capability) {
            return reason
        }
        return nil
    }

    private enum RouteResult {
        case ready(PaneRoute)
        case blocked(String)
    }

    private func paneRoute(machineID: String, sessionID: String, needs capability: HubCapability) -> RouteResult {
        guard let machine = machine(withIdentifier: machineID), machine.status == .connected,
            let ack = machine.helloAck
        else { return .blocked("Connect to this machine to use this view.") }
        if let message = HubSupport.check(ack, needs: [capability]).message { return .blocked(message) }
        let key = sessionKey(machineID: machineID, sessionID: sessionID)
        guard let route = routeBySession[key], let connection = connections[route] else {
            return .blocked("This session is not connected.")
        }
        if let reason = PaneTransportPolicy.blockReason(for: route) { return .blocked(reason) }
        guard let binding = attachedBinding(of: machine, sessionID: sessionID) else {
            return .blocked("This session has not reported its conversation yet. Try again in a moment.")
        }
        return .ready(PaneRoute(key: key, connection: connection, binding: binding))
    }

    /// The conversation a request names: the daemon's own session, with the harness's own id.
    private func attachedBinding(of machine: MachineState, sessionID: String) -> AttachedBinding? {
        guard let session = machine.sessions.first(where: { $0.sessionId == sessionID && $0.source == "daemon" }),
            let harness = AttachedHarness(rawValue: session.harness ?? "claude")
        else { return nil }
        let id = session.harnessSessionId ?? (harness == .claude ? session.claudeSessionId : nil)
        guard let id, WireGuards.isHarnessSessionId(id) else { return nil }
        return AttachedBinding(harness: harness, harnessSessionId: id)
    }

    private static func stamp() -> String { WireTimestamp.string() }

    private static func newID() -> String { UUID().uuidString.lowercased() }

    // MARK: Terminal

    @discardableResult
    public func openTerminal(machineID: String, sessionID: String) -> PaneStart {
        switch paneRoute(machineID: machineID, sessionID: sessionID, needs: .terminalView) {
        case .blocked(let reason): return .blocked(reason)
        case .ready(let route):
            var controller = terminalViews[route.key] ?? TerminalViewController(sessionId: sessionID)
            let actions = controller.handle(.open, now: Self.monotonicNow, date: Date())
            terminalViews[route.key] = controller
            sendTerminal(actions, route: route)
            return .started
        }
    }

    public func leaveTerminal(machineID: String, sessionID: String) {
        let key = sessionKey(machineID: machineID, sessionID: sessionID)
        guard var controller = terminalViews[key] else { return }
        let actions = controller.handle(.leave, now: Self.monotonicNow, date: Date())
        terminalViews[key] = controller
        sendTerminal(actions, key: key)
    }

    public func terminalView(machineID: String, sessionID: String) -> TerminalViewController? {
        terminalViews[sessionKey(machineID: machineID, sessionID: sessionID)]
    }

    private func sendTerminal(_ actions: [TerminalViewController.Action], key: MachineSessionKey) {
        guard !actions.isEmpty else { return }
        switch paneRoute(machineID: key.machineID, sessionID: key.sessionID, needs: .terminalView) {
        case .ready(let route): sendTerminal(actions, route: route)
        case .blocked: terminalViews[key]?.interrupt()
        }
    }

    private func sendTerminal(_ actions: [TerminalViewController.Action], route: PaneRoute) {
        let sessionID = route.key.sessionID
        let stamp = Self.stamp()
        var frames: [String] = []
        for action in actions {
            let message: TerminalViewMessage
            switch action {
            case .open(let id):
                message = .open(
                    SessionTerminalOpen(
                        header: WireHeader(id: id, timestamp: stamp, sessionId: sessionID), binding: route.binding))
            case .read(let id, let viewId, let after):
                message = .read(
                    SessionTerminalRead(
                        header: WireHeader(id: id, timestamp: stamp, sessionId: sessionID), viewId: viewId,
                        afterRevision: after))
            case .close(let id, let viewId):
                message = .close(
                    SessionTerminalClose(header: WireHeader(id: id, timestamp: stamp, sessionId: sessionID), viewId: viewId))
            }
            guard let frame = try? message.encodedFrame() else {
                terminalViews[route.key]?.interrupt()
                return
            }
            frames.append(frame)
        }
        Task { [weak self] in
            for frame in frames {
                do { try await route.connection.sendEncodedFrame(frame) } catch {
                    await MainActor.run { self?.terminalViews[route.key]?.interrupt() }
                    return
                }
            }
        }
    }

    func receiveTerminalView(_ message: TerminalViewMessage, machineIndex: Int) {
        guard let sessionID = message.sessionId else { return }
        let key = MachineSessionKey(machineID: machines[machineIndex].id, sessionID: sessionID)
        guard var controller = terminalViews[key] else { return }
        let actions = controller.handle(.message(message), now: Self.monotonicNow, date: Date())
        terminalViews[key] = controller
        sendTerminal(actions, key: key)
    }

    // MARK: Files

    @discardableResult
    public func beginFileDownload(machineID: String, sessionID: String, path: String) -> PaneStart {
        let key = sessionKey(machineID: machineID, sessionID: sessionID)
        if let existing = fileDownloads[key], !existing.isFinished {
            return .blocked("A download is already running for this session.")
        }
        switch paneRoute(machineID: machineID, sessionID: sessionID, needs: .fileDownload) {
        case .blocked(let reason): return .blocked(reason)
        case .ready(let route):
            let result = FileDownloadFlow.begin(
                path: path, binding: route.binding, sessionId: sessionID, requestId: Self.newID(),
                timestamp: Self.stamp(), now: Self.monotonicNow)
            switch result {
            case .failure(let issue): return .invalidPath(issue)
            case .success(let started):
                fileDownloads[key] = started.flow
                sendFile([started.message], route: route)
                return .started
            }
        }
    }

    public func cancelFileDownload(machineID: String, sessionID: String) {
        let key = sessionKey(machineID: machineID, sessionID: sessionID)
        applyFile(.cancelRequested, key: key)
    }

    /// Drops the download and its bytes: after Save, or when the sheet is dismissed. A transfer
    /// still running is cancelled first.
    public func discardFileDownload(machineID: String, sessionID: String) {
        let key = sessionKey(machineID: machineID, sessionID: sessionID)
        if fileDownloads[key]?.isFinished == false { applyFile(.cancelRequested, key: key) }
        fileDownloads[key] = nil
    }

    public func fileDownload(machineID: String, sessionID: String) -> FileDownloadFlow? {
        fileDownloads[sessionKey(machineID: machineID, sessionID: sessionID)]
    }

    private func applyFile(_ event: FileFetchStateMachine.Event, key: MachineSessionKey) {
        guard var flow = fileDownloads[key] else { return }
        let messages = flow.handle(event, now: Self.monotonicNow, makeID: Self.newID, timestamp: Self.stamp())
        fileDownloads[key] = flow
        guard !messages.isEmpty else { return }
        guard case .ready(let route) = paneRoute(machineID: key.machineID, sessionID: key.sessionID, needs: .fileDownload)
        else {
            fileDownloads[key]?.markDisconnected(now: Self.monotonicNow)
            return
        }
        sendFile(messages, route: route)
    }

    private func sendFile(_ messages: [FileFetchMessage], route: PaneRoute) {
        var frames: [String] = []
        for message in messages {
            guard let frame = try? message.encodedFrame() else {
                fileDownloads[route.key]?.markDisconnected(now: Self.monotonicNow)
                return
            }
            frames.append(frame)
        }
        Task { [weak self] in
            for frame in frames {
                do { try await route.connection.sendEncodedFrame(frame) } catch {
                    await MainActor.run { self?.fileDownloads[route.key]?.markDisconnected(now: Self.monotonicNow) }
                    return
                }
            }
        }
    }

    func receiveFileFetch(_ message: FileFetchMessage, machineIndex: Int) {
        guard let sessionID = message.sessionId else { return }
        let key = MachineSessionKey(machineID: machines[machineIndex].id, sessionID: sessionID)
        applyFile(.message(message), key: key)
    }

    // MARK: Time and connection loss

    /// Call about twice a second while a pane is on screen: it paces terminal reads and ends a
    /// download or view that has gone quiet.
    public func tickPanes() {
        let now = Self.monotonicNow
        for key in Array(terminalViews.keys) where terminalViews[key]?.isActive == true {
            guard var controller = terminalViews[key] else { continue }
            let actions = controller.handle(.tick, now: now, date: Date())
            terminalViews[key] = controller
            sendTerminal(actions, key: key)
        }
        for key in Array(fileDownloads.keys) where fileDownloads[key]?.isFinished == false {
            applyFile(.tick, key: key)
        }
    }

    /// A session connection went away: a view is interrupted and a download is discarded, never resumed.
    func panesConnectionLost(_ endpoint: MachineEndpoint) {
        for (key, route) in routeBySession where route == endpoint {
            if terminalViews[key]?.isActive == true { terminalViews[key]?.interrupt() }
            if fileDownloads[key]?.isFinished == false { fileDownloads[key]?.markDisconnected(now: Self.monotonicNow) }
        }
    }
}

extension TerminalViewMessage {
    /// The session the frame names.
    var sessionId: String? {
        switch self {
        case .open(let m): m.header.sessionId
        case .opened(let m): m.header.sessionId
        case .read(let m): m.header.sessionId
        case .snapshot(let m): m.header.sessionId
        case .unchanged(let m): m.header.sessionId
        case .close(let m): m.header.sessionId
        case .closed(let m): m.header.sessionId
        case .refused(let m): m.header.sessionId
        }
    }
}

extension FileFetchMessage {
    var sessionId: String? {
        switch self {
        case .begin(let m): m.header.sessionId
        case .accepted(let m): m.header.sessionId
        case .read(let m): m.header.sessionId
        case .chunk(let m): m.header.sessionId
        case .complete(let m): m.header.sessionId
        case .result(let m): m.header.sessionId
        case .cancel(let m): m.header.sessionId
        case .cancelResult(let m): m.header.sessionId
        case .refused(let m): m.header.sessionId
        }
    }
}
