import CryptoKit
import Foundation

public struct RemiConnectionConfiguration: Sendable, Equatable {
    public let url: URL
    public let clientVersion: String
    public let clientId: String
    public let deviceId: String?
    public let expectedServerFingerprint: String?
    public let expectedServerPublicKey: String?
    public let pairingNonce: String?
    public let pairingLabel: String?
    public let relayPin: RelayMachinePin?

    public init(
        url: URL,
        clientVersion: String,
        clientId: String,
        deviceId: String? = nil,
        expectedServerFingerprint: String? = nil,
        expectedServerPublicKey: String? = nil,
        pairingNonce: String? = nil,
        pairingLabel: String? = nil,
        relayPin: RelayMachinePin? = nil
    ) {
        self.url = url
        self.clientVersion = clientVersion
        self.clientId = clientId
        self.deviceId = deviceId
        self.expectedServerFingerprint = expectedServerFingerprint
        self.expectedServerPublicKey = expectedServerPublicKey
        self.pairingNonce = pairingNonce
        self.pairingLabel = pairingLabel
        self.relayPin = relayPin
    }
}

public enum RemiConnectionState: Sendable, Equatable {
    case stopped
    case connecting(attempt: Int)
    case authenticating(serverFingerprint: String)
    case awaitingLocalApproval(fingerprint: String)
    case awaitingRelayConfirmation(fingerprint: String)
    case connected(sessionId: String?)
    case retrying(attempt: Int, delaySeconds: Double)
    case rejected(reason: String)
}

public enum RemiInboundEvent: Sendable, Equatable {
    case hello(HelloAckMessage)
    case sessions(SessionListResponse)
    case question(QuestionMessage)
    case questionResolved(QuestionResolvedMessage)
    case questionSnapshot(QuestionSnapshotMessage)
    case transcript(TranscriptContentMessage)
    case transcriptComplete(TranscriptLoadCompleteMessage)
    case sessionViews(SessionViewsMessage)
    case recentRepositories(RecentRepositoriesResponseMessage)
    case createSessionResponse(CreateSessionResponseMessage)
    case resumeSessionResponse(ResumeSessionResponseMessage)
    case killSessionResponse(KillSessionResponseMessage)
    case sessionUpdate(SessionUpdateMessage)
    case error(ErrorMessage)
    case relayReady
    case answerResult(AnswerResultMessage)
    case pushRegistration(RelayPushResponse)
    case relayStreamEnded(clean: Bool)
    case unsupported(type: String)
}

public enum RemiConnectionError: Error, Sendable, Equatable {
    case nonTextFrame
    case malformedMessage
    case authentication(String)
}

/// One authenticated daemon connection with bounded exponential reconnect.
/// Unknown client keys pause in `awaitingLocalApproval` until `retryAfterApproval()` is called.
public actor RemiConnection {
    public typealias StateHandler = @Sendable (RemiConnectionState) -> Void
    public typealias EventHandler = @Sendable (RemiInboundEvent) -> Void
    public typealias ReadyHandler = @Sendable () async throws -> Void

    private let configuration: RemiConnectionConfiguration
    private let identity: ClientIdentity
    private let stateHandler: StateHandler
    private let eventHandler: EventHandler
    private let readyHandler: ReadyHandler?
    private var session = URLSession.shared
    private var singleAttempt = false
    private var applicationHello = true
    #if DEBUG
    private var ownedBeforeH2: (@Sendable () async throws -> Void)?
    #endif
    private var ready = false
    private var readyWaiters: [UUID: CheckedContinuation<Void, any Error>] = [:]
    private var rpcWaiters: [String: RelayRPCWaiter] = [:]
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private var state: RemiConnectionState = .stopped
    private var socket: URLSessionWebSocketTask?
    private var runTask: Task<Void, Never>?
    private var pendingAuthentication: PendingAuthentication?
    private var shouldRun = false
    private var relayHandshake: RelayHandshake?
    private var relayChannel: RelayChannel?
    private var relaySecret: Data?
    private let relayPairingExpiresAt: UInt64?
    private var relayEnrolled: Bool
    private var relayDeadline: Task<Void, Never>?
    private var sendTail: Task<Void, Never>?
    private var pendingSends = 0
    private var relayClosing = false

    public init(
        configuration: RemiConnectionConfiguration,
        identity: ClientIdentity,
        relayPairingSecret: Data? = nil,
        relayPairingExpiresAt: UInt64? = nil,
        readyHandler: ReadyHandler? = nil,
        stateHandler: @escaping StateHandler,
        eventHandler: @escaping EventHandler
    ) {
        self.configuration = configuration
        self.identity = identity
        self.relaySecret = relayPairingSecret
        self.relayPairingExpiresAt = relayPairingExpiresAt
        relayEnrolled = relayPairingSecret == nil
        self.stateHandler = stateHandler
        self.eventHandler = eventHandler
        self.readyHandler = readyHandler
    }

    func configureOneShot() throws {
        guard !shouldRun else { throw RelayFailure.state }
        singleAttempt = true; applicationHello = false
    }
    #if DEBUG
    /// Owned integration sessions only; production always uses normal URLSession trust.
    func useOwnedTestSession(_ session: URLSession) throws {
        guard !shouldRun else { throw RelayFailure.state }
        self.session = session
    }
    func beforeOwnedH2(_ callback: @escaping @Sendable () async throws -> Void) throws {
        guard !shouldRun else { throw RelayFailure.state }; ownedBeforeH2 = callback
    }
    #endif

    func waitForRelayReady(until deadline: ContinuousClock.Instant) async throws {
        if ready { return }
        guard deadline > .now else { throw RelayFailure.expired }
        let id = UUID()
        let timeout = Task {
            do { try await Task.sleep(until: deadline, clock: .continuous) } catch { return }
            self.expireReady(id)
        }
        defer { timeout.cancel() }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { readyWaiters[id] = $0 }
        } onCancel: { Task { await self.expireReady(id) } }
    }
    private func expireReady(_ id: UUID) { readyWaiters.removeValue(forKey: id)?.resume(throwing: RelayFailure.closed) }

    func exchange<T: Encodable & Sendable>(_ message: T, id: String, expected: RelayRPCExpected,
        until deadline: ContinuousClock.Instant, validate: @escaping @Sendable () throws -> Void) async throws -> RelayRPCResult {
        guard ready, rpcWaiters.count < 8, rpcWaiters[id] == nil, deadline > .now else { throw RelayFailure.closed }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let timeout = Task {
                    do { try await Task.sleep(until: deadline, clock: .continuous) } catch { return }
                    self.finishRPC(id, result: .failure(RelayFailure.closed))
                }
                rpcWaiters[id] = .init(expected: expected, continuation: continuation, timeout: timeout)
                Task {
                    do { try await self.send(message, validateBeforeSend: validate) }
                    catch { self.finishRPC(id, result: .failure(error)) }
                }
            }
        } onCancel: { Task { await self.finishRPC(id, result: .failure(CancellationError())) } }
    }
    private func finishRPC(_ id: String, result: Result<RelayRPCResult, any Error>) {
        guard let pending = rpcWaiters.removeValue(forKey: id) else { return }
        pending.timeout.cancel(); pending.continuation.resume(with: result)
    }

    public func start() {
        guard !shouldRun else { return }
        shouldRun = true
        runTask = Task { await run() }
    }

    public func stop() async {
        shouldRun = false
        if configuration.relayPin != nil, let task = socket, relayChannel != nil, !relayClosing {
            relayClosing = true
            // The deadline also bounds an in-flight transport send; a BYE is attempted behind it.
            armRelayDeadline(task, after: .seconds(1))
            do { try await sendRelayBye(on: task) } catch { relayChannel?.fail() }
        }
        let running = runTask
        running?.cancel()
        runTask = nil
        closeSocket()
        await running?.value
        transition(to: .stopped)
    }

    /// Call after the user has run the displayed `remi authorize …` command locally.
    public func retryAfterApproval() {
        guard case .awaitingLocalApproval = state else { return }
        shouldRun = true
        runTask?.cancel()
        runTask = Task { await run() }
    }

    public func send<T: Encodable & Sendable>(_ message: T,
        validateBeforeSend: (@Sendable () throws -> Void)? = nil) async throws {
        guard let socket else { throw URLError(.notConnectedToInternet) }
        let data = try encoder.encode(message)
        if configuration.relayPin != nil {
            guard relayChannel != nil, !relayClosing, pendingSends < 64 else { throw RelayFailure.closed }
            guard !data.isEmpty, data.count <= RelayCrypto.maxPlaintext else { throw RelayFailure.oversize }
            pendingSends += 1
            let prior = sendTail
            let job = Task {
                await prior?.value
                guard self.socket === socket, let channel = self.relayChannel else { throw RelayFailure.closed }
                try validateBeforeSend?()
                let frame: Data
                do { frame = try channel.seal(data) }
                catch {
                    if channel.closed {
                        socket.cancel(with: .init(rawValue: 4400) ?? .policyViolation, reason: Data("closed".utf8))
                    }
                    throw error
                }
                do {
                    try await socket.send(.data(frame))
                } catch {
                    channel.fail()
                    socket.cancel(with: .init(rawValue: 4400) ?? .policyViolation,
                        reason: Data("closed".utf8))
                    throw error
                }
            }
            sendTail = Task { _ = try? await job.value }
            defer { pendingSends -= 1 }
            try await job.value
        } else {
            try await socket.send(.data(data))
        }
    }

    private func run() async {
        var attempt = 0
        while shouldRun && !Task.isCancelled {
            attempt += 1
            transition(to: .connecting(attempt: attempt))
            do {
                try await connectAndReceive()
                closeSocket()
                if singleAttempt { shouldRun = false; return }
                if case .awaitingLocalApproval = state { return }
                if case .rejected = state { return }
            } catch is CancellationError {
                return
            } catch {
                if configuration.relayPin != nil {
                    if let channel = relayChannel { eventHandler(.relayStreamEnded(clean: channel.peerEnded && !channel.failed)) }
                    socket?.cancel(with: .init(rawValue: 4400) ?? .policyViolation, reason: Data("closed".utf8))
                }
                closeSocket()
                if singleAttempt { shouldRun = false; transition(to: .rejected(reason: "The relay attempt ended.")); return }
                if configuration.relayPin != nil && (!relayEnrolled || attempt >= 5 || error is RelayFailure) {
                    shouldRun = false
                    transition(to: .rejected(reason: "The relay connection closed. Pair again if this machine has not been saved."))
                    return
                }
            }

            guard shouldRun && !Task.isCancelled else { return }
            let delay = Self.reconnectDelay(forAttempt: attempt)
            transition(to: .retrying(attempt: attempt, delaySeconds: delay))
            do {
                try await Task.sleep(for: .seconds(delay))
            } catch {
                return
            }
        }
    }

    private func connectAndReceive() async throws {
        if let pin = configuration.relayPin {
            try await connectRelayAndReceive(pin)
            return
        }
        pendingAuthentication = nil
        let task = session.webSocketTask(with: configuration.url)
        socket = task
        task.resume()
        try await sendHello(on: task)

        while shouldRun && !Task.isCancelled {
            let message = try await task.receive()
            let data: Data
            switch message {
            case .string(let text):
                guard let value = text.data(using: .utf8) else {
                    throw RemiConnectionError.malformedMessage
                }
                data = value
            case .data(let value):
                data = value
            @unknown default:
                throw RemiConnectionError.nonTextFrame
            }
            try await handle(data, on: task)
        }
    }

    private func handle(_ data: Data, on task: URLSessionWebSocketTask) async throws {
        let envelope = try decoder.decode(Envelope.self, from: data)
        if configuration.relayPin != nil && ["auth_challenge", "auth_result", "raw_pty_output", "terminal_resize"].contains(envelope.type) {
            throw RelayFailure.type
        }
        switch envelope.type {
        case "auth_challenge":
            let challenge = try decoder.decode(AuthChallengeMessage.self, from: data)
            if let expected = configuration.expectedServerFingerprint,
               challenge.serverFingerprint != expected {
                shouldRun = false
                closeSocket()
                transition(to: .rejected(reason: "The daemon fingerprint does not match the scanned pairing code."))
                return
            }
            if let expected = configuration.expectedServerPublicKey,
               challenge.serverPublicKey != expected {
                shouldRun = false
                closeSocket()
                transition(to: .rejected(reason: "The daemon public key does not match the scanned pairing code."))
                return
            }
            transition(to: .authenticating(serverFingerprint: challenge.serverFingerprint))
            let (response, pending) = try AuthenticationHandshake.response(
                to: challenge,
                identity: identity,
                expectedServerPublicKey: configuration.expectedServerPublicKey,
                pairingNonce: configuration.pairingNonce,
                pairingLabel: configuration.pairingLabel
            )
            pendingAuthentication = pending
            try await task.send(.data(encoder.encode(response)))
        case "auth_result":
            let result = try decoder.decode(AuthResultMessage.self, from: data)
            guard result.success else {
                pendingAuthentication = nil
                closeSocket()
                if result.error == "UNKNOWN_KEY" {
                    shouldRun = false
                    transition(to: .awaitingLocalApproval(fingerprint: identity.fingerprint))
                    return
                }
                if Self.shouldRetryAuthentication(result.error) {
                    closeSocket()
                    return
                }
                shouldRun = false
                transition(to: .rejected(reason: Self.authenticationDescription(result.error)))
                return
            }
            try AuthenticationHandshake.verify(result, pending: pendingAuthentication)
            pendingAuthentication = nil
            try await sendHello(on: task)
        case "hello_ack":
            let message = try decoder.decode(HelloAckMessage.self, from: data)
            transition(to: .connected(sessionId: message.sessionId))
            eventHandler(.hello(message))
        case "ping":
            let ping = try decoder.decode(PingMessage.self, from: data)
            try await send(PongMessage(
                id: UUID().uuidString.lowercased(),
                timestamp: Date().ISO8601Format(),
                pingId: ping.id
            ))
        case "session_list_response":
            eventHandler(.sessions(try decoder.decode(SessionListResponse.self, from: data)))
        case "question":
            eventHandler(.question(try decoder.decode(QuestionMessage.self, from: data)))
        case "question_resolved":
            eventHandler(.questionResolved(try decoder.decode(QuestionResolvedMessage.self, from: data)))
        case "question_snapshot":
            eventHandler(.questionSnapshot(try decoder.decode(QuestionSnapshotMessage.self, from: data)))
        case "transcript_content":
            eventHandler(.transcript(try decoder.decode(TranscriptContentMessage.self, from: data)))
        case "transcript_load_complete":
            eventHandler(.transcriptComplete(
                try decoder.decode(TranscriptLoadCompleteMessage.self, from: data)
            ))
        case "session_views":
            eventHandler(.sessionViews(try decoder.decode(SessionViewsMessage.self, from: data)))
        case "recent_repositories_response":
            eventHandler(.recentRepositories(
                try decoder.decode(RecentRepositoriesResponseMessage.self, from: data)
            ))
        case "create_session_response":
            eventHandler(.createSessionResponse(
                try decoder.decode(CreateSessionResponseMessage.self, from: data)
            ))
        case "resume_session_response":
            eventHandler(.resumeSessionResponse(
                try decoder.decode(ResumeSessionResponseMessage.self, from: data)
            ))
        case "kill_session_response":
            eventHandler(.killSessionResponse(
                try decoder.decode(KillSessionResponseMessage.self, from: data)
            ))
        case "session_update":
            eventHandler(.sessionUpdate(try decoder.decode(SessionUpdateMessage.self, from: data)))
        case "error":
            eventHandler(.error(try decoder.decode(ErrorMessage.self, from: data)))
        case "answer_result":
            let result = try decoder.decode(AnswerResultMessage.self, from: data)
            guard ["delivered", "stale", "conflict", "busy", "uncertain"].contains(result.outcome) else { throw RelayFailure.malformed }
            if let pending = rpcWaiters[result.requestId], case .answer(let session, let question) = pending.expected,
               Data(result.sessionId.utf8) == Data(session.utf8), Data(result.questionId.utf8) == Data(question.utf8) {
                finishRPC(result.requestId, result: .success(.answer(result)))
            }
            eventHandler(.answerResult(result))
        case "secure_push_register_response", "secure_push_unregister_response":
            let result = try RelayPushResponse.decode(data)
            if let pending = rpcWaiters[result.requestId], case .push(let type, let version) = pending.expected,
               result.type == type, !result.success || result.keyVersion == version {
                finishRPC(result.requestId, result: .success(.push(result)))
            }
            eventHandler(.pushRegistration(result))
        default:
            eventHandler(.unsupported(type: envelope.type))
        }
    }

    private func sendHello(on task: URLSessionWebSocketTask) async throws {
        let message = HelloMessage(
            id: UUID().uuidString.lowercased(),
            timestamp: Date().ISO8601Format(),
            clientVersion: configuration.clientVersion,
            clientId: configuration.clientId,
            deviceId: configuration.deviceId
        )
        if configuration.relayPin != nil { try await send(message) }
        else { try await task.send(.data(encoder.encode(message))) }
    }

    private func closeSocket() {
        ready = false
        let waiting = readyWaiters; readyWaiters.removeAll()
        for waiter in waiting.values { waiter.resume(throwing: RelayFailure.closed) }
        for id in Array(rpcWaiters.keys) { finishRPC(id, result: .failure(RelayFailure.closed)) }
        pendingAuthentication = nil
        relayDeadline?.cancel()
        relayDeadline = nil
        relayHandshake?.abort()
        relayHandshake = nil
        relaySecret = nil
        relayChannel?.close()
        relayChannel = nil
        sendTail = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    private func connectRelayAndReceive(_ pin: RelayMachinePin) async throws {
        guard let url = pin.clientURL else { throw RelayFailure.malformed }
        let machine = try RelayCrypto.unb64(pin.machinePublicKey)
        let room = RelayCrypto.room(machine)
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = RelayCrypto.maxFrame
        socket = task
        relayClosing = false
        var phase = "nonce"
        let began = ContinuousClock.now
        armRelayDeadline(task, after: .seconds(30))
        task.resume()
        defer {
            relayDeadline?.cancel()
            relayHandshake?.abort()
        }
        while shouldRun && !Task.isCancelled {
            let frame = try await task.receive()
            guard socket === task else { throw RelayFailure.closed }
            if !relayEnrolled, let expiry = relayPairingExpiresAt,
               Date().timeIntervalSince1970 >= Double(expiry) { throw RelayFailure.expired }
            if let channel = relayChannel {
                guard case .data(let bytes) = frame else { channel.fail(); throw RelayFailure.type }
                guard let plaintext = try channel.open(bytes) else {
                    relayClosing = true
                    armRelayDeadline(task, after: .seconds(1))
                    try await sendRelayBye(on: task)
                    eventHandler(.relayStreamEnded(clean: !channel.failed))
                    task.cancel(with: .normalClosure, reason: Data("closed".utf8))
                    return
                }
                guard String(data: plaintext, encoding: .utf8) != nil else { throw RelayFailure.malformed }
                do { try await handle(plaintext, on: task) }
                catch { throw RelayFailure.malformed }
                continue
            }
            guard case .string(let text) = frame, text.utf8.count <= 512 else { throw RelayFailure.type }
            switch phase {
            case "nonce":
                guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                      object["t"] as? String == "nonce", let encoded = object["n"] as? String,
                      text == "{\"t\":\"nonce\",\"n\":\"\(encoded)\"}"
                else { throw RelayFailure.malformed }
                let nonce = try RelayCrypto.unb64(encoded)
                guard nonce.count == 32 else { throw RelayFailure.malformed }
                let input = try RelayCrypto.tuple(RelayCrypto.text("remi-relay-v2 admit client"), room, nonce)
                let signature = try identity.signature(for: input)
                var admit = "{\"t\":\"admit\",\"k\":\"\(RelayCrypto.b64(identity.publicKeyRaw))\",\"s\":\"\(RelayCrypto.b64(signature))\""
                if let secret = relaySecret {
                    let ticket = Data(HMAC<SHA256>.authenticationCode(for: RelayCrypto.text("remi-relay-v2 admit"), using: SymmetricKey(data: secret)))
                    admit += ",\"a\":\"\(RelayCrypto.b64(ticket))\""
                }
                try await task.send(.string(admit + "}"))
                phase = "admitted"
            case "admitted":
                guard text == "{\"t\":\"admitted\",\"up\":true}" || text == "{\"t\":\"admitted\",\"up\":false}" else { throw RelayFailure.malformed }
                phase = "open"
            case "open":
                if text == "{\"t\":\"host\",\"up\":true}" || text == "{\"t\":\"host\",\"up\":false}" { continue }
                guard text == "{\"t\":\"open\"}" else { throw RelayFailure.malformed }
                let handshake = try RelayHandshake.start(machine: machine, identity: identity, secret: relaySecret)
                relayHandshake = handshake
                try await task.send(.string(handshake.hello))
                phase = "ack"
            case "ack":
                guard let handshake = relayHandshake else { throw RelayFailure.state }
                #if DEBUG
                try await ownedBeforeH2?()
                guard shouldRun, socket === task else { throw RelayFailure.closed }
                #endif
                let response = try handshake.acknowledge(text)
                if relaySecret != nil {
                    transition(to: .awaitingRelayConfirmation(fingerprint: response.fingerprint))
                    let remaining = began.duration(to: .now)
                    armRelayDeadline(task, after: .seconds(120) - remaining)
                }
                try await task.send(.string(response.auth))
                phase = "ready"
            case "ready":
                guard let handshake = relayHandshake else { throw RelayFailure.state }
                relayChannel = try handshake.ready(text)
                relayHandshake = nil
                relaySecret = nil
                relayEnrolled = true
                try await readyHandler?()
                guard shouldRun, socket === task, relayChannel != nil, !Task.isCancelled else { throw RelayFailure.closed }
                ready = true
                let waiting = readyWaiters; readyWaiters.removeAll()
                for waiter in waiting.values { waiter.resume() }
                relayDeadline?.cancel()
                eventHandler(.relayReady)
                if applicationHello { try await sendHello(on: task) }
                phase = "data"
            default: throw RelayFailure.state
            }
        }
    }

    private func armRelayDeadline(_ task: URLSessionWebSocketTask, after delay: Duration) {
        relayDeadline?.cancel()
        let boundedDelay: Duration
        if !relayEnrolled, let expiry = relayPairingExpiresAt {
            boundedDelay = min(delay, .seconds(max(0, Double(expiry) - Date().timeIntervalSince1970)))
        } else { boundedDelay = delay }
        relayDeadline = Task {
            do { try await Task.sleep(for: max(.zero, boundedDelay)) } catch { return }
            guard self.socket === task else { return }
            task.cancel(with: .init(rawValue: 4400) ?? .policyViolation, reason: Data("closed".utf8))
        }
    }

    private func sendRelayBye(on task: URLSessionWebSocketTask) async throws {
        let prior = sendTail
        await prior?.value
        guard socket === task, let channel = relayChannel else { throw RelayFailure.closed }
        try await task.send(.data(channel.seal(Data(), bye: true)))
    }

    private func transition(to newState: RemiConnectionState) {
        state = newState
        stateHandler(newState)
    }

    public nonisolated static func reconnectDelay(forAttempt attempt: Int) -> Double {
        min(pow(2, Double(max(0, attempt - 1))), 30)
    }

    public nonisolated static func shouldRetryAuthentication(_ code: String?) -> Bool {
        code == "PAIRING_PENDING"
            || code == "PENDING_QUEUE_FULL"
            || code?.hasPrefix("AUTH_STORE_ERROR") == true
    }

    public nonisolated static func authenticationDescription(_ code: String?) -> String {
        switch code {
        case "PENDING_QUEUE_FULL":
            "The daemon's pending approval queue is full."
        case "PAIRING_REJECTED": "The pairing request was rejected at the machine."
        case "PAIRING_CANCELLED": "Pairing was cancelled at the machine."
        case "PAIRING_EXPIRED": "The pairing code expired. Run remi pair again."
        case "PAIRING_USED": "Another device already claimed this pairing code."
        case "PAIRING_UNKNOWN": "The machine does not recognize this pairing code."
        case "PAIRING_MALFORMED": "The pairing request was malformed. Scan a new code."
        case let code? where code.hasPrefix("AUTH_STORE_ERROR"):
            "The daemon could not save the approval request (\(code))."
        case "FINGERPRINT_MISMATCH":
            "The claimed fingerprint did not match the signing key."
        case "INVALID_SIGNATURE":
            "Signature verification failed."
        case "NO_PENDING_CHALLENGE":
            "The authentication challenge expired."
        case let code?:
            "Authentication failed (\(code))."
        case nil:
            "Authentication failed."
        }
    }
}
