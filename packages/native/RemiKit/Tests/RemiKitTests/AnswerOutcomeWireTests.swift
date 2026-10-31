import CryptoKit
import Foundation
import Network
import Testing
@testable import RemiKit

#if os(macOS)
private enum PeerError: Error, Equatable {
    case startupTimedOut, startupFailed, encodingFailed, unexpectedInput
}

/// A single synthetic WebSocket peer, bound only to loopback. It exercises the
/// real native client; it is neither a daemon substitute nor a device test.
private final class OwnedAnswerPeer: @unchecked Sendable {
    private let queue = DispatchQueue(label: "remi.test.answer-outcome-peer")
    private let lock = NSLock()
    private let listener: NWListener
    private let mode: String
    private let challenge: Data
    private let signature: Data
    private let publicKey: Data
    private let questionData: Data
    private let helloData: Data
    private var port: UInt16?
    private var started = false
    private var listenerEnded = false
    private var connectionEnded = true
    private var connectionReady = false
    private var stopped = false
    private var failure: PeerError?
    private var inputRejected = false
    private var connection: NWConnection?
    private var answerCount = 0
    private var resultCount = 0
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
        websocket.maximumMessageSize = 65_536
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
                        rejected: Bool, connectionReady: Bool, connectionEnded: Bool) {
        lock.lock(); defer { lock.unlock() }
        return (port, listenerEnded && connectionEnded, failure, answerCount, resultCount, inputRejected,
                connectionReady, connectionEnded)
    }

    func start() {
        lock.lock(); started = true; lock.unlock()
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            self.lock.lock(); defer { self.lock.unlock() }
            switch state {
            case .ready: self.port = self.listener.port?.rawValue
            case .failed: self.failure = .startupFailed; self.listenerEnded = true
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

    func waitForPort(timeout: Duration = .seconds(5)) async throws -> UInt16 {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while ContinuousClock.now < deadline {
            let state = snapshot()
            if let failure = state.failure { throw failure }
            if let port = state.port { return port }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw PeerError.startupTimedOut
    }

    func waitForRejection(timeout: Duration = .seconds(3)) async throws {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while ContinuousClock.now < deadline {
            if snapshot().rejected { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw PeerError.startupTimedOut
    }

    func waitForConnectionReady(timeout: Duration = .seconds(3)) async throws {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while ContinuousClock.now < deadline {
            if snapshot().connectionReady { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw PeerError.startupTimedOut
    }

    func waitForConnectionEnd(timeout: Duration = .seconds(3)) async throws {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while ContinuousClock.now < deadline {
            if snapshot().connectionEnded { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw PeerError.startupTimedOut
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
            default: break
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
            #expect(error == .startupTimedOut)
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
