import CryptoKit
import Foundation
import Network
import Testing
@testable import RemiKit

#if os(macOS)
enum PeerError: Error, Equatable, CustomStringConvertible {
    case startupTimedOut(condition: String, lastState: String?, waitedMilliseconds: Int)
    case startupFailed(condition: String, lastState: String?, reason: String, waitedMilliseconds: Int)
    case encodingFailed, unexpectedInput

    var description: String {
        switch self {
        case let .startupTimedOut(condition, lastState, waitedMilliseconds):
            "Timed out after \(waitedMilliseconds) ms waiting for \(condition) " +
                "(last state: \(lastState ?? "not started"))"
        case let .startupFailed(condition, lastState, reason, waitedMilliseconds):
            "Failed after \(waitedMilliseconds) ms waiting for \(condition) " +
                "(last state: \(lastState ?? "not started")): \(reason)"
        case .encodingFailed:
            "The peer could not encode its response"
        case .unexpectedInput:
            "The peer received unexpected input"
        }
    }
}

/// A single synthetic WebSocket peer, bound only to loopback. It exercises the
/// real native client; it is neither a daemon substitute nor a device test.
final class OwnedAnswerPeer: @unchecked Sendable {
    static let listenerReadinessCondition = "NWListener ready with a bound loopback TCP port"
    private let queue = DispatchQueue(label: "remi.test.answer-outcome-peer")
    private let lock = NSLock()
    private let clock = ContinuousClock()
    private let listener: NWListener
    private let mode: String
    private let challenge: Data
    private let signature: Data
    private let publicKey: Data
    private let questionData: Data
    private let helloData: Data
    private var port: UInt16?
    private var started = false
    private var startRequestedAt: ContinuousClock.Instant?
    private var listenerReadyAt: ContinuousClock.Instant?
    private var listenerEndedAt: ContinuousClock.Instant?
    private var lastListenerState: String?
    private var listenerEnded = false
    private var connectionEnded = true
    private var connectionReady = false
    private var connectionEndedAt: ContinuousClock.Instant?
    private var connectionReadyAt: ContinuousClock.Instant?
    private var inputRejectedAt: ContinuousClock.Instant?
    private var lastConnectionState: String?
    private var stopped = false
    private var failure: PeerError?
    private var inputRejected = false
    private var connection: NWConnection?
    private var answerCount = 0
    private var resultCount = 0
    private var imageCount = 0
    private var userInputCount = 0
    private var terminalCount = 0
    let sessionID: String
    let questionID: String

    init(mode: String) throws {
        self.mode = mode
        let key = Curve25519.Signing.PrivateKey()
        let challenge = Data(repeating: 0x23, count: 32)
        let sessionID = "108a8a9e-912e-4d52-9fdd-913c16654f5c"
        let questionID = "a7b9dd3b-40cc-4a37-b254-3c544f2853f3"
        self.challenge = challenge
        self.sessionID = sessionID
        self.questionID = questionID
        publicKey = key.publicKey.rawRepresentation
        signature = try key.signature(for: challenge)
        let harnessID = "09a9e195-b1af-4bd5-b9bf-e64855b16d36"
        var question = try Self.fixture("question_claude_permission")
        var questionBody = try #require(question["question"] as? [String: Any])
        questionBody["id"] = questionID
        question["question"] = questionBody
        question["sessionId"] = sessionID
        question["claudeSessionId"] = harnessID
        question["harnessSessionId"] = harnessID
        questionData = try JSONSerialization.data(withJSONObject: question)
        var hello = try Self.fixture("hello_ack_legacy")
        hello["sessionId"] = sessionID
        hello["claudeSessionId"] = harnessID
        hello["harnessSessionId"] = harnessID
        helloData = try JSONSerialization.data(withJSONObject: hello)
        let websocket = NWProtocolWebSocket.Options()
        websocket.maximumMessageSize = mode == "image-ingress" ? 131_072 : 65_536
        websocket.setClientRequestHandler(queue) { _, _ in
            NWProtocolWebSocket.Response(status: .accept, subprotocol: nil)
        }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
        listener = try NWListener(using: parameters)
    }

    private static func fixture(_ name: String) throws -> [String: Any] {
        return try #require(JSONSerialization.jsonObject(with: FixtureConformanceTests.fixture(name)) as? [String: Any])
    }

    var pinnedPublicKey: String { publicKey.base64EncodedString() }
    func snapshot() -> (port: UInt16?, ended: Bool, failure: PeerError?, answers: Int, results: Int,
                        rejected: Bool, connectionReady: Bool, connectionEnded: Bool, images: Int, inputs: Int,
                        terminals: Int) {
        lock.lock(); defer { lock.unlock() }
        return (port, listenerEnded && connectionEnded, failure, answerCount, resultCount, inputRejected,
                connectionReady, connectionEnded, imageCount, userInputCount, terminalCount)
    }

    private func listenerWaitSnapshot() -> (start: ContinuousClock.Instant?, readyAt: ContinuousClock.Instant?,
                                             port: UInt16?, failure: PeerError?, lastState: String?) {
        lock.lock(); defer { lock.unlock() }
        return (startRequestedAt, listenerReadyAt, port, failure, lastListenerState)
    }

    fileprivate func listenerReadyElapsedSinceStart() -> Duration? {
        lock.lock(); defer { lock.unlock() }
        guard let startRequestedAt, let listenerReadyAt else { return nil }
        return startRequestedAt.duration(to: listenerReadyAt)
    }

    private func connectionWaitSnapshot() -> (readyAt: ContinuousClock.Instant?, rejectedAt: ContinuousClock.Instant?,
                                                endedAt: ContinuousClock.Instant?, lastState: String?) {
        lock.lock(); defer { lock.unlock() }
        return (connectionReadyAt, inputRejectedAt, connectionEndedAt, lastConnectionState)
    }

    private func stopWaitSnapshot() -> (listenerEndedAt: ContinuousClock.Instant?,
                                         connectionEndedAt: ContinuousClock.Instant?, connectionAbsent: Bool) {
        lock.lock(); defer { lock.unlock() }
        return (listenerEndedAt, connectionEndedAt, connection == nil)
    }

    private static func elapsedMilliseconds(from start: ContinuousClock.Instant,
                                            to end: ContinuousClock.Instant) -> Int {
        let components = start.duration(to: end).components
        let milliseconds = components.seconds * 1_000 + components.attoseconds / 1_000_000_000_000_000
        return Int(max(0, milliseconds))
    }

    private func startupRequestedAtOrNow() -> ContinuousClock.Instant {
        lock.lock(); defer { lock.unlock() }
        return startRequestedAt ?? clock.now
    }

    /// Starts the real listener, optionally delaying its start for deadline-boundary tests.
    func start(listenerStartDelay: DispatchTimeInterval = .milliseconds(0)) {
        lock.lock()
        started = true
        if startRequestedAt == nil { startRequestedAt = clock.now }
        lock.unlock()
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            let eventAt = self.clock.now
            let startedAt = self.startupRequestedAtOrNow()
            self.lock.lock(); defer { self.lock.unlock() }
            self.lastListenerState = String(describing: state)
            switch state {
            case .ready:
                guard let port = self.listener.port?.rawValue else {
                    self.failure = .startupFailed(condition: Self.listenerReadinessCondition,
                        lastState: self.lastListenerState, reason: "NWListener reached .ready without a bound port",
                        waitedMilliseconds: Self.elapsedMilliseconds(from: startedAt, to: eventAt))
                    self.listenerEnded = true
                    self.listenerEndedAt = eventAt
                    return
                }
                self.port = port
                if self.listenerReadyAt == nil { self.listenerReadyAt = eventAt }
            case .failed(let error):
                self.failure = .startupFailed(condition: Self.listenerReadinessCondition,
                    lastState: self.lastListenerState, reason: error.localizedDescription,
                    waitedMilliseconds: Self.elapsedMilliseconds(from: startedAt, to: eventAt))
                self.listenerEnded = true
                if self.listenerEndedAt == nil { self.listenerEndedAt = eventAt }
            case .cancelled:
                self.listenerEnded = true
                if self.listenerEndedAt == nil { self.listenerEndedAt = eventAt }
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            self.accept(connection)
        }
        if listenerStartDelay == .milliseconds(0) {
            listener.start(queue: queue)
        } else {
            queue.asyncAfter(deadline: .now() + listenerStartDelay) { [weak self] in
                guard let self else { return }
                self.listener.start(queue: self.queue)
            }
        }
    }

    /// Waits for the actual listener-ready state and its bound loopback port.
    ///
    /// The deadline runs from start() or from this call if the peer has not started.
    /// The 30-second default is a generous bound above the 5 seconds that expired on
    /// hosted runners, not a measured listener latency (#1634). A listener that became
    /// ready before the deadline is accepted even if this poll resumes later. Set
    /// REMI_TRACE_OWNED_ANSWER_PEER_STARTUP=1 to log its ready time.
    func waitForPort(timeout: Duration = .seconds(30)) async throws -> UInt16 {
        let waitStartedAt = startupRequestedAtOrNow()
        let deadline = waitStartedAt.advanced(by: timeout)
        while true {
            let state = listenerWaitSnapshot()
            if let failure = state.failure { throw failure }
            if let port = state.port, let ready = state.readyAt, ready <= deadline {
                if ProcessInfo.processInfo.environment["REMI_TRACE_OWNED_ANSWER_PEER_STARTUP"] == "1",
                   let start = state.start {
                    let elapsed = Self.elapsedMilliseconds(from: start, to: ready)
                    print("\(Self.listenerReadinessCondition) after \(elapsed) ms " +
                        "(last state: \(state.lastState ?? "not started"))")
                }
                return port
            }
            let remaining = clock.now.duration(to: deadline)
            guard remaining > .zero else { break }
            try await Task.sleep(for: min(.milliseconds(10), remaining))
        }
        throw PeerError.startupTimedOut(condition: Self.listenerReadinessCondition,
            lastState: listenerWaitSnapshot().lastState,
            waitedMilliseconds: Self.elapsedMilliseconds(from: waitStartedAt, to: clock.now))
    }

    /// Waits from this call for a rejection recorded by the peer receive path. A rejection
    /// before the deadline still succeeds if this polling task resumes after it. The
    /// 30-second default is a generous bound, not a measured latency (#1634).
    func waitForRejection(timeout: Duration = .seconds(30)) async throws {
        let waitStartedAt = clock.now
        let deadline = waitStartedAt.advanced(by: timeout)
        while true {
            let state = connectionWaitSnapshot()
            if let rejectedAt = state.rejectedAt, rejectedAt <= deadline { return }
            let remaining = clock.now.duration(to: deadline)
            guard remaining > .zero else { break }
            try await Task.sleep(for: min(.milliseconds(10), remaining))
        }
        throw PeerError.startupTimedOut(condition: "peer to reject input",
            lastState: connectionWaitSnapshot().lastState,
            waitedMilliseconds: Self.elapsedMilliseconds(from: waitStartedAt, to: clock.now))
    }

    /// Waits from this call for NWConnection .ready. Readiness before the deadline
    /// still succeeds if this polling task resumes after it. The 30-second default is
    /// a generous bound, not a measured latency (#1634).
    func waitForConnectionReady(timeout: Duration = .seconds(30)) async throws {
        let waitStartedAt = clock.now
        let deadline = waitStartedAt.advanced(by: timeout)
        while true {
            let state = connectionWaitSnapshot()
            if let readyAt = state.readyAt, readyAt <= deadline { return }
            let remaining = clock.now.duration(to: deadline)
            guard remaining > .zero else { break }
            try await Task.sleep(for: min(.milliseconds(10), remaining))
        }
        throw PeerError.startupTimedOut(condition: "NWConnection ready",
            lastState: connectionWaitSnapshot().lastState,
            waitedMilliseconds: Self.elapsedMilliseconds(from: waitStartedAt, to: clock.now))
    }

    /// Waits from this call for NWConnection to end. An end event before the deadline
    /// still succeeds if this polling task resumes after it. The 30-second default is
    /// a generous bound, not a measured latency (#1634).
    func waitForConnectionEnd(timeout: Duration = .seconds(30)) async throws {
        let waitStartedAt = clock.now
        let deadline = waitStartedAt.advanced(by: timeout)
        while true {
            let state = connectionWaitSnapshot()
            if let endedAt = state.endedAt, endedAt <= deadline { return }
            let remaining = clock.now.duration(to: deadline)
            guard remaining > .zero else { break }
            try await Task.sleep(for: min(.milliseconds(10), remaining))
        }
        throw PeerError.startupTimedOut(condition: "connection to end",
            lastState: connectionWaitSnapshot().lastState,
            waitedMilliseconds: Self.elapsedMilliseconds(from: waitStartedAt, to: clock.now))
    }

    /// One bounded adversarial image-boundary frame on an already authenticated test peer.
    func sendImageIngressProbe(_ data: Data) -> Bool {
        lock.lock()
        let current = mode == "image-ingress" && connectionReady && !stopped && data.count <= 131_072 ? connection : nil
        lock.unlock()
        guard let current else { return false }
        queue.async {
            let context = NWConnection.ContentContext(identifier: "test-image-ingress",
                metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
            current.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
        }
        return true
    }

    /// Cancels the listener and accepted connection, waiting up to 30 seconds from
    /// this call. Recorded end events before the deadline count even if this poll resumes later.
    /// This is a generous bound, not a measured latency (#1634).
    func stop(timeout: Duration = .seconds(30)) async -> Bool {
        let waitStartedAt = clock.now
        let deadline = waitStartedAt.advanced(by: timeout)
        let (shouldWait, connection) = beginStop()
        connection?.cancel()
        listener.cancel()
        guard shouldWait else { return true }
        while true {
            let state = stopWaitSnapshot()
            let listenerEndedBeforeDeadline = state.listenerEndedAt.map { $0 <= deadline } ?? false
            let connectionEndedBeforeDeadline = state.connectionAbsent ||
                (state.connectionEndedAt.map { $0 <= deadline } ?? false)
            if listenerEndedBeforeDeadline && connectionEndedBeforeDeadline { return true }
            let remaining = clock.now.duration(to: deadline)
            guard remaining > .zero else { break }
            try? await Task.sleep(for: min(.milliseconds(10), remaining))
        }
        return false
    }

    private func beginStop() -> (Bool, NWConnection?) {
        lock.lock(); defer { lock.unlock() }
        stopped = true
        return (started, connection)
    }

    private func accept(_ incoming: NWConnection) {
        lock.lock()
        guard !stopped, connection == nil else { lock.unlock(); incoming.cancel(); return }
        connection = incoming
        connectionEnded = false
        connectionEndedAt = nil
        connectionReady = false
        connectionReadyAt = nil
        inputRejected = false
        inputRejectedAt = nil
        lastConnectionState = nil
        lock.unlock()
        incoming.stateUpdateHandler = { [weak self, weak incoming] state in
            guard let self, let incoming else { return }
            let eventAt = self.clock.now
            var becameReady = false
            self.lock.lock()
            self.lastConnectionState = String(describing: state)
            switch state {
            case .ready:
                becameReady = true
                self.connectionReady = true
                if self.connectionReadyAt == nil { self.connectionReadyAt = eventAt }
            case .failed:
                self.connectionEnded = true
                if self.connectionEndedAt == nil { self.connectionEndedAt = eventAt }
                self.inputRejected = true
                if self.inputRejectedAt == nil { self.inputRejectedAt = eventAt }
            case .cancelled:
                self.connectionEnded = true
                if self.connectionEndedAt == nil { self.connectionEndedAt = eventAt }
            default: break
            }
            self.lock.unlock()
            guard becameReady else { return }
            let fingerprint = SHA256.hash(data: self.publicKey).map { String(format: "%02x", $0) }.joined()
            self.send("auth_challenge", fields: ["challenge": self.challenge.base64EncodedString(),
                "serverPublicKey": self.pinnedPublicKey,
                "serverFingerprint": String(fingerprint.prefix(16))], on: incoming)
            self.receive(on: incoming)
        }
        incoming.start(queue: queue)
    }

    private func markInputRejected() {
        let eventAt = clock.now
        lock.lock(); defer { lock.unlock() }
        inputRejected = true
        if inputRejectedAt == nil { inputRejectedAt = eventAt }
    }

    private func receive(on connection: NWConnection) {
        connection.receiveMessage { [weak self, weak connection] data, _, complete, error in
            guard let self, let connection else { return }
            guard error == nil, complete, let data, data.count <= 65_536 else {
                self.markInputRejected()
                connection.cancel(); return
            }
            guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = object["type"] as? String else {
                self.markInputRejected()
                connection.cancel(); return
            }
            switch type {
            case "auth_response":
                self.send("auth_result", fields: ["success": true, "serverSignature": self.signature.base64EncodedString()], on: connection)
                self.sendData(self.helloData, on: connection)
                self.sendData(self.questionData, on: connection)
            case "session_list_request":
                guard let requestID = object["id"] as? String else { connection.cancel(); return }
                self.send("session_list_response", fields: ["requestId": requestID, "sessions": []], on: connection)
            case "answer":
                guard let requestID = object["id"] as? String, let sessionID = object["sessionId"] as? String,
                      let questionID = object["questionId"] as? String else { connection.cancel(); return }
                self.lock.lock(); self.answerCount += 1; self.lock.unlock()
                self.sendAnswer(requestID: requestID, sessionID: sessionID, questionID: questionID, on: connection)
            case "user_input":
                self.lock.lock(); self.userInputCount += 1; self.lock.unlock()
            case "session_terminal_open":
                self.lock.lock(); self.terminalCount += 1; self.lock.unlock()
            default:
                if ImageIngressPreflight.isImageType(type) {
                    self.lock.lock(); self.imageCount += 1; self.lock.unlock()
                }
            }
            self.receive(on: connection)
        }
    }

    private func sendAnswer(requestID: String, sessionID: String, questionID: String, on connection: NWConnection) {
        if mode.hasPrefix("mismatch-") {
            let wrong = UUID().uuidString.lowercased()
            sendResult(requestID: mode == "mismatch-request" ? wrong : requestID,
                sessionID: mode == "mismatch-session" ? wrong : sessionID,
                questionID: mode == "mismatch-question" ? wrong : questionID, outcome: "delivered", on: connection)
            queue.asyncAfter(deadline: .now() + .milliseconds(30)) { [weak self, weak connection] in
                guard let self, let connection else { return }
                self.sendResult(requestID: requestID, sessionID: sessionID, questionID: questionID,
                    outcome: "stale-binding", on: connection)
            }
        } else {
            sendResult(requestID: requestID, sessionID: sessionID, questionID: questionID,
                outcome: mode == "non-string" ? 7 : mode, on: connection)
        }
    }

    private func sendResult(requestID: String, sessionID: String, questionID: String,
                            outcome: Any, on connection: NWConnection) {
        lock.lock(); resultCount += 1; lock.unlock()
        send("answer_result", fields: ["requestId": requestID, "sessionId": sessionID,
            "questionId": questionID, "outcome": outcome], on: connection)
    }

    private func send(_ type: String, fields: [String: Any], on connection: NWConnection) {
        var frame: [String: Any] = ["type": type, "id": UUID().uuidString.lowercased(), "timestamp": Date().ISO8601Format()]
        frame.merge(fields) { _, next in next }
        guard JSONSerialization.isValidJSONObject(frame),
              let data = try? JSONSerialization.data(withJSONObject: frame) else {
            lock.lock(); failure = .encodingFailed; lock.unlock(); connection.cancel(); return
        }
        sendData(data, on: connection)
    }

    private func sendData(_ data: Data, on connection: NWConnection) {
        guard data.count <= 65_536 else {
            lock.lock(); failure = .encodingFailed; lock.unlock(); connection.cancel(); return
        }
        let context = NWConnection.ContentContext(identifier: "test-text",
            metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
        connection.send(content: data, contentContext: context, isComplete: true,
            completion: .contentProcessed { _ in })
    }
}

/// The controlled peer tests the real direct connection and Store without
/// external processes, a user hub, or user/device data.
@MainActor @Suite(.serialized)
struct AnswerOutcomeWireTests {
    @Test(arguments: [
        ("delivered", "delivered"), ("stale", "stale"),
        ("stale-binding", "stale"), ("session-not-found", "stale"),
        ("conflict", "conflict"), ("busy", "busy"), ("uncertain", "uncertain"),
        ("future-outcome", "uncertain"), ("STALE-BINDING", "uncertain"), ("refused", "uncertain"),
    ])
    func secureNotificationOutcomeUsesTheSharedWireVocabulary(input: String, expected: String) {
        #expect(RelayNotificationAnswerOutcome.fromWire(input).rawValue == expected)
    }

    @Test func listenerReadyBeforeDeadlineSurvivesLatePoll() async throws {
        let peer = try OwnedAnswerPeer(mode: "unused")
        let clock = ContinuousClock()
        peer.start()
        do {
            let readinessDeadline = clock.now.advanced(by: .seconds(30))
            var readyElapsed: Duration?
            while clock.now < readinessDeadline {
                if peer.snapshot().port != nil {
                    readyElapsed = peer.listenerReadyElapsedSinceStart()
                    break
                }
                try await Task.sleep(for: .milliseconds(10))
            }
            let elapsed = try #require(readyElapsed)
            let timeout = elapsed + .milliseconds(50)
            // Poll well after the observed ready instant and its short deadline.
            try await Task.sleep(for: .milliseconds(300))
            let port = try await peer.waitForPort(timeout: timeout)
            #expect(port > 0)
        } catch {
            #expect(await peer.stop())
            throw error
        }
        #expect(await peer.stop())
    }

    @Test func listenerDeadlineRemainsAnchoredAtStartRequest() async throws {
        let peer = try OwnedAnswerPeer(mode: "unused")
        peer.start(listenerStartDelay: .milliseconds(300))
        do {
            // First wait for the real delayed listener, then prove a later short wait
            // still uses the original start time rather than granting a fresh budget.
            let port = try await peer.waitForPort()
            #expect(port > 0)
            do {
                _ = try await peer.waitForPort(timeout: .milliseconds(50))
                Issue.record("A timeout shorter than listener startup must remain anchored at start()")
            } catch let error as PeerError {
                if case let .startupTimedOut(condition, lastState, waitedMilliseconds) = error {
                    #expect(condition == OwnedAnswerPeer.listenerReadinessCondition)
                    #expect(lastState?.localizedCaseInsensitiveContains("ready") == true)
                    #expect(waitedMilliseconds >= 300)
                } else {
                    Issue.record("Expected a listener readiness timeout, got \(error)")
                }
            }
        } catch {
            #expect(await peer.stop())
            throw error
        }
        #expect(await peer.stop())
    }

    @Test func unstartedListenerTimesOutAndCancels() async throws {
        let peer = try OwnedAnswerPeer(mode: "unused")
        do {
            _ = try await peer.waitForPort(timeout: .milliseconds(150))
            Issue.record("An unstarted listener cannot become ready")
        } catch let error as PeerError {
            if case let .startupTimedOut(condition, lastState, waitedMilliseconds) = error {
                #expect(condition == OwnedAnswerPeer.listenerReadinessCondition)
                #expect(lastState == nil)
                #expect(waitedMilliseconds >= 150)
                #expect(error.description.contains("last state: not started"))
            } else {
                Issue.record("Expected a detailed listener timeout, got \(error)")
            }
        }
        #expect(await peer.stop())
    }

    @Test func oversizedFrameIsRejectedAndListenerCancels() async throws {
        let peer = try OwnedAnswerPeer(mode: "oversized")
        peer.start()
        do {
            let port = try await peer.waitForPort()
            let session = URLSession(configuration: .ephemeral)
            defer { session.invalidateAndCancel() }
            let socket = session.webSocketTask(with: try #require(URL(string: "ws://127.0.0.1:\(port)/ws")))
            socket.resume()
            try await peer.waitForConnectionReady()
            let sending = Task { try? await socket.send(.data(Data(repeating: 0x41, count: 65_537))) }
            do { try await peer.waitForRejection() }
            catch { sending.cancel(); socket.cancel(with: .goingAway, reason: nil); throw error }
            sending.cancel(); socket.cancel(with: .goingAway, reason: nil)
        } catch {
            #expect(await peer.stop()); throw error
        }
        #expect(peer.snapshot().rejected)
        #expect(peer.snapshot().answers == 0)
        #expect(await peer.stop())
    }

    @Test(arguments: ["delivered", "stale", "stale-binding", "session-not-found", "conflict", "busy", "uncertain", "future-outcome", "STALE-BINDING", "non-string", "mismatch-request", "mismatch-session", "mismatch-question"])
    func localNotificationClassifiesCorrelatedWireOutcome(_ wireOutcome: String) async throws {
        let peer = try OwnedAnswerPeer(mode: wireOutcome)
        peer.start()
        var store: MachineStore?
        do {
            let port = try await peer.waitForPort()
            let endpoint = MachineEndpoint(host: "127.0.0.1", port: Int(port), expectedPublicKey: peer.pinnedPublicKey)
            let current = MachineStore(endpoints: [endpoint], identity: ClientIdentity(), clientVersion: "owned", clientId: "owned")
            store = current
            current.start()
            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: .seconds(5))
            while clock.now < deadline {
                if current.machines.first?.status == .connected, current.machines.first?.questions.count == 1 { break }
                try await Task.sleep(for: .milliseconds(20))
            }
            let machine = try #require(current.machines.first)
            #expect(machine.status == .connected)
            let destination = RemiNavigationDestination(machineID: machine.id, sessionID: peer.sessionID, questionID: peer.questionID)
            let plan = try #require(current.localQuestionNotification(for: destination))
            let outcome = await current.answerLocalNotification(plan, identifier: LocalQuestionNotificationPlan.noIdentifier)
            switch wireOutcome {
            case "delivered": #expect(outcome == .delivered)
            case "stale", "stale-binding", "session-not-found", "mismatch-request", "mismatch-session", "mismatch-question": #expect(outcome == .stale)
            case "busy": #expect(outcome == .busy)
            default: #expect(outcome == .uncertain)
            }
            if ["future-outcome", "STALE-BINDING", "non-string"].contains(wireOutcome) {
                // The malformed frame closes the admitted connection; merely
                // timing out for some unrelated reason is not this control.
                try await peer.waitForConnectionEnd()
            } else {
                #expect(!peer.snapshot().connectionEnded, "A valid correlated outcome must not close the connection")
            }
            // A receipt alone is not authoritative question removal or permission to replay.
            #expect(current.machines.first?.questions.count == 1)
            #expect(peer.snapshot().answers == 1, "The native client must not replay the answer")
            #expect(peer.snapshot().results == (wireOutcome.hasPrefix("mismatch-") ? 2 : 1))
            current.stop()
        } catch {
            store?.stop(); #expect(await peer.stop()); throw error
        }
        #expect(await peer.stop())
    }
}
#endif
