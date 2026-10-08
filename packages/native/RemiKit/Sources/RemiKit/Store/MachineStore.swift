import Foundation
import Observation

/// Temporary machine identity until the protocol ships a durable machine object (#1234).
/// Keeping it behind this value type prevents `host:port` from leaking through app UI APIs.
public struct MachineEndpoint: Codable, Sendable, Hashable, Identifiable {
    public var id: String { "\(host):\(port)" }

    public let host: String
    public let port: Int
    public let expectedFingerprint: String?
    /// Ephemeral key pin from a pairing QR. Deliberately excluded from persistence.
    public let expectedPublicKey: String?
    /// Ephemeral QR rendezvous token. Deliberately excluded from Codable persistence.
    public let pairingNonce: String?
    /// Ephemeral display label sent with a pairing claim. Deliberately excluded from persistence.
    public let pairingLabel: String?

    public init(
        host: String,
        port: Int,
        expectedFingerprint: String? = nil,
        expectedPublicKey: String? = nil,
        pairingNonce: String? = nil,
        pairingLabel: String? = nil
    ) {
        self.host = host
        self.port = port
        self.expectedFingerprint = expectedFingerprint
        self.expectedPublicKey = expectedPublicKey
        self.pairingNonce = pairingNonce
        self.pairingLabel = pairingLabel
    }

    public var webSocketURL: URL? {
        if host.contains(":") {
            return URL(string: "ws://[\(host)]:\(port)/ws")
        }
        var components = URLComponents()
        components.scheme = "ws"
        components.host = host
        components.port = port
        components.path = "/ws"
        return components.url
    }

    enum CodingKeys: String, CodingKey {
        case host, port, expectedFingerprint
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        host = try values.decode(String.self, forKey: .host)
        port = try values.decode(Int.self, forKey: .port)
        expectedFingerprint = try values.decodeIfPresent(String.self, forKey: .expectedFingerprint)
        expectedPublicKey = nil
        pairingNonce = nil
        pairingLabel = nil
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(host, forKey: .host)
        try values.encode(port, forKey: .port)
        try values.encodeIfPresent(expectedFingerprint, forKey: .expectedFingerprint)
    }
}

public enum MachineConnectionStatus: Sendable, Equatable {
    case disconnected
    case connecting
    case connected
    case waitingForApproval(fingerprint: String)
    case unavailable(reason: String?)
}

public struct MachineState: Sendable, Equatable, Identifiable {
    public var id: String { endpoint.id }

    public let endpoint: MachineEndpoint
    public var displayName: String
    public var status: MachineConnectionStatus
    public var sessions: [DiscoverableSession]
    public var hasLoadedSessions: Bool
    public var questions: [QuestionMessage]
    public var capabilities: [String]
    public var harnesses: [String]
    public var activeSessions: [DiscoverableSession] { sessions.filter { $0.source == "daemon" } }

    public init(endpoint: MachineEndpoint, displayName: String) {
        self.endpoint = endpoint
        self.displayName = displayName
        status = .disconnected
        sessions = []
        hasLoadedSessions = false
        questions = []
        capabilities = []
        harnesses = ["claude"]
    }
}

public struct ResumedSessionDestination: Sendable, Equatable, Identifiable {
    public let id: UUID
    public let machineID: String
    public let requestedSessionID: String
    public let sessionID: String
}

public struct ResumeSessionKey: Sendable, Hashable {
    public let machineID: String
    public let sessionID: String

    public init(machineID: String, sessionID: String) {
        self.machineID = machineID
        self.sessionID = sessionID
    }
}

public struct ResolvedQuestionRecord: Sendable, Equatable, Identifiable {
    public let id: String
    public let machineID: String
    public let message: QuestionMessage
    public let resolvedBy: QuestionResolvedBy?
    public let reason: String
}

/// The single source of truth for every configured machine and its joined session daemons.
@MainActor
@Observable
public final class MachineStore {
    public private(set) var machines: [MachineState]
    public private(set) var transcriptsBySession: [String: [TranscriptContentMessage]] = [:]
    public private(set) var sessionViewsBySession: [String: [SessionViewMeta]] = [:]
    public private(set) var recentRepositoriesByMachine: [String: [RecentRepository]] = [:]
    public private(set) var latestError: ErrorMessage?
    public private(set) var latestOperationError: String?
    public private(set) var latestOperationNotice: String?
    public private(set) var resumedSessionDestination: ResumedSessionDestination?
    public private(set) var resumingSessions: Set<ResumeSessionKey> = []
    public private(set) var resumeErrorsBySession: [ResumeSessionKey: String] = [:]
    public private(set) var recentlyResolvedQuestions: [ResolvedQuestionRecord] = []

    @ObservationIgnored private let identity: ClientIdentity
    @ObservationIgnored private let clientVersion: String
    @ObservationIgnored private let clientId: String
    @ObservationIgnored private var connections: [MachineEndpoint: RemiConnection] = [:]
    @ObservationIgnored private var parentByConnection: [MachineEndpoint: MachineEndpoint] = [:]
    @ObservationIgnored private var routeBySession: [String: MachineEndpoint] = [:]
    @ObservationIgnored private var sessionByKillRequest: [String: String] = [:]
    @ObservationIgnored private var resumeAttemptsByRequest: [String: ResumeAttempt] = [:]
    @ObservationIgnored private var resumeRequestByChild: [MachineEndpoint: String] = [:]
    @ObservationIgnored private var resumeTimeoutTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var resolvedQuestionRemovalTasks: [String: Task<Void, Never>] = [:]

    public var publicIdentity: PublicClientIdentity { identity.publicIdentity }

    public init(
        endpoints: [MachineEndpoint],
        identity: ClientIdentity,
        clientVersion: String,
        clientId: String
    ) {
        self.identity = identity
        self.clientVersion = clientVersion
        self.clientId = clientId
        machines = endpoints.map {
            MachineState(endpoint: $0, displayName: $0.id)
        }
    }

    public func start() {
        for machine in machines {
            connect(machine.endpoint, parent: machine.endpoint)
        }
    }

    public func stop() {
        let activeConnections = Array(connections.values)
        connections.removeAll()
        parentByConnection.removeAll()
        for task in resumeTimeoutTasks.values { task.cancel() }
        resumeTimeoutTasks.removeAll()
        resumeAttemptsByRequest.removeAll()
        resumeRequestByChild.removeAll()
        resumingSessions.removeAll()
        resumeErrorsBySession.removeAll()
        for task in resolvedQuestionRemovalTasks.values { task.cancel() }
        resolvedQuestionRemovalTasks.removeAll()
        recentlyResolvedQuestions.removeAll()
        Task {
            for connection in activeConnections {
                await connection.stop()
            }
        }
    }

    public func addMachine(_ endpoint: MachineEndpoint, displayName: String? = nil) {
        guard !machines.contains(where: { $0.endpoint == endpoint }) else { return }
        machines.append(MachineState(endpoint: endpoint, displayName: displayName ?? endpoint.id))
        connect(endpoint, parent: endpoint)
    }

    public func removeMachine(_ endpoint: MachineEndpoint) {
        let resumeRequestIDs = resumeAttemptsByRequest.compactMap { requestID, attempt in
            attempt.parent == endpoint ? requestID : nil
        }
        for requestID in resumeRequestIDs {
            finishResume(requestID: requestID, error: nil)
        }
        resumeErrorsBySession = resumeErrorsBySession.filter { $0.key.machineID != endpoint.id }
        if resumedSessionDestination?.machineID == endpoint.id {
            resumedSessionDestination = nil
        }
        let resolvedIDs = recentlyResolvedQuestions.filter { $0.machineID == endpoint.id }.map(\.id)
        recentlyResolvedQuestions.removeAll { $0.machineID == endpoint.id }
        for id in resolvedIDs {
            resolvedQuestionRemovalTasks.removeValue(forKey: id)?.cancel()
        }
        let removedMachine = machines.first { $0.endpoint == endpoint }
        let sessionIDs = Set(removedMachine?.sessions.map(\.sessionId) ?? [])
        let viewIDs = Set(sessionIDs.flatMap { sessionViewsBySession[$0]?.map(\.agentId) ?? [] })
        machines.removeAll { $0.endpoint == endpoint }
        let endpoints = parentByConnection.compactMap { connection, parent in
            parent == endpoint ? connection : nil
        }
        for child in endpoints {
            if let connection = connections.removeValue(forKey: child) {
                Task { await connection.stop() }
            }
            parentByConnection[child] = nil
        }
        routeBySession = routeBySession.filter { _, route in !endpoints.contains(route) }
        sessionByKillRequest = sessionByKillRequest.filter { _, sessionID in
            !sessionIDs.contains(sessionID)
        }
        for sessionID in sessionIDs {
            transcriptsBySession[sessionID] = nil
            sessionViewsBySession[sessionID] = nil
        }
        for viewID in viewIDs {
            transcriptsBySession[viewID] = nil
        }
        recentRepositoriesByMachine[endpoint.id] = nil
    }

    public func retryApproval(for endpoint: MachineEndpoint) {
        guard let connection = connections[endpoint] else { return }
        Task { await connection.retryAfterApproval() }
    }

    public func clearLatestError() {
        latestError = nil
        latestOperationError = nil
        latestOperationNotice = nil
        resumeErrorsBySession.removeAll()
    }

    public func loadTranscript(sessionId: String) {
        guard let connection = connection(forSession: sessionId) else { return }
        let request = TranscriptLoadRequestMessage(
            id: UUID().uuidString.lowercased(),
            timestamp: Date().ISO8601Format(),
            sessionId: sessionId
        )
        Task { try? await connection.send(request) }
    }

    public func answer(
        sessionId: String,
        questionId: String,
        answer: String,
        claudeSessionId: String? = nil,
        selections: [AnswerSelection]? = nil,
        cancel: Bool? = nil,
        message: String? = nil
    ) {
        guard let connection = connection(forSession: sessionId) else { return }
        let response = AnswerMessage(
            id: UUID().uuidString.lowercased(),
            timestamp: Date().ISO8601Format(),
            sessionId: sessionId,
            questionId: questionId,
            answer: answer,
            claudeSessionId: claudeSessionId,
            selections: selections,
            cancel: cancel,
            message: message
        )
        Task { try? await connection.send(response) }
    }

    public func sendChat(sessionId: String, content: String, claudeSessionId: String? = nil) {
        guard let connection = connection(forSession: sessionId) else { return }
        let message = UserInputMessage(
            id: UUID().uuidString.lowercased(),
            timestamp: Date().ISO8601Format(),
            sessionId: sessionId,
            content: content,
            claudeSessionId: claudeSessionId
        )
        Task { try? await connection.send(message) }
    }

    public func terminateSession(sessionId: String) {
        guard let connection = connection(forSession: sessionId) else {
            latestOperationError = "Cannot exit session: its daemon is unavailable."
            return
        }
        let request = KillSessionRequestMessage(
            id: UUID().uuidString.lowercased(),
            timestamp: Date().ISO8601Format(),
            sessionId: sessionId
        )
        sessionByKillRequest[request.id] = sessionId
        Task {
            do {
                try await connection.send(request)
            } catch {
                await MainActor.run {
                    self.sessionByKillRequest[request.id] = nil
                    self.latestOperationError = "Cannot exit session: its daemon is unavailable."
                }
            }
        }
    }

    public func resumeSession(on endpoint: MachineEndpoint, sessionId: String) {
        guard let connection = connections[endpoint] else {
            latestOperationError = "Cannot resume session: its machine is unavailable."
            return
        }
        let key = ResumeSessionKey(machineID: endpoint.id, sessionID: sessionId)
        guard !resumingSessions.contains(key) else { return }

        latestOperationError = nil
        latestOperationNotice = nil
        resumeErrorsBySession[key] = nil
        let request = ResumeSessionRequestMessage(
            id: UUID().uuidString.lowercased(),
            timestamp: Date().ISO8601Format(),
            sessionId: sessionId
        )
        resumeAttemptsByRequest[request.id] = ResumeAttempt(
            parent: endpoint,
            requestedSessionID: sessionId,
            resolvedSessionID: nil
        )
        resumingSessions.insert(key)
        resumeTimeoutTasks[request.id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.expireResume(requestID: request.id) }
        }

        Task {
            do {
                try await connection.send(request)
            } catch {
                await MainActor.run {
                    self.finishResume(
                        requestID: request.id,
                        error: "Cannot resume session: its machine is unavailable."
                    )
                }
            }
        }
    }

    public func consumeResumedSessionDestination(id: UUID) {
        guard resumedSessionDestination?.id == id else { return }
        resumedSessionDestination = nil
    }

    public func createSession(
        on endpoint: MachineEndpoint,
        directory: String,
        harness: String,
        args: [String] = [],
        workspace: WorkspaceRequest? = nil
    ) {
        guard let connection = connections[endpoint] else { return }
        latestOperationError = nil
        latestOperationNotice = nil
        let request = CreateSessionRequestMessage(
            id: UUID().uuidString.lowercased(),
            timestamp: Date().ISO8601Format(),
            directory: directory,
            harness: harness,
            args: args.isEmpty ? nil : args,
            workspace: workspace
        )
        Task {
            do {
                try await connection.send(request)
            } catch {
                await MainActor.run {
                    self.latestOperationError = "Could not create session: the machine is unavailable."
                }
            }
        }
    }

    private func connect(_ endpoint: MachineEndpoint, parent: MachineEndpoint) {
        guard connections[endpoint] == nil, let url = endpoint.webSocketURL else { return }
        parentByConnection[endpoint] = parent
        let connection = RemiConnection(
            configuration: RemiConnectionConfiguration(
                url: url,
                clientVersion: clientVersion,
                clientId: clientId,
                deviceId: clientId,
                expectedServerFingerprint: endpoint.expectedFingerprint,
                expectedServerPublicKey: endpoint.expectedPublicKey,
                pairingNonce: endpoint.pairingNonce,
                pairingLabel: endpoint.pairingLabel
            ),
            identity: identity,
            stateHandler: { [weak self] state in
                Task { @MainActor [weak self] in
                    self?.receive(state, from: endpoint)
                }
            },
            eventHandler: { [weak self] event in
                Task { @MainActor [weak self] in
                    self?.receive(event, from: endpoint)
                }
            }
        )
        connections[endpoint] = connection
        Task { await connection.start() }
    }

    private func receive(_ state: RemiConnectionState, from endpoint: MachineEndpoint) {
        guard let parent = parentByConnection[endpoint],
              let index = machines.firstIndex(where: { $0.endpoint == parent })
        else { return }

        switch state {
        case .stopped:
            machines[index].status = .disconnected
        case .connecting, .authenticating, .retrying:
            machines[index].status = .connecting
        case .connected:
            machines[index].status = .connected
        case .awaitingLocalApproval(let fingerprint):
            machines[index].status = .waitingForApproval(fingerprint: fingerprint)
        case .rejected(let reason):
            machines[index].status = .unavailable(reason: reason)
        }
    }

    private func receive(_ event: RemiInboundEvent, from endpoint: MachineEndpoint) {
        guard let parent = parentByConnection[endpoint],
              let index = machines.firstIndex(where: { $0.endpoint == parent })
        else { return }

        switch event {
        case .hello(let acknowledgment):
            if endpoint == parent {
                machines[index].capabilities = acknowledgment.capabilities ?? []
                machines[index].harnesses = acknowledgment.harnesses ?? ["claude"]
                if machines[index].capabilities.contains("workspaces") {
                    requestRecentRepositories(from: endpoint)
                }
            }
            if let requestID = resumeRequestByChild.removeValue(forKey: endpoint),
               let attempt = resumeAttemptsByRequest[requestID] {
                let sessionID = attempt.resolvedSessionID ?? acknowledgment.sessionId
                    ?? attempt.requestedSessionID
                routeBySession[sessionID] = endpoint
                completeResume(requestID: requestID, sessionID: sessionID)
            }
            requestSessions(from: endpoint)
        case .sessions(let response):
            for session in response.sessions {
                routeBySession[session.sessionId] = endpoint
            }
            machines[index].sessions = mergeSessions(
                machines[index].sessions,
                with: response.sessions
            )
            if endpoint == parent {
                machines[index].hasLoadedSessions = true
            }
            for port in response.daemonPorts ?? [] where port != parent.port {
                connect(MachineEndpoint(host: parent.host, port: port), parent: parent)
            }
            if let requestID = resumeRequestByChild[endpoint],
               let attempt = resumeAttemptsByRequest[requestID] {
                let sessionID = attempt.resolvedSessionID ?? attempt.requestedSessionID
                if response.sessions.contains(where: { $0.sessionId == sessionID }) {
                    resumeRequestByChild[endpoint] = nil
                    completeResume(requestID: requestID, sessionID: sessionID)
                }
            }
        case .question(let message):
            routeBySession[message.sessionId] = endpoint
            machines[index].questions.removeAll { $0.question.id == message.question.id }
            machines[index].questions.append(message)
            let resolvedID = Self.resolvedQuestionID(
                machineID: parent.id,
                sessionID: message.sessionId,
                questionID: message.question.id
            )
            recentlyResolvedQuestions.removeAll { $0.id == resolvedID }
            resolvedQuestionRemovalTasks.removeValue(forKey: resolvedID)?.cancel()
        case .questionResolved(let message):
            resolveQuestion(message, machineIndex: index, machineID: parent.id)
        case .questionSnapshot(let snapshot):
            machines[index] = Self.reconcilingQuestionSnapshot(
                in: machines[index],
                sessionId: snapshot.sessionId,
                liveQuestionIDs: Set(snapshot.questionIds)
            )
        case .transcript(let message):
            var transcript = transcriptsBySession[message.sessionId, default: []]
            transcript.removeAll { $0.entryUuid == message.entryUuid }
            transcript.append(message)
            transcriptsBySession[message.sessionId] = transcript
        case .sessionViews(let message):
            sessionViewsBySession[message.sessionId] = message.subagents.sorted {
                if $0.active != $1.active { return $0.active && !$1.active }
                return $0.agentType.localizedCaseInsensitiveCompare($1.agentType) == .orderedAscending
            }
            for subagent in message.subagents {
                routeBySession[subagent.agentId] = endpoint
            }
        case .recentRepositories(let response):
            guard endpoint == parent else { return }
            recentRepositoriesByMachine[parent.id] = response.repositories
        case .createSessionResponse(let response):
            if response.success {
                latestOperationNotice = response.notice
                if let port = response.port {
                    connect(MachineEndpoint(host: parent.host, port: port), parent: parent)
                    requestSessions(from: parent)
                }
            } else if !response.success {
                latestOperationError = "Could not create session: \(response.error ?? "Unknown daemon error")"
            }
        case .resumeSessionResponse(let response):
            handleResumeResponse(response, from: endpoint, parent: parent)
        case .killSessionResponse(let response):
            guard let sessionId = sessionByKillRequest.removeValue(forKey: response.requestId) else {
                return
            }
            if response.success {
                machines[index].sessions.removeAll { $0.sessionId == sessionId }
                machines[index].questions.removeAll { $0.sessionId == sessionId }
                transcriptsBySession[sessionId] = nil
                sessionViewsBySession[sessionId] = nil
                routeBySession[sessionId] = nil
                requestSessions(from: parent)
            } else {
                latestOperationError = "Could not exit session: \(response.error ?? "Unknown daemon error")"
            }
        case .error(let error):
            latestError = error
            if error.code == "AUTH_REQUIRED" {
                let requestIDs = resumeAttemptsByRequest.compactMap { requestID, attempt in
                    attempt.parent == endpoint ? requestID : nil
                }
                for requestID in requestIDs {
                    finishResume(requestID: requestID, error: error.message)
                }
            }
        case .sessionUpdate, .transcriptComplete, .unsupported:
            break
        }
    }

    private func handleResumeResponse(
        _ response: ResumeSessionResponseMessage,
        from endpoint: MachineEndpoint,
        parent: MachineEndpoint
    ) {
        guard var attempt = resumeAttemptsByRequest[response.requestId], endpoint == attempt.parent else {
            return
        }
        guard response.success else {
            finishResume(
                requestID: response.requestId,
                error: response.error ?? "The daemon could not resume this session."
            )
            return
        }

        let sessionID = response.sessionId ?? attempt.requestedSessionID
        attempt.resolvedSessionID = sessionID
        resumeAttemptsByRequest[response.requestId] = attempt
        guard let port = response.port else {
            routeBySession[sessionID] = endpoint
            completeResume(requestID: response.requestId, sessionID: sessionID)
            return
        }

        let child = MachineEndpoint(host: parent.host, port: port)
        resumeRequestByChild[child] = response.requestId
        if connections[child] == nil {
            connect(child, parent: parent)
        } else {
            requestSessions(from: child)
        }
        requestSessions(from: parent)
    }

    private func completeResume(requestID: String, sessionID: String) {
        guard let attempt = resumeAttemptsByRequest[requestID] else { return }
        resumedSessionDestination = ResumedSessionDestination(
            id: UUID(),
            machineID: attempt.parent.id,
            requestedSessionID: attempt.requestedSessionID,
            sessionID: sessionID
        )
        finishResume(requestID: requestID, error: nil)
    }

    private func expireResume(requestID: String) {
        finishResume(
            requestID: requestID,
            error: "The resumed session did not become available within 30 seconds."
        )
    }

    private func finishResume(requestID: String, error: String?) {
        guard let attempt = resumeAttemptsByRequest.removeValue(forKey: requestID) else { return }
        resumeTimeoutTasks.removeValue(forKey: requestID)?.cancel()
        resumeRequestByChild = resumeRequestByChild.filter { $0.value != requestID }
        let key = ResumeSessionKey(
            machineID: attempt.parent.id,
            sessionID: attempt.requestedSessionID
        )
        resumingSessions.remove(key)
        if let error {
            latestOperationError = error
            resumeErrorsBySession[key] = error
        }
    }

    static func resolvingQuestion(
        in states: [MachineState],
        sessionId: String,
        questionId: String
    ) -> [MachineState] {
        states.map { state in
            var state = state
            state.questions.removeAll {
                $0.sessionId == sessionId && $0.question.id == questionId
            }
            return state
        }
    }

    private func resolveQuestion(
        _ resolution: QuestionResolvedMessage,
        machineIndex: Int,
        machineID: String
    ) {
        guard let message = machines[machineIndex].questions.first(where: {
            $0.sessionId == resolution.sessionId && $0.question.id == resolution.questionId
        }) else { return }

        machines[machineIndex].questions.removeAll {
            $0.sessionId == resolution.sessionId && $0.question.id == resolution.questionId
        }
        let id = Self.resolvedQuestionID(
            machineID: machineID,
            sessionID: resolution.sessionId,
            questionID: resolution.questionId
        )
        recentlyResolvedQuestions.removeAll { $0.id == id }
        recentlyResolvedQuestions.append(ResolvedQuestionRecord(
            id: id,
            machineID: machineID,
            message: message,
            resolvedBy: resolution.resolvedBy,
            reason: resolution.reason
        ))
        resolvedQuestionRemovalTasks.removeValue(forKey: id)?.cancel()
        resolvedQuestionRemovalTasks[id] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.recentlyResolvedQuestions.removeAll { $0.id == id }
                self?.resolvedQuestionRemovalTasks[id] = nil
            }
        }
    }

    private static func resolvedQuestionID(
        machineID: String,
        sessionID: String,
        questionID: String
    ) -> String {
        "\(machineID)|\(sessionID)|\(questionID)"
    }

    static func reconcilingQuestionSnapshot(
        in state: MachineState,
        sessionId: String,
        liveQuestionIDs: Set<String>
    ) -> MachineState {
        var state = state
        state.questions.removeAll {
            $0.sessionId == sessionId && !liveQuestionIDs.contains($0.question.id)
        }
        return state
    }

    private func requestSessions(from endpoint: MachineEndpoint) {
        guard let connection = connections[endpoint] else { return }
        let request = SessionListRequestMessage(
            id: UUID().uuidString.lowercased(),
            timestamp: Date().ISO8601Format(),
            includeExternal: true
        )
        Task { try? await connection.send(request) }
    }

    private func requestRecentRepositories(from endpoint: MachineEndpoint) {
        guard let connection = connections[endpoint] else { return }
        let request = RecentRepositoriesRequestMessage(
            id: UUID().uuidString.lowercased(),
            timestamp: Date().ISO8601Format(),
            limit: 10
        )
        Task { try? await connection.send(request) }
    }

    private func connection(forSession sessionId: String) -> RemiConnection? {
        routeBySession[sessionId].flatMap { connections[$0] }
    }

    private func mergeSessions(
        _ existing: [DiscoverableSession],
        with incoming: [DiscoverableSession]
    ) -> [DiscoverableSession] {
        var sessions = Dictionary(uniqueKeysWithValues: existing.map { ($0.sessionId, $0) })
        for session in incoming {
            sessions[session.sessionId] = session
        }
        return sessions.values.sorted { $0.projectPath < $1.projectPath }
    }
}

private struct ResumeAttempt {
    let parent: MachineEndpoint
    let requestedSessionID: String
    var resolvedSessionID: String?
}
