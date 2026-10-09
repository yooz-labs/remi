import Foundation
import Observation
import RemiPush

/// Temporary machine identity until the protocol ships a durable machine object (#1234).
/// Keeping it behind this value type prevents `host:port` from leaking through app UI APIs.
public struct MachineEndpoint: Codable, Sendable, Hashable, Identifiable {
    public var id: String {
        if let relayPin { return "relay:\(relayPin.machinePublicKey)@\(relayPin.relayURL)" }
        return "\(host):\(port)"
    }

    public var displayAddress: String { relayPin?.relayURL ?? "\(host):\(port)" }

    public let host: String
    public let port: Int
    public let expectedFingerprint: String?
    /// Ephemeral key pin from a pairing QR. Deliberately excluded from persistence.
    public let expectedPublicKey: String?
    /// Ephemeral QR rendezvous token. Deliberately excluded from Codable persistence.
    public let pairingNonce: String?
    /// Ephemeral display label sent with a pairing claim. Deliberately excluded from persistence.
    public let pairingLabel: String?
    public let relayPin: RelayMachinePin?
    let relayPairingSecret: Data?
    let relayPairingExpiresAt: UInt64?

    public init(
        host: String,
        port: Int,
        expectedFingerprint: String? = nil,
        expectedPublicKey: String? = nil,
        pairingNonce: String? = nil,
        pairingLabel: String? = nil,
        relayPin: RelayMachinePin? = nil
    ) {
        self.host = host
        self.port = port
        self.expectedFingerprint = expectedFingerprint
        self.expectedPublicKey = expectedPublicKey
        self.pairingNonce = pairingNonce
        self.pairingLabel = pairingLabel
        self.relayPin = relayPin
        relayPairingSecret = nil
        relayPairingExpiresAt = nil
    }

    /// Explicit opt-in token. Its secret is memory-only and never encoded into configuration.
    public static func pairingOverRelay(_ token: String) throws -> MachineEndpoint {
        let decoded = try RelayPairingToken(token, now: UInt64(Date().timeIntervalSince1970))
        return MachineEndpoint(relayToken: decoded)
    }

    init(relayToken: RelayPairingToken) {
        host = URLComponents(string: relayToken.pin.relayURL)?.host ?? "relay"
        port = URLComponents(string: relayToken.pin.relayURL)?.port ?? 443
        expectedFingerprint = nil
        expectedPublicKey = nil
        pairingNonce = nil
        pairingLabel = nil
        relayPin = relayToken.pin
        relayPairingSecret = relayToken.secret
        relayPairingExpiresAt = relayToken.expiresAt
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

    var publicConfiguration: MachineEndpoint {
        guard let relayPin else { return self }
        return MachineEndpoint(host: host, port: port, relayPin: relayPin)
    }

    enum CodingKeys: String, CodingKey {
        case host, port, expectedFingerprint, relayPin
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        host = try values.decode(String.self, forKey: .host)
        port = try values.decode(Int.self, forKey: .port)
        expectedFingerprint = try values.decodeIfPresent(String.self, forKey: .expectedFingerprint)
        expectedPublicKey = nil
        pairingNonce = nil
        pairingLabel = nil
        relayPin = try values.decodeIfPresent(RelayMachinePin.self, forKey: .relayPin)
        relayPairingSecret = nil
        relayPairingExpiresAt = nil
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(host, forKey: .host)
        try values.encode(port, forKey: .port)
        try values.encodeIfPresent(expectedFingerprint, forKey: .expectedFingerprint)
        try values.encodeIfPresent(relayPin, forKey: .relayPin)
    }
}

public enum MachineConnectionStatus: Sendable, Equatable {
    case disconnected
    case connecting
    case connected
    case waitingForApproval(fingerprint: String)
    case waitingForRelayConfirmation(fingerprint: String)
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
    public private(set) var verifiedRelayNotification: VerifiedPushNotification?
    public private(set) var relayNotificationNotice: String?
    public private(set) var relayNotificationBusy = false
    public private(set) var lastRelayAnswerOutcome: String?
    @ObservationIgnored private let pushStore: RemiPushStore?
    @ObservationIgnored private var pushTrustIntents: Set<MachineEndpoint> = []
    @ObservationIgnored private var pushEnabled: Set<String> = []
    @ObservationIgnored private var suspendedRelayRooms: Set<Data> = []
    @ObservationIgnored private var tokenRegistration: (token: String, environment: String)?
    @ObservationIgnored private let registrationEpoch = RelayRegistrationEpoch()
    @ObservationIgnored private let answerEpoch = RelayRegistrationEpoch()
    @ObservationIgnored private let presentationEpoch = RelayRegistrationEpoch()
    @ObservationIgnored private var running = false
    #if DEBUG
    @ObservationIgnored private var ownedTestSession: URLSession?
    @ObservationIgnored var ownedBeforeNativeSend: (@Sendable (NativeAnswerProof) async throws -> Void)?
    @ObservationIgnored var ownedBeforeNativeH2: (@Sendable () async throws -> Void)?
    #endif

    @ObservationIgnored private let identity: ClientIdentity
    @ObservationIgnored private let clientVersion: String
    @ObservationIgnored private let clientId: String
    @ObservationIgnored private var connections: [MachineEndpoint: RemiConnection] = [:]
    @ObservationIgnored private(set) var connectionGenerations: [MachineEndpoint: UUID] = [:]
    @ObservationIgnored private var relayPairingContexts: [MachineEndpoint: (Data, UInt64?)] = [:]
    @ObservationIgnored private var parentByConnection: [MachineEndpoint: MachineEndpoint] = [:]
    @ObservationIgnored private var routeBySession: [String: MachineEndpoint] = [:]
    @ObservationIgnored private var sessionByKillRequest: [String: String] = [:]
    @ObservationIgnored private var resumeAttemptsByRequest: [String: ResumeAttempt] = [:]
    @ObservationIgnored private var resumeRequestByChild: [MachineEndpoint: String] = [:]
    @ObservationIgnored private var resumeTimeoutTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var resolvedQuestionRemovalTasks: [String: Task<Void, Never>] = [:]
    private var pendingRelayIDs: Set<String> = []
    @ObservationIgnored private var pendingAnswers: [String: AnswerMessage] = [:]
    @ObservationIgnored private var answerTimeoutTasks: [String: Task<Void, Never>] = [:]

    /// Pending relay pairings are not durable trust. Both app roots save this list after READY.
    public var persistableEndpoints: [MachineEndpoint] {
        machines.map(\.endpoint).filter { !pendingRelayIDs.contains($0.id) }
    }

    public var publicIdentity: PublicClientIdentity { identity.publicIdentity }

    #if DEBUG
    func useOwnedTestSession(_ session: URLSession) { ownedTestSession = session }
    #endif

    private func commitPushReady(_ endpoint: MachineEndpoint, connection: UUID,
                                 explicit: Bool, ledgerGeneration: Int64?) throws {
        guard connectionGenerations[endpoint] == connection else { throw RemiPushError.changed }
        guard let pushStore, let pin = endpoint.relayPin else { return }
        try identity.validateForSigning()
        let machine = try RelayCrypto.unb64(pin.machinePublicKey), room = RelayCrypto.room(machine)
        if explicit {
            guard pushTrustIntents.contains(endpoint), let ledgerGeneration,
                  try pushStore.generation() == ledgerGeneration else { throw RemiPushError.changed }
            var generation = ledgerGeneration
            if try pushStore.authority() != identity.pushAuthority {
                let lease = try pushStore.acquireIdentityMutation(); defer { lease.release() }
                guard try pushStore.generation() == generation else { throw RemiPushError.changed }
                try identity.validateForSigning()
                generation = try lease.invalidate()
                try lease.install(identity.pushAuthority, generation: generation)
            }
            guard var origin = URLComponents(string: pin.relayURL), origin.scheme == "wss" else { throw RemiPushError.invalid }
            origin.scheme = "https"; origin.path = ""
            if origin.port == 443 { origin.port = nil }
            guard let audience = origin.string else { throw RemiPushError.invalid }
            try pushStore.commitMachine(room: room, machinePublicKey: machine, origin: audience,
                relayURL: pin.relayURL, authority: identity.pushAuthority, generation: generation)
            pushTrustIntents.remove(endpoint)
        } else if let trust = try pushStore.machine(room: room) {
            guard trust.authority == identity.pushAuthority, trust.machinePublicKey == machine,
                  Data(trust.relayURL.utf8) == Data(pin.relayURL.utf8) else { throw RemiPushError.changed }
        }
        // A public UserDefaults hint with absent SQLite trust remains only a hint.
    }

    public func enableRelayNotifications(on endpoint: MachineEndpoint) async {
        guard pushStore != nil, let pin = endpoint.relayPin, !pendingRelayIDs.contains(endpoint.id),
              let room = try? RelayCrypto.room(RelayCrypto.unb64(pin.machinePublicKey)),
              !suspendedRelayRooms.contains(room) else {
            relayNotificationNotice = "Finish pairing before enabling relay notifications."; return
        }
        let intent = UUID()
        connectionGenerations[endpoint] = intent
        let foreground = connections.removeValue(forKey: endpoint)
        parentByConnection[endpoint] = nil
        await foreground?.stop()
        guard connectionGenerations[endpoint] == intent, machines.contains(where: { $0.endpoint == endpoint }) else { return }
        pushEnabled.insert(endpoint.id); pushTrustIntents.insert(endpoint)
        relayNotificationNotice = "Authenticating the relay before enabling notifications."
        connect(endpoint, parent: endpoint)
    }

    /// Persisted preference is only registration intent. Existing completed
    /// SQLite authority must already match the current durable private identity.
    @discardableResult public func restoreRelayNotificationIntent(on endpoint: MachineEndpoint) -> Bool {
        guard let pushStore, let pin = endpoint.relayPin else { return false }
        do {
            try identity.validateForSigning()
            let machine = try RelayCrypto.unb64(pin.machinePublicKey), room = RelayCrypto.room(machine)
            guard let trust = try pushStore.machine(room: room), trust.authority == identity.pushAuthority,
                  trust.machinePublicKey == machine, Data(trust.relayURL.utf8) == Data(pin.relayURL.utf8) else { return false }
            pushEnabled.insert(endpoint.id)
            return true
        } catch { return false }
    }

    /// OS delegates provide the token; environment is resolved from actual runtime
    /// entitlements before this call. No bundle-name or configuration inference.
    public func updateRelayPushToken(_ token: Data, environment: String) {
        guard !token.isEmpty, token.count <= 256, ["sandbox", "production"].contains(environment) else { return }
        tokenRegistration = (RelayCrypto.hex(token), environment)
        registrationEpoch.replace()
        for endpoint in machines.map(\.endpoint) where pushEnabled.contains(endpoint.id) {
            if let generation = connectionGenerations[endpoint] { Task { await registerRelayToken(on: endpoint, generation: generation) } }
        }
    }

    private func registerRelayToken(on endpoint: MachineEndpoint, generation: UUID) async {
        guard connectionGenerations[endpoint] == generation, pushEnabled.contains(endpoint.id),
              let tokenRegistration, let pushStore, let pin = endpoint.relayPin, let connection = connections[endpoint] else { return }
        do {
            let room = RelayCrypto.room(try RelayCrypto.unb64(pin.machinePublicKey))
            guard let trust = try pushStore.machine(room: room), trust.authority == identity.pushAuthority,
                  let recipient = try pushStore.recipient(createIfMissing: true) else { throw RemiPushError.unavailable }
            let epoch = registrationEpoch.capture(), ledgerGeneration = try pushStore.generation(), identity = identity
            let epochStore = registrationEpoch
            let validate: @Sendable () throws -> Void = {
                try identity.validateForSigning()
                guard epochStore.matches(epoch), try pushStore.generation() == ledgerGeneration,
                      try pushStore.machine(room: room) == trust, try pushStore.recipient() == recipient else { throw RemiPushError.changed }
            }
            try validate()
            let request = RelayPushRequest(type: "secure_push_register_request", id: UUID().uuidString.lowercased(),
                timestamp: Date().ISO8601Format(), token: tokenRegistration.token, environment: tokenRegistration.environment,
                pushPublicKey: RelayCrypto.b64(recipient.publicKey), keyVersion: recipient.keyVersion)
            let response = try await connection.exchange(request, id: request.id,
                expected: .push(type: "secure_push_register_response", keyVersion: recipient.keyVersion),
                until: .now.advanced(by: .seconds(10)), validate: validate)
            guard connectionGenerations[endpoint] == generation else { return }
            try validate()
            guard case .push(let result) = response, result.success else { throw RemiPushError.unavailable }
            relayNotificationNotice = "Relay notifications enabled."
        } catch {
            if connectionGenerations[endpoint] == generation { relayNotificationNotice = "Relay notifications could not be registered. Enable them again to retry." }
        }
    }

    public func openRelayNotification(carrier: Data) {
        presentationEpoch.replace()
        do {
            guard let pushStore else { throw RemiPushError.unavailable }
            let opened = try pushStore.open(carrier: carrier)
            guard opened.kind != .dismiss else { throw RemiPushError.changed }
            verifiedRelayNotification = opened; relayNotificationNotice = nil
        } catch { verifiedRelayNotification = nil; relayNotificationNotice = "This relay notification is no longer available. Open the current session." }
    }
    public var relayNotificationChoices: [VerifiedPushOption] {
        verifiedRelayNotification.map(NativeAnswerProof.choices) ?? []
    }
    public func closeRelayNotification() { presentationEpoch.replace(); verifiedRelayNotification = nil }

    /// One owner per current device authority/room. It suspends and awaits the
    /// foreground channel before a single bounded resume attempt and never retries.
    public func answerRelayNotification(choice: String) async {
        let began = ContinuousClock.now, settlement = began.advanced(by: .seconds(24))
        guard !relayNotificationBusy, let original = verifiedRelayNotification, let pushStore,
              !suspendedRelayRooms.contains(original.machine.room) else { return }
        let brokerKey = RelayChannelBroker.key(device: identity.publicKeyRaw, room: original.machine.room)
        guard let lease = RelayChannelBroker.shared.claim(key: brokerKey) else {
            relayNotificationNotice = "Another relay answer is still settling."; return
        }
        suspendedRelayRooms.insert(original.machine.room); relayNotificationBusy = true
        let matching = machines.first { state in
            guard let pin = state.endpoint.relayPin, let key = try? RelayCrypto.unb64(pin.machinePublicKey) else { return false }
            return RelayCrypto.room(key) == original.machine.room
        }?.endpoint
        let restoreForeground = running && matching.flatMap { connections[$0] } != nil
        let identity = identity, lifetime = answerEpoch.capture(), lifetimeStore = answerEpoch
        let presentation = presentationEpoch.capture(), presentationStore = presentationEpoch
        let validate: @Sendable () throws -> Void = {
            guard lifetimeStore.matches(lifetime), presentationStore.matches(presentation) else { throw RemiPushError.changed }
            try identity.validateForSigning(); try pushStore.recheck(original)
            let reopened = try pushStore.open(carrier: original.originalCarrier)
            guard reopened.machine == original.machine, reopened.contentDigest == original.contentDigest,
                  reopened.revision == original.revision else { throw RemiPushError.changed }
        }
        if let matching {
            connectionGenerations.removeValue(forKey: matching)
            let foreground = connections.removeValue(forKey: matching); parentByConnection[matching] = nil
            // The broker also retains a prior lifecycle-stop retirement that is
            // no longer present in this Store's dictionary.
            _ = foreground
        }
        await lease.retired.value
        var oneShot: RemiConnection?
        var emitted = false
        do {
            try validate()
            guard ContinuousClock.now < settlement else { throw RelayFailure.expired }
            let pin = try RelayMachinePin(relayURL: original.machine.relayURL,
                machinePublicKey: RelayCrypto.b64(original.machine.machinePublicKey))
            guard let url = pin.clientURL else { throw RelayFailure.malformed }
            let connection = RemiConnection(configuration: .init(url: url, clientVersion: clientVersion,
                clientId: clientId, relayPin: pin), identity: identity.restrictingSignatures(validate),
                readyHandler: { try validate() }, stateHandler: { _ in }, eventHandler: { _ in })
            oneShot = connection
            try await connection.configureOneShot()
            #if DEBUG
            if let ownedTestSession { try await connection.useOwnedTestSession(ownedTestSession) }
            if let ownedBeforeNativeH2 { try await connection.beforeOwnedH2(ownedBeforeNativeH2) }
            #endif
            try validate()
            await connection.start()
            try validate()
            try await connection.waitForRelayReady(until: settlement)
            try validate()
            let now = UInt64(Date().timeIntervalSince1970)
            let reopened = try pushStore.open(carrier: original.originalCarrier)
            let proof = try NativeAnswerProof.make(reopened, choice: choice, identity: identity, now: now)
            #if DEBUG
            try await ownedBeforeNativeSend?(proof)
            try validate()
            #endif
            // Exactly one immutable proof/ID/nonce. A missing result is uncertainty.
            emitted = true
            let result = try await connection.exchange(proof, id: proof.id,
                expected: .answer(session: proof.sessionId, question: proof.questionId), until: settlement,
                validate: { try validate(); guard UInt64(Date().timeIntervalSince1970) < proof.expiresAt else { throw RelayFailure.expired } })
            guard case .answer(let response) = result else { throw RelayFailure.malformed }
            // A delivered answer itself resolves the capsule. Its authenticated,
            // tuple-correlated receipt remains valid after that terminal transition.
            lastRelayAnswerOutcome = response.outcome
            if presentationStore.matches(presentation) {
                relayNotificationNotice = response.outcome == "delivered" ? "Answer delivered." : "The answer was not applied (\(response.outcome))."
                if response.outcome == "delivered" { verifiedRelayNotification = nil }
            }
        } catch {
            lastRelayAnswerOutcome = emitted ? "uncertain" : "refused"
            if presentationStore.matches(presentation) {
                relayNotificationNotice = emitted ? "Delivery is uncertain. Check the current session before answering again." : "The notification could not be answered. Open the current session."
            }
        }
        await oneShot?.stop()
        RelayChannelBroker.shared.release(lease)
        suspendedRelayRooms.remove(original.machine.room); relayNotificationBusy = false
        if restoreForeground, running, answerEpoch.matches(lifetime), let matching,
           machines.contains(where: { $0.endpoint == matching }) { connect(matching, parent: matching) }
    }

    public init(
        endpoints: [MachineEndpoint],
        identity: ClientIdentity,
        clientVersion: String,
        clientId: String,
        pushStore: RemiPushStore? = nil
    ) {
        self.identity = identity
        self.clientVersion = clientVersion
        self.clientId = clientId
        self.pushStore = pushStore
        machines = endpoints.map {
            MachineState(endpoint: $0.publicConfiguration, displayName: $0.displayAddress)
        }
        for endpoint in endpoints {
            if let secret = endpoint.relayPairingSecret {
                pendingRelayIDs.insert(endpoint.id)
                relayPairingContexts[endpoint.publicConfiguration] = (secret, endpoint.relayPairingExpiresAt)
                pushTrustIntents.insert(endpoint.publicConfiguration)
            }
        }
    }

    public func start() {
        running = true
        for machine in machines {
            connect(machine.endpoint, parent: machine.endpoint)
        }
    }

    public func stop() {
        running = false
        registrationEpoch.replace(); answerEpoch.replace()
        for (endpoint, generation) in connectionGenerations {
            if let key = brokerKey(endpoint) { RelayChannelBroker.shared.retire(key: key, id: generation) }
        }
        let activeConnections = Array(connections.values)
        connectionGenerations.removeAll()
        relayPairingContexts.removeAll()
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
        for task in answerTimeoutTasks.values { task.cancel() }
        answerTimeoutTasks.removeAll()
        pendingAnswers.removeAll()
        Task {
            for connection in activeConnections {
                await connection.stop()
            }
        }
    }

    public func addMachine(_ endpoint: MachineEndpoint, displayName: String? = nil) {
        running = true
        if let existing = machines.first(where: { $0.id == endpoint.id }) {
            guard removeMachine(existing.endpoint) else { return }
        }
        let publicEndpoint = endpoint.publicConfiguration
        if let secret = endpoint.relayPairingSecret {
            pendingRelayIDs.insert(publicEndpoint.id)
            relayPairingContexts[publicEndpoint] = (secret, endpoint.relayPairingExpiresAt)
            pushTrustIntents.insert(publicEndpoint)
        }
        machines.append(MachineState(endpoint: publicEndpoint, displayName: displayName ?? endpoint.displayAddress))
        connect(publicEndpoint, parent: publicEndpoint)
    }

    @discardableResult public func removeMachine(_ endpoint: MachineEndpoint) -> Bool {
        registrationEpoch.replace(); answerEpoch.replace()
        if let pin = endpoint.relayPin, let room = try? RelayCrypto.room(RelayCrypto.unb64(pin.machinePublicKey)),
           verifiedRelayNotification?.machine.room == room { verifiedRelayNotification = nil }
        pushTrustIntents.remove(endpoint)
        pendingRelayIDs.remove(endpoint.id)
        relayPairingContexts.removeValue(forKey: endpoint)
        let answerIDs = pendingAnswers.compactMap { id, answer in
            parentByConnection[routeBySession[answer.sessionId] ?? endpoint] == endpoint ? id : nil
        }
        for id in answerIDs {
            pendingAnswers.removeValue(forKey: id)
            answerTimeoutTasks.removeValue(forKey: id)?.cancel()
        }
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
        let endpoints = parentByConnection.compactMap { connection, parent in
            parent == endpoint ? connection : nil
        }
        for child in endpoints {
            if let key = brokerKey(child), let generation = connectionGenerations[child] {
                RelayChannelBroker.shared.retire(key: key, id: generation)
            }
            connectionGenerations.removeValue(forKey: child)
            if let connection = connections.removeValue(forKey: child) {
                Task { await connection.stop() }
            }
            parentByConnection[child] = nil
        }
        // Callback/reconnect authority is invalidated before durable forget.
        if let pin = endpoint.relayPin, let pushStore {
            do { try pushStore.forgetMachine(room: RelayCrypto.room(RelayCrypto.unb64(pin.machinePublicKey))) }
            catch {
                latestOperationError = "The relay notification trust could not be removed. Try Forget again."
                if let index = machines.firstIndex(where: { $0.endpoint == endpoint }) {
                    machines[index].status = .unavailable(reason: latestOperationError)
                }
                return false
            }
        }
        machines.removeAll { $0.endpoint == endpoint }
        pushEnabled.remove(endpoint.id)
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
        return true
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
        if let route = routeBySession[sessionId], route.relayPin != nil {
            guard pendingAnswers.count < 64 else {
                latestOperationError = "Too many answers are awaiting confirmation. Wait before answering."
                return
            }
            guard !pendingAnswers.values.contains(where: { $0.sessionId == sessionId && $0.questionId == questionId }) else { return }
            pendingAnswers[response.id] = response
            answerTimeoutTasks[response.id] = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                self?.finishAnswer(response.id, outcome: "uncertain")
            }
        }
        Task {
            do { try await connection.send(response) }
            catch { self.finishAnswer(response.id, outcome: "uncertain") }
        }
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
        guard endpoint.relayPin == nil else {
            let reason = "Resume is unavailable over the relay. Resume this session on the machine."
            latestOperationError = reason
            resumeErrorsBySession[ResumeSessionKey(machineID: endpoint.id, sessionID: sessionId)] = reason
            return
        }
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
        if let pin = endpoint.relayPin, let room = try? RelayCrypto.room(RelayCrypto.unb64(pin.machinePublicKey)),
           suspendedRelayRooms.contains(room) { return }
        let pairing = relayPairingContexts.removeValue(forKey: endpoint)
        if pendingRelayIDs.contains(endpoint.id), pairing == nil {
            if let index = machines.firstIndex(where: { $0.endpoint == endpoint }) {
                machines[index].status = .unavailable(reason: "Pair again with a new relay token.")
            }
            return
        }
        let generation = UUID()
        let trustIntent = pushTrustIntents.contains(endpoint)
        let pushGeneration = try? pushStore?.generation()
        connectionGenerations[endpoint] = generation
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
                pairingLabel: endpoint.pairingLabel,
                relayPin: endpoint.relayPin
            ),
            identity: identity,
            relayPairingSecret: pairing?.0,
            relayPairingExpiresAt: pairing?.1,
            readyHandler: { [weak self] in
                try await self?.commitPushReady(endpoint, connection: generation,
                    explicit: trustIntent, ledgerGeneration: pushGeneration)
            },
            stateHandler: { [weak self] state in
                Task { @MainActor [weak self] in
                    self?.receive(state, from: endpoint, generation: generation)
                }
            },
            eventHandler: { [weak self] event in
                Task { @MainActor [weak self] in
                    self?.receive(event, from: endpoint, generation: generation)
                }
            }
        )
        connections[endpoint] = connection
        #if DEBUG
        let session = ownedTestSession
        Task { if let session { try? await connection.useOwnedTestSession(session) }; launchConnection(connection, endpoint: endpoint, generation: generation) }
        #else
        launchConnection(connection, endpoint: endpoint, generation: generation)
        #endif
    }

    private func brokerKey(_ endpoint: MachineEndpoint) -> String? {
        guard let pin = endpoint.relayPin, let machine = try? RelayCrypto.unb64(pin.machinePublicKey) else { return nil }
        return RelayChannelBroker.key(device: identity.publicKeyRaw, room: RelayCrypto.room(machine))
    }
    private func launchConnection(_ connection: RemiConnection, endpoint: MachineEndpoint, generation: UUID) {
        guard connectionGenerations[endpoint] == generation else { Task { await connection.stop() }; return }
        guard let key = brokerKey(endpoint) else { Task { await connection.start() }; return }
        let adopted = RelayChannelBroker.shared.adopt(key: key, id: generation, connection: connection,
            current: { [weak self] in await self?.connectionIsCurrent(endpoint, generation: generation) == true },
            resume: { [weak self] in await self?.resumeRetiredForeground(endpoint, generation: generation) })
        if adopted == nil { connections[endpoint] = nil; connectionGenerations[endpoint] = nil; parentByConnection[endpoint] = nil }
    }
    private func connectionIsCurrent(_ endpoint: MachineEndpoint, generation: UUID) -> Bool {
        running && connectionGenerations[endpoint] == generation
    }
    private func resumeRetiredForeground(_ endpoint: MachineEndpoint, generation: UUID) {
        guard connectionIsCurrent(endpoint, generation: generation), !suspendedRelayRooms.contains(
            (try? RelayCrypto.room(RelayCrypto.unb64(endpoint.relayPin?.machinePublicKey ?? ""))) ?? Data()) else { return }
        connections[endpoint] = nil; connectionGenerations[endpoint] = nil; parentByConnection[endpoint] = nil
        connect(endpoint, parent: endpoint)
    }

    func receive(_ state: RemiConnectionState, from endpoint: MachineEndpoint, generation: UUID) {
        guard connectionGenerations[endpoint] == generation, let parent = parentByConnection[endpoint],
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
        case .awaitingRelayConfirmation(let fingerprint):
            machines[index].status = .waitingForRelayConfirmation(fingerprint: fingerprint)
        case .rejected(let reason):
            machines[index].status = .unavailable(reason: reason)
        }
    }

    func receive(_ event: RemiInboundEvent, from endpoint: MachineEndpoint, generation: UUID) {
        guard connectionGenerations[endpoint] == generation, let parent = parentByConnection[endpoint],
              let index = machines.firstIndex(where: { $0.endpoint == parent })
        else { return }

        switch event {
        case .relayStreamEnded(let clean):
            if !clean { latestOperationError = "The relay closed without an authenticated ending. Check the session for uncertain delivery." }
        case .relayReady:
            pendingRelayIDs.remove(parent.id)
            if pushEnabled.contains(endpoint.id) { Task { await registerRelayToken(on: endpoint, generation: generation) } }
        case .answerResult(let result):
            guard let pending = pendingAnswers[result.requestId],
                  routeBySession[pending.sessionId] == endpoint,
                  pending.sessionId == result.sessionId, pending.questionId == result.questionId else { return }
            finishAnswer(result.requestId, outcome: result.outcome)
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
            for port in response.daemonPorts ?? [] where port != parent.port && parent.relayPin == nil {
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
                if parent.relayPin != nil { requestSessions(from: parent) }
                else if let port = response.port {
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
        case .sessionUpdate, .transcriptComplete, .unsupported, .pushRegistration:
            break
        }
    }

    private func finishAnswer(_ requestID: String, outcome: String) {
        guard pendingAnswers.removeValue(forKey: requestID) != nil else { return }
        answerTimeoutTasks.removeValue(forKey: requestID)?.cancel()
        switch outcome {
        case "delivered": latestOperationNotice = "Answer delivered."
        case "stale", "stale-binding", "session-not-found":
            latestOperationError = "The question is no longer available. Refresh before answering."
        default:
            latestOperationError = "Answer delivery is uncertain. Check the session before trying again."
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
        requestSessions(from: parent)
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
