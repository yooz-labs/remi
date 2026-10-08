import Foundation

public struct RemiConnectionConfiguration: Sendable, Equatable {
    public let url: URL
    public let clientVersion: String
    public let clientId: String
    public let deviceId: String?
    public let expectedServerFingerprint: String?

    public init(
        url: URL,
        clientVersion: String,
        clientId: String,
        deviceId: String? = nil,
        expectedServerFingerprint: String? = nil
    ) {
        self.url = url
        self.clientVersion = clientVersion
        self.clientId = clientId
        self.deviceId = deviceId
        self.expectedServerFingerprint = expectedServerFingerprint
    }
}

public enum RemiConnectionState: Sendable, Equatable {
    case stopped
    case connecting(attempt: Int)
    case authenticating(serverFingerprint: String)
    case awaitingLocalApproval(fingerprint: String)
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

    private let configuration: RemiConnectionConfiguration
    private let identity: ClientIdentity
    private let stateHandler: StateHandler
    private let eventHandler: EventHandler
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private var state: RemiConnectionState = .stopped
    private var socket: URLSessionWebSocketTask?
    private var runTask: Task<Void, Never>?
    private var pendingAuthentication: PendingAuthentication?
    private var shouldRun = false

    public init(
        configuration: RemiConnectionConfiguration,
        identity: ClientIdentity,
        stateHandler: @escaping StateHandler,
        eventHandler: @escaping EventHandler
    ) {
        self.configuration = configuration
        self.identity = identity
        self.stateHandler = stateHandler
        self.eventHandler = eventHandler
    }

    public func start() {
        guard !shouldRun else { return }
        shouldRun = true
        runTask = Task { await run() }
    }

    public func stop() {
        shouldRun = false
        runTask?.cancel()
        runTask = nil
        closeSocket()
        transition(to: .stopped)
    }

    /// Call after the user has run the displayed `remi authorize …` command locally.
    public func retryAfterApproval() {
        guard case .awaitingLocalApproval = state else { return }
        shouldRun = true
        runTask?.cancel()
        runTask = Task { await run() }
    }

    public func send<T: Encodable & Sendable>(_ message: T) async throws {
        guard let socket else { throw URLError(.notConnectedToInternet) }
        try await socket.send(.data(encoder.encode(message)))
    }

    private func run() async {
        var attempt = 0
        while shouldRun && !Task.isCancelled {
            attempt += 1
            transition(to: .connecting(attempt: attempt))
            do {
                try await connectAndReceive()
                if case .awaitingLocalApproval = state { return }
                if case .rejected = state { return }
            } catch is CancellationError {
                return
            } catch {
                closeSocket()
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
        pendingAuthentication = nil
        let task = URLSession.shared.webSocketTask(with: configuration.url)
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
            transition(to: .authenticating(serverFingerprint: challenge.serverFingerprint))
            let (response, pending) = try AuthenticationHandshake.response(
                to: challenge,
                identity: identity
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
        try await task.send(.data(encoder.encode(message)))
    }

    private func closeSocket() {
        pendingAuthentication = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    private func transition(to newState: RemiConnectionState) {
        state = newState
        stateHandler(newState)
    }

    public nonisolated static func reconnectDelay(forAttempt attempt: Int) -> Double {
        min(pow(2, Double(max(0, attempt - 1))), 30)
    }

    public nonisolated static func authenticationDescription(_ code: String?) -> String {
        switch code {
        case "PENDING_QUEUE_FULL":
            "The daemon's pending approval queue is full."
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
