import CryptoKit
import Foundation
import Network
import Testing
@testable import RemiKit

#if os(macOS)
enum PeerError: Error, Equatable, CustomStringConvertible {
    case startupTimedOut(component: String, waitedMilliseconds: Int)
    case startupFailed(component: String, reason: String, waitedMilliseconds: Int)
    case encodingFailed, unexpectedInput

    var description: String {
        switch self {
        case let .startupTimedOut(component, waitedMilliseconds):
            "\(component) was not ready after \(waitedMilliseconds) ms"
        case let .startupFailed(component, reason, waitedMilliseconds):
            "\(component) failed before becoming ready after \(waitedMilliseconds) ms: \(reason)"
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
    private static let listenerReadiness = "NWListener bound and ready to accept loopback TCP connections"
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
    private var listenerEnded = false
    private var connectionEnded = true
    private var connectionReady = false
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
                        terminals: Int, startRequestedAt: ContinuousClock.Instant?, listenerReadyAt: ContinuousClock.Instant?) {
        lock.lock(); defer { lock.unlock() }
        return (port, listenerEnded && connectionEnded, failure, answerCount, resultCount, inputRejected,
                connectionReady, connectionEnded, imageCount, userInputCount, terminalCount, startRequestedAt,
                listenerReadyAt)
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

    func start() {
        lock.lock()
        started = true
        if startRequestedAt == nil { startRequestedAt = clock.now }
        lock.unlock()
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            self.lock.lock(); defer { self.lock.unlock() }
            switch state {
            case .ready:
                guard let port = self.listener.port?.rawValue else {
                    let start = self.startRequestedAt ?? self.clock.now
                    self.failure = .startupFailed(component: Self.listenerReadiness,
                        reason: "NWListener reached .ready without a bound port",
                        waitedMilliseconds: Self.elapsedMilliseconds(from: start, to: self.clock.now))
                    self.listenerEnded = true
                    return
                }
                self.port = port
                self.listenerReadyAt = self.clock.now
            case .failed(let error):
                let start = self.startRequestedAt ?? self.clock.now
                self.failure = .startupFailed(component: Self.listenerReadiness,
                    reason: error.localizedDescription,
                    waitedMilliseconds: Self.elapsedMilliseconds(from: start, to: self.clock.now))
                self.listenerEnded = true
            case .cancelled: self.listenerEnded = true
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            self.accept(connection)
        }
        listener.start(queue: queue)
    }

    func waitForPort(timeout: Duration = .seconds(30)) async throws -> UInt16 {
        let waitStartedAt = startupRequestedAtOrNow()
        let deadline = waitStartedAt.advanced(by: timeout)
        while true {
            let state = snapshot()
            if let failure = state.failure { throw failure }
            if let port = state.port, let ready = state.listenerReadyAt, ready <= deadline {
                if ProcessInfo.processInfo.environment["REMI_TRACE_OWNED_ANSWER_PEER_STARTUP"] == "1",
                   let start = state.startRequestedAt {
                    let elapsed = Self.elapsedMilliseconds(from: start, to: ready)
                    print("OwnedAnswerPeer listener bound and ready to accept loopback TCP connections after \(elapsed) ms")
                }
                return port
            }
            let remaining = clock.now.duration(to: deadline)
            guard remaining > .zero else { break }
            try await Task.sleep(for: min(.milliseconds(10), remaining))
        }
        throw PeerError.startupTimedOut(component: Self.listenerReadiness,
            waitedMilliseconds: Self.elapsedMilliseconds(from: waitStartedAt, to: clock.now))
    }

    func waitForRejection(timeout: Duration = .seconds(3)) async throws {
        let waitStartedAt = clock.now
        let deadline = waitStartedAt.advanced(by: timeout)
        while clock.now < deadline {
            if snapshot().rejected { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw PeerError.startupTimedOut(component: "NWConnection to reject peer input",
            waitedMilliseconds: Self.elapsedMilliseconds(from: waitStartedAt, to: clock.now))
    }

    func waitForConnectionReady(timeout: Duration = .seconds(3)) async throws {
        let waitStartedAt = clock.now
        let deadline = waitStartedAt.advanced(by: timeout)
        while clock.now < deadline {
            if snapshot().connectionReady { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw PeerError.startupTimedOut(component: "NWConnection readiness",
            waitedMilliseconds: Self.elapsedMilliseconds(from: waitStartedAt, to: clock.now))
    }

    func waitForConnectionEnd(timeout: Duration = .seconds(3)) async throws {
        let waitStartedAt = clock.now
        let deadline = waitStartedAt.advanced(by: timeout)
        while clock.now < deadline {
            if snapshot().connectionEnded { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw PeerError.startupTimedOut(component: "NWConnection cancellation",
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

    func stop(timeout: Duration = .seconds(3)) async -> Bool {
        let (shouldWait, connection) = beginStop()
        connection?.cancel()
        listener.cancel()
        guard shouldWait else { return true }
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while ContinuousClock.now < deadline {
            if snapshot().ended { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return snapshot().ended
    }

    private func beginStop() -> (Bool, NWConnection?) {
        lock.lock(); defer { lock.unlock() }
        stopped = true
        return (started, connection)
    }

    private func accept(_ incoming: NWConnection) {
        lock.lock()
        guard !stopped, connection == nil else { lock.unlock(); incoming.cancel(); return }
        connection = incoming; connectionEnded = false
        lock.unlock()
        incoming.stateUpdateHandler = { [weak self, weak incoming] state in
            guard let self, let incoming else { return }
            switch state {
            case .ready:
                self.lock.lock(); self.connectionReady = true; self.lock.unlock()
                let fingerprint = SHA256.hash(data: self.publicKey).map { String(format: "%02x", $0) }.joined()
                self.send("auth_challenge", fields: ["challenge": self.challenge.base64EncodedString(),
                    "serverPublicKey": self.pinnedPublicKey, "serverFingerprint": String(fingerprint.prefix(16))], on: incoming)
                self.receive(on: incoming)
            case .failed:
                self.lock.lock(); self.connectionEnded = true; self.inputRejected = true; self.lock.unlock()
            case .cancelled:
                self.lock.lock(); self.connectionEnded = true; self.lock.unlock()
            default: break
            }
        }
        incoming.start(queue: queue)
    }

    private func receive(on connection: NWConnection) {
        connection.receiveMessage { [weak self, weak connection] data, _, complete, error in
            guard let self, let connection else { return }
            guard error == nil, complete, let data, data.count <= 65_536 else {
                self.lock.lock(); self.inputRejected = true; self.lock.unlock()
                connection.cancel(); return
            }
            guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = object["type"] as? String else {
                self.lock.lock(); self.inputRejected = true; self.lock.unlock()
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

    @Test func unstartedListenerTimesOutAndCancels() async throws {
        let peer = try OwnedAnswerPeer(mode: "unused")
        do {
            _ = try await peer.waitForPort(timeout: .milliseconds(150))
            Issue.record("An unstarted listener cannot become ready")
        } catch let error as PeerError {
            if case let .startupTimedOut(component, waitedMilliseconds) = error {
                #expect(component == "NWListener bound and ready to accept loopback TCP connections")
                #expect(waitedMilliseconds >= 150)
            } else {
                Issue.record("Expected a detailed listener readiness timeout, got \(error)")
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
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while ContinuousClock.now < deadline {
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
