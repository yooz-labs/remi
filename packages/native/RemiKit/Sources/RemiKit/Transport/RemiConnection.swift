import CryptoKit
import Foundation

public enum DirectRetryPolicy: Sendable, Equatable {
    case runtime
    /// The initial-pairing owner advances candidates only on reachability failure.
    case coordinatedPairing
    /// A quarantined saved-profile probe gets exactly one socket attempt.
    case recoveryProbe
}

public struct RemiConnectionConfiguration: Sendable, Equatable {
    public let url: URL
    public let clientVersion: String
    public let clientId: String
    public let deviceId: String?
    public let expectedServerFingerprint: String?
    public let expectedServerPublicKey: String?
    public let pairingNonce: String?
    public let pairingLabel: String?
    /// Child connections must authenticate as the Mac that advertised their port.
    public let expectedMachineID: String?
    public let relayPin: RelayMachinePin?
    public let directConnectTimeout: Duration
    public let directAuthenticationTimeout: Duration
    public let directHelloTimeout: Duration
    public let directRetryPolicy: DirectRetryPolicy

    public init(
        url: URL,
        clientVersion: String,
        clientId: String,
        deviceId: String? = nil,
        expectedServerFingerprint: String? = nil,
        expectedServerPublicKey: String? = nil,
        pairingNonce: String? = nil,
        pairingLabel: String? = nil,
        expectedMachineID: String? = nil,
        relayPin: RelayMachinePin? = nil,
        directConnectTimeout: Duration = .seconds(5),
        directAuthenticationTimeout: Duration = .seconds(30),
        directHelloTimeout: Duration = .seconds(5),
        directRetryPolicy: DirectRetryPolicy = .runtime
    ) {
        self.url = url
        self.clientVersion = clientVersion
        self.clientId = clientId
        self.deviceId = deviceId
        self.expectedServerFingerprint = expectedServerFingerprint
        self.expectedServerPublicKey = expectedServerPublicKey
        self.pairingNonce = pairingNonce
        self.pairingLabel = pairingLabel
        self.expectedMachineID = expectedMachineID
        self.relayPin = relayPin
        self.directConnectTimeout = min(.seconds(30), max(.milliseconds(100), directConnectTimeout))
        self.directAuthenticationTimeout = min(.seconds(60), max(.milliseconds(100), directAuthenticationTimeout))
        self.directHelloTimeout = min(.seconds(30), max(.milliseconds(100), directHelloTimeout))
        self.directRetryPolicy = directRetryPolicy
    }

    func admittedConfiguration() -> Self {
        Self(url: url, clientVersion: clientVersion, clientId: clientId, deviceId: deviceId,
            expectedServerFingerprint: expectedServerFingerprint, expectedServerPublicKey: expectedServerPublicKey,
            expectedMachineID: expectedMachineID, relayPin: relayPin,
            directConnectTimeout: directConnectTimeout, directAuthenticationTimeout: directAuthenticationTimeout,
            directHelloTimeout: directHelloTimeout, directRetryPolicy: .runtime)
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
    /// The socket could not be reached after bounded attempts. Authentication and
    /// identity failures use `rejected` and must never be treated as reachability.
    case reachabilityFailed(attempt: Int)
    case rejected(reason: String)
}

public enum RemiInboundEvent: Sendable, Equatable {
    case hello(HelloAckMessage, authorityPublicKey: Data? = nil)
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
    case remiStatus(RemiStatusMessage)
    case error(ErrorMessage)
    case relayReady
    case answerResult(AnswerResultMessage)
    case pushRegistration(RelayPushResponse)
    case relayStreamEnded(clean: Bool)
    /// A strictly decoded `session_terminal_*` answer (ADR 0047). Nothing sends the family until a
    /// hub advertises `terminal_view`, so none arrives today.
    case terminalView(TerminalViewMessage)
    /// A strictly decoded `file_fetch_*` answer (ADR 0045), under the same condition as `terminalView`.
    case fileFetch(FileFetchMessage)
    case unsupported(type: String)
}

public enum RemiConnectionError: Error, Sendable, Equatable {
    case nonTextFrame
    case malformedMessage
    case authentication(String)
}

/// Pinned relay broadcasts can arrive between READY and application Hello.
/// Keep them bounded and invisible until Hello verifies the machine descriptor.
struct RelayHelloBuffer {
    private var frames: [Data] = []
    private var bytes = 0

    mutating func append(_ data: Data) throws {
        guard frames.count < 32, data.count <= 1_048_576 - bytes else { throw RelayFailure.oversize }
        frames.append(data)
        bytes += data.count
    }

    mutating func drain() -> [Data] {
        defer { frames.removeAll(); bytes = 0 }
        return frames
    }
}

/// One authenticated daemon connection with bounded exponential reconnect.
/// Unknown client keys pause in `awaitingLocalApproval` until a manual retry is requested.
public actor RemiConnection {
    public typealias StateHandler = @Sendable (RemiConnectionState) -> Void
    public typealias EventHandler = @Sendable (RemiInboundEvent) -> Void
    public typealias ReadyHandler = @Sendable () async throws -> Void

    private var configuration: RemiConnectionConfiguration
    private nonisolated let expectedMachineID: String?
    private let authenticationRetryHandler: @Sendable (String) -> Void
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
    /// The key that authenticated this direct connection. Relay authority comes from the pin.
    private var authenticatedServerPublicKey: Data?
    private var applicationAdmitted = false
    private var relayHelloBuffer = RelayHelloBuffer()
    private var initialDirectHelloPending = false
    private var directOpeningCompleted = false
    private var shouldRun = false
    private var relayHandshake: RelayHandshake?
    private var relayChannel: RelayChannel?
    private var relaySecret: Data?
    private let relayPairingExpiresAt: UInt64?
    private var relayEnrolled: Bool
    private var relayDeadline: Task<Void, Never>?
    private var directDeadline: Task<Void, Never>?
    /// One absolute authentication budget per socket, never extended by a late challenge (#1574).
    private var directAuthenticationDeadline: ContinuousClock.Instant?
    private enum DirectDeadlineFailure: Equatable { case unreachable, authentication }
    private var directDeadlineFailure: DirectDeadlineFailure?
    private var sendTail: Task<Void, Never>?
    private var pendingSends = 0
    private var relayClosing = false

    public init(
        configuration: RemiConnectionConfiguration,
        identity: ClientIdentity,
        relayPairingSecret: Data? = nil,
        relayPairingExpiresAt: UInt64? = nil,
        readyHandler: ReadyHandler? = nil,
        authenticationRetryHandler: @escaping @Sendable (String) -> Void = { _ in },
        stateHandler: @escaping StateHandler,
        eventHandler: @escaping EventHandler
    ) {
        self.configuration = configuration
        expectedMachineID = configuration.expectedMachineID
        self.authenticationRetryHandler = authenticationRetryHandler
        self.identity = identity
        self.relaySecret = relayPairingSecret
        self.relayPairingExpiresAt = relayPairingExpiresAt
        relayEnrolled = relayPairingSecret == nil
        self.stateHandler = stateHandler
        self.eventHandler = eventHandler
        self.readyHandler = readyHandler
    }

    /// Keeps the verified socket and all pins/deadlines, clearing transient claims
    /// before runtime ownership. A probe never becomes a background one-shot RPC.
    func completeCoordinatedAdmission() throws {
        let policy = configuration.directRetryPolicy
        let direct = configuration.relayPin == nil && authenticatedServerPublicKey != nil
        let enrolledRelay = policy == .recoveryProbe && configuration.relayPin != nil && relayEnrolled && ready
        guard policy == .coordinatedPairing || policy == .recoveryProbe,
              direct || enrolledRelay, applicationAdmitted, socket != nil, shouldRun,
              case .connected = state else { throw RelayFailure.closed }
        configuration = configuration.admittedConfiguration()
    }

    func configureOneShot() throws {
        guard !shouldRun else { throw RelayFailure.state }
        singleAttempt = true; applicationHello = false
    }
    #if DEBUG
    nonisolated var ownedExpectedMachineID: String? { expectedMachineID }
    var ownedConfiguration: RemiConnectionConfiguration { configuration }
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
        let admitted: Bool
        if configuration.relayPin != nil { admitted = ready }
        else if case .connected = state { admitted = true }
        else { admitted = false }
        guard admitted, rpcWaiters.count < 8, rpcWaiters[id] == nil, deadline > .now else { throw RelayFailure.closed }
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
        restart()
    }

    /// Restarts a direct connection the user explicitly chose to retry after it stopped or was rejected.
    public func retry() {
        guard configuration.relayPin == nil, Self.allowsManualRetry(state) else { return }
        restart()
    }

    static func allowsManualRetry(_ state: RemiConnectionState) -> Bool {
        switch state {
        case .stopped, .awaitingLocalApproval, .rejected:
            true
        case .connecting, .authenticating, .awaitingRelayConfirmation, .connected, .retrying, .reachabilityFailed:
            false
        }
    }

    private func restart() {
        shouldRun = true
        runTask?.cancel()
        runTask = Task { await run() }
    }

    /// Sends a frame already encoded and validated by its strict codec (`encodedFrame()` of the
    /// terminal-view and file-fetch families), through the same path as `send`.
    /// Refused with `PaneTransportBlocked` unless this connection's route may carry the family
    /// (`PaneTransportPolicy.current`), so no caller can bypass the policy.
    public func sendEncodedFrame(_ frame: String) async throws {
        try await sendEncodedFrame(frame, policy: .current)
    }

    func sendEncodedFrame(_ frame: String, policy: PaneTransportPolicy) async throws {
        if let reason = policy.reason(viaRelay: configuration.relayPin != nil) {
            throw PaneTransportBlocked(reason: reason)
        }
        try await deliver(Data(frame.utf8), validateBeforeSend: nil)
    }

    public func send<T: Encodable & Sendable>(_ message: T,
        validateBeforeSend: (@Sendable () throws -> Void)? = nil) async throws {
        try await deliver(try encoder.encode(message), validateBeforeSend: validateBeforeSend)
    }

    private func deliver(_ data: Data, validateBeforeSend: (@Sendable () throws -> Void)?) async throws {
        guard let socket else { throw URLError(.notConnectedToInternet) }
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
            guard applicationAdmitted else { throw RelayFailure.closed }
            try validateBeforeSend?()
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
                if configuration.directRetryPolicy == .recoveryProbe {
                    shouldRun = false
                    transition(to: .rejected(reason: "The recovery connection ended before admission."))
                    return
                }
            } catch {
                if !shouldRun || Task.isCancelled { return }
                if error is CancellationError && directDeadlineFailure == nil { return }
                let directFailure = directDeadlineFailure
                // closeSocket() below resets this; a socket lost after admission is not a login failure.
                let wasAdmitted = applicationAdmitted
                let authenticationStarted = directOpeningCompleted || pendingAuthentication != nil || authenticatedServerPublicKey != nil
                if configuration.relayPin != nil {
                    if let channel = relayChannel { eventHandler(.relayStreamEnded(clean: channel.peerEnded && !channel.failed)) }
                    socket?.cancel(with: .init(rawValue: 4400) ?? .policyViolation, reason: Data("closed".utf8))
                }
                closeSocket()
                if configuration.relayPin == nil, let reason = Self.directPolicyRejectionDescription(error) {
                    // A local OS-policy refusal is terminal, not evidence that
                    // another transport may bypass the selected layer (#1583).
                    shouldRun = false
                    transition(to: .rejected(reason: reason))
                    return
                }
                if directFailure == .authentication || (configuration.relayPin == nil && configuration.directRetryPolicy != .runtime && authenticationStarted) {
                    shouldRun = false
                    transition(to: .rejected(reason: "The machine did not finish authentication. Check its terminal and retry this layer."))
                    return
                }
                if singleAttempt { shouldRun = false; transition(to: .rejected(reason: "The relay attempt ended.")); return }
                if configuration.directRetryPolicy == .recoveryProbe {
                    shouldRun = false
                    if configuration.relayPin == nil, directFailure == .unreachable || Self.isDirectReachabilityFailure(error) {
                        transition(to: .reachabilityFailed(attempt: attempt))
                    } else {
                        transition(to: .rejected(reason: "The recovery connection failed authentication or protocol validation."))
                    }
                    return
                }
                if configuration.relayPin != nil && (!relayEnrolled || attempt >= 5 || error is RelayFailure) {
                    shouldRun = false
                    transition(to: .rejected(reason: "The relay connection closed. Pair again if this machine has not been saved."))
                    return
                }
                if configuration.relayPin == nil && !Self.shouldRetryDirectFailure(
                    error: error, deadlineUnreachable: directFailure == .unreachable, wasAdmitted: wasAdmitted
                ) {
                    shouldRun = false
                    transition(to: .rejected(
                        reason: "The direct connection failed authentication or protocol validation."
                    ))
                    return
                }
                if configuration.relayPin == nil {
                    transition(to: .reachabilityFailed(attempt: attempt))
                    if configuration.directRetryPolicy != .runtime { shouldRun = false; return }
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
        directDeadlineFailure = nil
        let task = session.webSocketTask(with: configuration.url)
        socket = task
        armDirectDeadline(task, after: configuration.directConnectTimeout, opening: true)
        task.resume()
        initialDirectHelloPending = true
        try await sendHello(on: task)
        directOpeningCompleted = true
        let authenticationDeadline = ContinuousClock.now.advanced(by: configuration.directAuthenticationTimeout)
        directAuthenticationDeadline = authenticationDeadline
        armDirectDeadline(task, until: authenticationDeadline, opening: false)

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
            // An explicit pairing retry closes this socket without rejecting
            // the machine. Return to the bounded retry loop; do not classify
            // our own cancelled receive as an authentication failure.
            if socket !== task { return }
        }
    }

    private func handle(_ data: Data, on task: URLSessionWebSocketTask) async throws {
        let envelope = try decoder.decode(Envelope.self, from: data)
        if configuration.relayPin != nil && ["auth_challenge", "auth_result", "raw_pty_output", "terminal_resize"].contains(envelope.type) {
            throw RelayFailure.type
        }
        // The source daemon receipts Hello before sending its asynchronous
        // hello_ack. Receipts convey no authority or application outcome.
        if envelope.type == "ack" { return }
        // #1561: child domain traffic is visible in the Store. No application
        // frame may reach it before hello verifies the authenticated machine.
        if !["auth_challenge", "auth_result", "hello_ack", "ping", "error"].contains(envelope.type),
           !applicationAdmitted {
            if configuration.relayPin != nil, relayChannel != nil {
                try relayHelloBuffer.append(data)
                return
            }
            throw RemiConnectionError.authentication("Application frame before verified hello")
        }
        switch envelope.type {
        case "auth_challenge":
            guard !applicationAdmitted, pendingAuthentication == nil,
                  authenticatedServerPublicKey == nil else { throw AuthenticationHandshakeError.malformedChallenge }
            let challenge = try decoder.decode(AuthChallengeMessage.self, from: data)
            if let expected = configuration.expectedServerFingerprint,
               challenge.serverFingerprint != expected {
                shouldRun = false
                closeSocket()
                transition(to: .rejected(reason: configuration.directRetryPolicy == .recoveryProbe
                    ? "The endpoint fingerprint does not match the saved machine identity."
                    : "The daemon fingerprint does not match the scanned pairing code."))
                return
            }
            if let expected = configuration.expectedServerPublicKey,
               challenge.serverPublicKey != expected {
                shouldRun = false
                closeSocket()
                transition(to: .rejected(reason: configuration.directRetryPolicy == .recoveryProbe
                    ? "The endpoint public key does not match the saved machine identity."
                    : "The daemon public key does not match the scanned pairing code."))
                return
            }
            let authenticationDeadline = try currentDirectAuthenticationDeadline()
            transition(to: .authenticating(serverFingerprint: challenge.serverFingerprint))
            let (response, pending) = try AuthenticationHandshake.response(
                to: challenge,
                identity: identity,
                expectedServerPublicKey: configuration.expectedServerPublicKey,
                pairingNonce: configuration.pairingNonce,
                pairingLabel: configuration.pairingLabel
            )
            pendingAuthentication = pending
            _ = try currentDirectAuthenticationDeadline()
            armDirectDeadline(task, until: authenticationDeadline, opening: false)
            try await task.send(.data(encoder.encode(response)))
        case "auth_result":
            guard !applicationAdmitted, pendingAuthentication != nil else {
                throw AuthenticationHandshakeError.missingPendingChallenge
            }
            _ = try currentDirectAuthenticationDeadline()
            let result = try decoder.decode(AuthResultMessage.self, from: data)
            guard result.success else {
                pendingAuthentication = nil
                closeSocket()
                if result.error == "UNKNOWN_KEY", configuration.directRetryPolicy != .coordinatedPairing {
                    shouldRun = false
                    transition(to: .awaitingLocalApproval(fingerprint: identity.fingerprint))
                    return
                }
                if configuration.directRetryPolicy != .recoveryProbe, Self.shouldRetryAuthentication(result.error) {
                    authenticationRetryHandler(result.error ?? "AUTH_STORE_ERROR")
                    closeSocket()
                    return
                }
                shouldRun = false
                transition(to: .rejected(reason: Self.authenticationDescription(result.error)))
                return
            }
            try AuthenticationHandshake.verify(result, pending: pendingAuthentication)
            _ = try currentDirectAuthenticationDeadline()
            authenticatedServerPublicKey = pendingAuthentication?.serverPublicKey
            pendingAuthentication = nil
            directAuthenticationDeadline = nil
            guard acceptMachineIdentity(descriptor: nil) else { return }
            armDirectDeadline(task, after: configuration.directHelloTimeout, opening: false)
            try await sendHello(on: task)
        case "hello_ack":
            guard pendingAuthentication == nil else { throw AuthenticationHandshakeError.missingPendingChallenge }
            if configuration.relayPin == nil,
               configuration.expectedServerPublicKey != nil || configuration.expectedServerFingerprint != nil {
                guard authenticatedServerPublicKey != nil else { throw AuthenticationHandshakeError.missingPendingChallenge }
            }
            initialDirectHelloPending = false
            let message = try decoder.decode(HelloAckMessage.self, from: data)
            guard acceptMachineIdentity(descriptor: message.machine) else { return }
            applicationAdmitted = true
            directDeadline?.cancel()
            directDeadline = nil
            relayDeadline?.cancel()
            relayDeadline = nil
            transition(to: .connected(sessionId: message.sessionId))
            let authority = configuration.relayPin.flatMap { try? RelayCrypto.unb64($0.machinePublicKey) }
                ?? authenticatedServerPublicKey
            eventHandler(.hello(message, authorityPublicKey: authority))
            for buffered in relayHelloBuffer.drain() {
                guard applicationAdmitted, socket === task else { throw RelayFailure.closed }
                try await handle(buffered, on: task)
            }
        case "ping":
            let ping = try decoder.decode(PingMessage.self, from: data)
            let pong = PongMessage(
                id: UUID().uuidString.lowercased(),
                timestamp: Date().ISO8601Format(),
                pingId: ping.id
            )
            if configuration.relayPin != nil { try await send(pong) }
            else { try await task.send(.data(encoder.encode(pong))) }
        case "session_list_response":
            let message = try decoder.decode(SessionListResponse.self, from: data)
            guard acceptMachineIdentity(descriptor: message.machine, sessions: message.sessions) else { return }
            eventHandler(.sessions(message))
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
        case "remi_status":
            eventHandler(.remiStatus(try decoder.decode(RemiStatusMessage.self, from: data)))
        case "error":
            let message = try decoder.decode(ErrorMessage.self, from: data)
            // Direct Hello also supports auth-disabled hubs. An authenticated hub
            // refuses that first Hello during its challenge; keep real errors visible (#1242).
            if initialDirectHelloPending, message.code == "AUTH_REQUIRED",
               pendingAuthentication != nil, configuration.relayPin == nil {
                initialDirectHelloPending = false
                return
            }
            guard applicationAdmitted else { throw RemiConnectionError.malformedMessage }
            eventHandler(.error(message))
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
        case "session_terminal_opened", "session_terminal_snapshot", "session_terminal_unchanged",
            "session_terminal_closed", "session_terminal_refused":
            // The strict codec decides; a frame it refuses is as good as unknown.
            if let message = try? TerminalViewMessage.decode(data) {
                eventHandler(.terminalView(message))
            } else {
                eventHandler(.unsupported(type: envelope.type))
            }
        case "file_fetch_accepted", "file_fetch_chunk", "file_fetch_result", "file_fetch_cancel_result",
            "file_fetch_refused":
            if let message = try? FileFetchMessage.decode(data) {
                eventHandler(.fileFetch(message))
            } else {
                eventHandler(.unsupported(type: envelope.type))
            }
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
        authenticatedServerPublicKey = nil
        applicationAdmitted = false
        relayHelloBuffer = RelayHelloBuffer()
        initialDirectHelloPending = false
        directOpeningCompleted = false
        relayDeadline?.cancel()
        relayDeadline = nil
        directDeadline?.cancel()
        directDeadline = nil
        directAuthenticationDeadline = nil
        directDeadlineFailure = nil
        relayHandshake?.abort()
        relayHandshake = nil
        relaySecret = nil
        relayChannel?.close()
        relayChannel = nil
        sendTail = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    /// A bad descriptor is an authentication failure, not an ordinary protocol event. In
    /// particular, it must not trigger direct-to-relay fallback or let a claimed name/id reach UI.
    private func acceptMachineIdentity(
        descriptor: MachineDescriptor?,
        sessions: [DiscoverableSession] = []
    ) -> Bool {
        let authority: Data?
        if let pin = configuration.relayPin {
            authority = try? RelayCrypto.unb64(pin.machinePublicKey)
        } else {
            authority = authenticatedServerPublicKey
        }
        do {
            try MachineIdentityVerifier.verify(
                descriptor: descriptor,
                sessions: sessions,
                authorityPublicKey: authority,
                expectedMachineID: configuration.expectedMachineID
            )
            return true
        } catch {
            shouldRun = false
            closeSocket()
            transition(to: .rejected(reason: "The machine identity did not match its authenticated key."))
            return false
        }
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
                // Background RPCs deliberately skip the application hello. Their
                // authority is the completed, pinned relay handshake (#1242).
                applicationAdmitted = !applicationHello
                let waiting = readyWaiters; readyWaiters.removeAll()
                for waiter in waiting.values { waiter.resume() }
                relayDeadline?.cancel()
                eventHandler(.relayReady)
                if applicationHello {
                    if configuration.directRetryPolicy == .recoveryProbe { armRelayDeadline(task, after: configuration.directHelloTimeout) }
                    try await sendHello(on: task)
                }
                phase = "data"
            default: throw RelayFailure.state
            }
        }
    }

    private func currentDirectAuthenticationDeadline() throws -> ContinuousClock.Instant {
        guard let deadline = directAuthenticationDeadline else {
            throw RemiConnectionError.authentication("Authentication phase has no deadline")
        }
        // Fail closed even if an inbound frame runs before an already-expired
        // timer task gets actor time; that frame cannot extend or complete auth.
        guard ContinuousClock.now < deadline else {
            directDeadlineFailure = .authentication
            throw RemiConnectionError.authentication("Authentication deadline elapsed")
        }
        return deadline
    }

    private func armDirectDeadline(_ task: URLSessionWebSocketTask, after delay: Duration, opening: Bool) {
        armDirectDeadline(task, until: ContinuousClock.now.advanced(by: delay), opening: opening)
    }

    private func armDirectDeadline(_ task: URLSessionWebSocketTask, until deadline: ContinuousClock.Instant, opening: Bool) {
        guard configuration.relayPin == nil else { return }
        directDeadline?.cancel()
        directDeadline = Task {
            do { try await Task.sleep(until: deadline, clock: .continuous) } catch { return }
            guard socket === task, shouldRun, !applicationAdmitted else { return }
            directDeadlineFailure = opening ? .unreachable : .authentication
            task.cancel(with: .goingAway, reason: nil)
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

    /// Whether a failed direct socket is retried instead of rejected.
    ///
    /// A socket that dies after the machine was admitted (a graceful hub close, a restart) is a
    /// transport loss, whatever transport error the system reports for it, so the connection
    /// retries with backoff (#1599). Protocol violations still fail closed after admission, and a
    /// failure before admission is judged by its error: only reachability failures retry, so a
    /// changed machine identity or a failed handshake still fails closed. Every retry runs the
    /// full pinned handshake again before the machine is admitted.
    static func shouldRetryDirectFailure(error: any Error, deadlineUnreachable: Bool, wasAdmitted: Bool) -> Bool {
        deadlineUnreachable || isDirectReachabilityFailure(error)
            || (wasAdmitted && !isLocalProtocolViolation(error))
    }

    /// Errors this client raises itself when the peer breaks the protocol, as opposed to the
    /// system reporting that the transport went away.
    static func isLocalProtocolViolation(_ error: any Error) -> Bool {
        error is RemiConnectionError || error is AuthenticationHandshakeError
            || error is RelayFailure || error is DecodingError
    }

    /// Only network reachability failures may activate a relay fallback. TLS trust,
    /// authentication, decoding, and protocol failures deliberately fail closed.
    static func directPolicyRejectionDescription(_ error: any Error) -> String? {
        let error = error as NSError
        guard error.domain == NSURLErrorDomain,
              error.code == URLError.appTransportSecurityRequiresSecureConnection.rawValue else { return nil }
        return "The OS blocked this direct address (ATS -1022). Use a private LAN or Tailscale address, or an enrolled relay."
    }

    static func isDirectReachabilityFailure(_ error: any Error) -> Bool {
        if let error = error as? URLError {
            return [
                .timedOut,
                .cannotFindHost,
                .cannotConnectToHost,
                .dnsLookupFailed,
                .networkConnectionLost,
                .notConnectedToInternet,
            ].contains(error.code)
        }
        let error = error as NSError
        return error.domain == NSPOSIXErrorDomain && [
            ECONNREFUSED,
            ECONNRESET,
            ENETDOWN,
            ENETUNREACH,
            EHOSTDOWN,
            EHOSTUNREACH,
            ETIMEDOUT,
        ].contains(Int32(error.code))
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
