import Darwin
import Foundation
import Observation
import RemiPush

/// A configured transport endpoint plus its optional authenticated machine descriptor (#1531).
/// Legacy daemons still use `host:port` until their descriptor arrives.
public struct MachineEndpoint: Codable, Sendable, Hashable, Identifiable {
    public var id: String {
        if let relayPin { return "relay:\(relayPin.machinePublicKey)@\(relayPin.relayURL)" }
        return "\(host):\(port)"
    }

    public var displayAddress: String { relayPin?.relayURL ?? "\(host):\(port)" }

    public let host: String
    public let port: Int
    public let expectedFingerprint: String?
    /// Full direct pin from a QR or a validated profile. Endpoint Codable omits
    /// it; the profile separately persists authenticated machine authority.
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

    var withoutPairingContext: MachineEndpoint {
        MachineEndpoint(host: host, port: port, expectedFingerprint: expectedFingerprint,
            expectedPublicKey: expectedPublicKey, relayPin: relayPin)
    }

    /// Address ownership is textual/numeric normalization, never DNS resolution.
    var pairingAddressIdentity: String {
        guard relayPin == nil else { return id }
        var ipv4 = in_addr(), ipv6 = in6_addr()
        let normalized: String
        if inet_pton(AF_INET, host, &ipv4) == 1 {
            normalized = withUnsafeBytes(of: ipv4) { Data($0).base64EncodedString() }
        } else if inet_pton(AF_INET6, host, &ipv6) == 1 {
            let bytes = withUnsafeBytes(of: ipv6) { Data($0) }
            normalized = bytes.prefix(12) == Data(repeating: 0, count: 10) + Data([255, 255])
                ? bytes.suffix(4).base64EncodedString() : bytes.base64EncodedString()
        } else {
            normalized = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        }
        return "\(normalized):\(port)"
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
    /// Stable local profile identity. Authenticated wire identity remains `machineID`,
    /// so navigation keys do not change when the active route or descriptor changes.
    public var id: String { navigationID ?? routes[0].id }
    private var navigationID: String?

    public private(set) var routes: [MachineEndpoint]
    /// Authenticated discovery routes remain memory-only and separately bounded.
    private(set) var discoveredRoutes: [MachineEndpoint] = []
    var routingRoutes: [MachineEndpoint] { routes + discoveredRoutes }
    var recoveryRevision: UInt64 = 0
    public var recoveryProgress: MachineRecoveryProgress?
    public var activeConnectionLayer: MachineConnectionLayer? { status == .connected ? endpoint.connectionLayer : nil }
    /// #1586: a healthy locked route has no permitted improvement to search for.
    var needsRouteRecovery: Bool {
        status != .connected || (connectionPreference == .automatic && endpoint.connectionLayer != .local)
    }
    public var attemptedConnectionLayer: MachineConnectionLayer? {
        if let progress = recoveryProgress { return progress.attemptedLayer }
        switch status {
        case .connecting, .waitingForApproval, .waitingForRelayConfirmation: return endpoint.connectionLayer
        default: return nil
        }
    }
    public var connectionPreference: MachineConnectionPreference = .automatic
    public private(set) var endpoint: MachineEndpoint
    public var displayName: String
    public private(set) var machineDescriptor: MachineDescriptor?
    private var persistedMachineID: String?
    private var persistedMachinePublicKey: String?
    var policyOwner = MachineConnectionPolicyFence.shared.makeOwner()
    /// Forget/recreate is a new authority lifetime even when the full pin is identical.
    let pairingLifetime = UUID()
    var configurationIssue: String?
    public var status: MachineConnectionStatus
    public var sessionConnectionIssue: String?
    public var sessions: [DiscoverableSession]
    /// Live events override a list's coarse discovery state until their socket is lost (#1673).
    struct SessionActivity: Sendable, Equatable {
        let status: String
        let origin: MachineEndpoint
    }
    var sessionActivity: [String: SessionActivity] = [:]
    public func activityStatus(for session: DiscoverableSession) -> String {
        sessionActivity[session.sessionId]?.status ?? session.status
    }
    public var hasLoadedSessions: Bool
    public var questions: [QuestionMessage]
    public var capabilities: [String]
    /// The protocol version and capabilities of the latest `hello_ack` from this machine's active
    /// route (#1639). Nil until one arrives; decide with `HubSupport.check`, never by daemon version.
    public internal(set) var helloAck: HubSupportAck?
    public var harnesses: [String]
    public var activeSessions: [DiscoverableSession] { sessions.filter { $0.source == "daemon" } }

    public init(endpoint: MachineEndpoint, displayName: String, configuredDisplayName: Bool = false) {
        self.endpoint = endpoint
        routes = [endpoint]
        self.displayName = displayName
        machineDescriptor = nil
        persistedMachineID = nil
        usesConfiguredDisplayName = configuredDisplayName
        status = .disconnected
        sessions = []
        hasLoadedSessions = false
        questions = []
        capabilities = []
        harnesses = ["claude"]
    }

    /// Stable identity supplied by the authenticated daemon, or the endpoint for legacy peers.
    public var machineID: String { machineDescriptor?.id ?? endpoint.id }

    var usesConfiguredDisplayName: Bool

    mutating func apply(_ descriptor: MachineDescriptor) {
        machineDescriptor = descriptor
        persistedMachineID = descriptor.id
        if !usesConfiguredDisplayName { displayName = descriptor.name }
    }


    mutating func bindPersistedMachineID(_ machineID: String) {
        persistedMachineID = machineID
    }

    mutating func preserveInvalidSavedIdentity(_ profile: MachineRouteProfile) {
        persistedMachineID = profile.machineID
        persistedMachinePublicKey = profile.machinePublicKey
        configurationIssue = "The saved machine identity is invalid. Forget this profile and pair again."
        status = .unavailable(reason: configurationIssue)
    }

    var durableMachineID: String? { persistedMachineID }
    var durableMachinePublicKey: String? { persistedMachinePublicKey }
    var policyMachineID: String? {
        persistedMachineID ?? routes.compactMap(\.relayPin).first.flatMap {
            try? MachineIdentityVerifier.machineID(forRelayPin: $0)
        }
    }

    mutating func bindAuthenticatedPublicKey(_ key: Data) {
        guard let id = try? MachineIdentityVerifier.machineID(forPublicKey: key),
              persistedMachineID == nil || persistedMachineID == id else { return }
        persistedMachineID = id
        persistedMachinePublicKey = RelayCrypto.b64(key)
    }


    mutating func addRoute(_ route: MachineEndpoint) {
        guard !routes.contains(where: { $0.id == route.id }) else { return }
        routes.append(route)
        routes.sort { ($0.relayPin == nil ? 0 : 1) < ($1.relayPin == nil ? 0 : 1) }
    }

    mutating func preserveNavigationID(_ id: String) {
        guard routes.contains(where: { $0.id == id }) else { return }
        navigationID = id
    }

    mutating func appendPairingHint(_ route: MachineEndpoint) {
        guard !routes.contains(where: { $0.id == route.id }) else { return }
        // Admission preserves the first route's navigation identity (#1574).
        routes.append(route)
    }

    mutating func replaceRoute(_ route: MachineEndpoint) {
        guard let index = routes.firstIndex(where: { $0.id == route.id }) else { return }
        routes[index] = route
        if endpoint.id == route.id { endpoint = route }
    }

    mutating func activate(_ route: MachineEndpoint) {
        guard routingRoutes.contains(where: { $0.id == route.id }) else { return }
        endpoint = route
    }

    mutating func installDiscoveredRoute(_ route: MachineEndpoint) {
        guard !routes.contains(where: { $0.id == route.id }), !discoveredRoutes.contains(where: { $0.id == route.id }) else { return }
        if discoveredRoutes.count == LocalDiscoveryLimits.candidatesPerProfile {
            discoveredRoutes.remove(at: discoveredRoutes.firstIndex(where: { $0.id != endpoint.id }) ?? 0)
        }
        discoveredRoutes.append(route)
    }

    mutating func clearDiscoveredRoutes() { discoveredRoutes = [] }
}

public struct ResumedSessionDestination: Sendable, Equatable, Identifiable {
    public let id: UUID
    public let machineID: String
    public let requestedSessionID: String
    public let sessionID: String
}

/// A session on a machine: the machine profile id (`MachineState.id`) with the session id.
/// A session id alone is not unique across machines (a resumed or forked session, an id
/// collision). The store's routes, transcripts, session views, pending answers, kill requests
/// and transcript loading are keyed by it, and its per-session calls take the machine id (#1601).
public typealias MachineSessionKey = ResumeSessionKey

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
    public private(set) var pairingAttempts: [PairingAttemptState] = []
    /// One read-only terminal view per session while its pane is open (#1639).
    public internal(set) var terminalViews: [MachineSessionKey: TerminalViewController] = [:]
    /// One file download per session while its sheet is open (#1639).
    public internal(set) var fileDownloads: [MachineSessionKey: FileDownloadFlow] = [:]
    /// Which routes may carry pane frames. Tests inject another; the app always uses `current`.
    @ObservationIgnored var paneTransportPolicy = PaneTransportPolicy.current
    /// Receives each pane frame instead of the connection, so tests can read what would be sent.
    @ObservationIgnored var paneFrameSender: (@MainActor (String) -> Void)?
    @ObservationIgnored private var pairingCoordinator: PairingAttemptCoordinator?
    @ObservationIgnored private var pairingOriginLifetime: UUID?
    @ObservationIgnored private var recoveryCoordinator: MachineRecoveryCoordinator?
    @ObservationIgnored private var recoveryRequestedLifetimes: Set<UUID> = []
    #if DEBUG
    @ObservationIgnored var ownedBeforePairingAdmission: (@MainActor () async -> Void)?
    var ownedPairingCoordinator: PairingAttemptCoordinator? { pairingCoordinator }
    @ObservationIgnored var ownedBeforeRecoveryAdmission: (@MainActor () async -> Void)?
    var ownedRecoveryCoordinator: MachineRecoveryCoordinator? { recoveryCoordinator }
    func ownedConnectionID(_ endpoint: MachineEndpoint) -> ObjectIdentifier? { connections[endpoint].map(ObjectIdentifier.init) }
    private(set) var ownedSessionListReceipts: Set<String> = []
    func ownedRequestSessions(_ endpoint: MachineEndpoint) -> String? { requestSessions(from: endpoint) }
    var ownedSessionRoutes: [MachineSessionKey: MachineEndpoint] { routeBySession }
    var ownedParentRoutes: [MachineEndpoint: MachineEndpoint] { parentByConnection }
    var ownedTerminalRootIDs: [String] { terminalRootStates.keys.map(\.id).sorted() }
    var ownedApprovalPollCount: Int { approvalPollTasks.count }
    func ownedStartApprovalPolling(_ endpoint: MachineEndpoint) { startApprovalPolling(for: endpoint) }
    #endif
    public private(set) var transcriptsBySession: [MachineSessionKey: [TranscriptContentMessage]] = [:]
    /// A selected conversation reloads when its owning socket becomes ready or reconnects.
    /// The routing table itself is not observable; a task keyed only by session id misses this.
    public private(set) var transcriptRouteGenerations: [MachineSessionKey: UUID] = [:]
    /// Sessions whose transcript has been requested and has not finished arriving (#1602).
    public private(set) var transcriptsLoading: Set<MachineSessionKey> = []
    public private(set) var sessionViewsBySession: [MachineSessionKey: [SessionViewMeta]] = [:]
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
    public private(set) var pairedNotificationStates: [String: PairedNotificationState] = [:]
    @ObservationIgnored private var notificationAttempts: [String: UUID] = [:]
    @ObservationIgnored private let pushStore: RemiPushStore?
    @ObservationIgnored private var pushTrustIntents: Set<MachineEndpoint> = []
    @ObservationIgnored private var pushRenewalIntents: Set<MachineEndpoint> = []
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
    @ObservationIgnored var ownedBeforeNativeSignature: (@Sendable () throws -> Void)?
    #endif

    @ObservationIgnored private let identity: ClientIdentity
    @ObservationIgnored private let clientVersion: String
    @ObservationIgnored private let clientId: String
    @ObservationIgnored var connections: [MachineEndpoint: RemiConnection] = [:]
    /// Bounded retries for machines waiting for local approval (#1599); see ApprovalPollPolicy.
    @ObservationIgnored private var approvalPollTasks: [MachineEndpoint: Task<Void, Never>] = [:]
    /// Injectable so tests can use a short interval; production always uses the standard policy.
    @ObservationIgnored var approvalPollPolicy = ApprovalPollPolicy.standard
    @ObservationIgnored private(set) var connectionGenerations: [MachineEndpoint: UUID] = [:]
    @ObservationIgnored private var relayPairingContexts: [MachineEndpoint: (Data, UInt64?)] = [:]
    @ObservationIgnored private var parentByConnection: [MachineEndpoint: MachineEndpoint] = [:]
    @ObservationIgnored private var connectedRoutes: Set<MachineEndpoint> = []
    @ObservationIgnored private var failedDirectRoutes: Set<MachineEndpoint> = []
    @ObservationIgnored private var terminalRootStates: [MachineEndpoint: RemiConnectionState] = [:]
    @ObservationIgnored private var failedChildConnections: Set<MachineEndpoint> = []
    @ObservationIgnored var routeBySession: [MachineSessionKey: MachineEndpoint] = [:]
    /// One timer per loading key, so a repeat load replaces the older timer instead of being cut
    /// short by it. The request id says which request the timer and a failure belong to.
    @ObservationIgnored private var transcriptLoadTimers: [MachineSessionKey: (requestID: String, task: Task<Void, Never>)] = [:]
    @ObservationIgnored private var transcriptKeyByRequest: [String: MachineSessionKey] = [:]
    /// How long a load may run without a completion; tests shorten it.
    @ObservationIgnored var transcriptLoadTimeoutOverride: Duration?
    @ObservationIgnored var sessionByKillRequest: [String: MachineSessionKey] = [:]
    @ObservationIgnored private var resumeAttemptsByRequest: [String: ResumeAttempt] = [:]
    @ObservationIgnored private var resumeRequestByChild: [MachineEndpoint: String] = [:]
    @ObservationIgnored private var resumeTimeoutTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var resolvedQuestionRemovalTasks: [String: Task<Void, Never>] = [:]
    private var pendingRelayIDs: Set<String> = []
    @ObservationIgnored private var pendingAnswers: [String: PendingAnswer] = [:]
    @ObservationIgnored private var localNotificationAnswers: Set<RemiNavigationDestination> = []
    #if DEBUG
    /// Replaces the wire send of a transcript request, so a timer test does not depend on a live hub.
    @ObservationIgnored var ownedTranscriptSend: (@MainActor (TranscriptLoadRequestMessage) async throws -> Void)?
    @ObservationIgnored var ownedBeforeLocalAnswerSend: (@Sendable () async throws -> Void)?
    #endif
    @ObservationIgnored private var answerTimeoutTasks: [String: Task<Void, Never>] = [:]

    /// Pending relay pairings are not durable trust. Both app roots save this list after READY.
    public var persistableEndpoints: [MachineEndpoint] {
        machines.flatMap(\.routes).filter { !pendingRelayIDs.contains($0.id) }
    }


    public var persistableProfiles: [MachineRouteProfile] {
        machines.map { machine in
            MachineRouteProfile(
                machineID: machine.durableMachineID,
                routes: machine.routes.filter { !pendingRelayIDs.contains($0.id) },
                displayName: machine.usesConfiguredDisplayName ? machine.displayName : nil,
                connectionPreference: machine.connectionPreference,
                machinePublicKey: machine.durableMachinePublicKey, navigationID: machine.id
            )
        }.filter { !$0.routes.isEmpty }
    }

    public var publicIdentity: PublicClientIdentity { identity.publicIdentity }

    #if DEBUG
    func useOwnedTestSession(_ session: URLSession) { ownedTestSession = session }
    var ownedPendingAnswerCount: Int { pendingAnswers.count }
    var ownedResumeRequestIDs: [String] { Array(resumeAttemptsByRequest.keys) }
    var ownedConnectionMachineIDs: [MachineEndpoint: String] { connections.compactMapValues(\.ownedExpectedMachineID) }
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
        if pairedNotificationState(for: endpoint) == .renewalRequired { pushRenewalIntents.insert(endpoint) }
        connectionGenerations[endpoint] = intent
        let foreground = connections.removeValue(forKey: endpoint)
        parentByConnection[endpoint] = nil
        await foreground?.stop()
        guard connectionGenerations[endpoint] == intent, machines.contains(where: { $0.endpoint == endpoint }) else { return }
        pushEnabled.insert(endpoint.id); pushTrustIntents.insert(endpoint)
        relayNotificationNotice = "Authenticating the relay before enabling notifications."
        connect(endpoint, parent: endpoint)
    }

    public func pairedNotificationState(for endpoint: MachineEndpoint) -> PairedNotificationState? {
        guard let index = machineIndex(containing: endpoint) else { return nil }
        return pairedNotificationStates[machines[index].id]
    }

    /// Current direct authentication bootstraps a separate notification-only route (#1680).
    public func registerPairedNotifications(on endpoint: MachineEndpoint, continueAfterInactivity: Bool = false) async {
        guard let index = machineIndex(containing: endpoint), let pushStore,
              machines[index].endpoint == endpoint, endpoint.relayPin == nil,
              machines[index].status == .connected,
              let connection = connections[endpoint], let generation = connectionGenerations[endpoint],
              let tokenRegistration else { return }
        let host = machines[index].id, pairing = machines[index].pairingLifetime
        guard notificationAttempts[host] == nil else { return }
        guard machines[index].capabilities.contains("notifications") else {
            pairedNotificationStates[host] = .unsupported; return
        }
        let attempt = UUID()
        notificationAttempts[host] = attempt; pairedNotificationStates[host] = .registering
        defer {
            if notificationAttempts[host] == attempt {
                notificationAttempts[host] = nil
                if pairedNotificationStates[host] == .registering,
                   machines.contains(where: { $0.id == host && $0.pairingLifetime == pairing }) {
                    pairedNotificationStates[host] = .failed
                }
            }
        }
        let epochStore = registrationEpoch, epoch = registrationEpoch.capture(), identity = identity
        let ledgerGeneration = try? pushStore.generation()
        let validate: @Sendable () throws -> Void = {
            try identity.validateForSigning()
            guard !Task.isCancelled, epochStore.matches(epoch), let ledgerGeneration,
                  try pushStore.generation() == ledgerGeneration else { throw RemiPushError.changed }
        }
        func current() -> Bool {
            guard let found = machineIndex(containing: endpoint) else { return false }
            return notificationAttempts[host] == attempt && connectionGenerations[endpoint] == generation && connections[endpoint] === connection &&
                machines[found].id == host && machines[found].pairingLifetime == pairing && running
        }
        do {
            try validate()
            let (key, validateConnection) = try await connection.notificationHostPermit()
            guard current() else { throw RemiPushError.changed }
            let request = NotificationHostRequest(action: continueAfterInactivity ? "continue" : "enable")
            let response = try await connection.exchange(request, id: request.id, expected: .notificationHost,
                until: .now.advanced(by: .seconds(12)), validate: { try validate(); try validateConnection() })
            try validate()
            try validateConnection()
            guard current(), try await connection.notificationHostKey() == key,
                  case .notificationHost(let status) = response else { throw RemiPushError.changed }
            guard status.success else {
                pairedNotificationStates[host] = status.error == "HOST_SETUP_REQUIRED" ? .hostSetupRequired :
                    status.error == "UNSUPPORTED" ? .unsupported : .failed
                return
            }
            if status.state == "renewal_required" { pairedNotificationStates[host] = .renewalRequired; return }
            guard let route = status.relayUrl, let ledgerGeneration else { throw RemiPushError.invalid }
            let pin = try RelayMachinePin(relayURL: route, machinePublicKey: RelayCrypto.b64(key))
            let room = RelayCrypto.room(key)
            var origin = URLComponents(string: route)
            origin?.scheme = "https"
            guard let audience = origin?.string else { throw RemiPushError.invalid }
            try validate()
            guard current() else { throw RemiPushError.changed }
            try pushStore.commitNotificationMachine(room: room, machinePublicKey: key, origin: audience,
                relayURL: route, authority: identity.pushAuthority, generation: ledgerGeneration)
            guard let trust = try pushStore.machine(room: room) else { throw RemiPushError.changed }
            let registered = try await PairedNotificationRegistration.register(pin: pin, identity: identity,
                pushStore: pushStore, token: tokenRegistration.token, environment: tokenRegistration.environment,
                renewExpired: continueAfterInactivity, validate: {
                    try validate()
                    try validateConnection()
                    guard try pushStore.machine(room: room) == trust else { throw RemiPushError.changed }
                }, ownedSession: notificationOwnedSession)
            try validate()
            guard current() else { throw RemiPushError.changed }
            pairedNotificationStates[host] = registered.success ? .registered :
                registered.error == "RENEWAL_REQUIRED" ? .renewalRequired : .failed
        } catch {
            if current() { pairedNotificationStates[host] = .failed }
        }
    }

    private var notificationOwnedSession: URLSession? {
        #if DEBUG
        ownedTestSession
        #else
        nil
        #endif
    }

    /// Local trust is removed before awaiting host acknowledgement or accepting late callbacks.
    @discardableResult public func revokePairedNotifications(on endpoint: MachineEndpoint) async -> Bool {
        guard let index = machineIndex(containing: endpoint), let pushStore else { return false }
        let host = machines[index].id
        let identity = identity
        registrationEpoch.replace()
        notificationAttempts[host] = nil
        pushEnabled.remove(endpoint.id); pushTrustIntents.remove(endpoint); pushRenewalIntents.remove(endpoint)
        do {
            let rooms = notificationRooms(for: machines[index])
            for trust in try pushStore.notificationMachines() where rooms.contains(trust.room) {
                try pushStore.forgetMachine(room: trust.room)
            }
            pairedNotificationStates[host] = .disabled
            let connection = connections[endpoint]
            if endpoint.relayPin != nil {
                let request = RelayPushRequest(type: "secure_push_unregister_request", id: UUID().uuidString.lowercased(),
                    timestamp: Date().ISO8601Format(), token: nil, environment: nil, pushPublicKey: nil, keyVersion: nil)
                let response = try await connection?.exchange(request, id: request.id,
                    expected: .push(type: "secure_push_unregister_response", keyVersion: nil),
                    until: .now.advanced(by: .seconds(12)), validate: { try identity.validateForSigning() })
                guard case .push(let result) = response, result.success else { throw RemiPushError.unavailable }
                return true
            }
            let key = try await connection?.notificationHostKey()
            guard let key else { throw RemiPushError.unavailable }
            try pushStore.forgetMachine(room: RelayCrypto.room(key))
            let request = NotificationHostRequest(action: "revoke")
            let response = try await connection?.exchange(request, id: request.id, expected: .notificationHost,
                until: .now.advanced(by: .seconds(12)), validate: { try identity.validateForSigning() })
            guard case .notificationHost(let result) = response, result.success, result.state == "revoked" else {
                throw RemiPushError.unavailable
            }
            return true
        } catch {
            relayNotificationNotice = "Notifications are disabled here. Reconnect to confirm revocation on the host."
            return false
        }
    }

    /// A restored profile's display ID is an endpoint until discovery arrives.
    /// Revocation instead derives rooms from validated durable key material (#1680).
    private func notificationRooms(for machine: MachineState) -> Set<Data> {
        var keys: [Data] = []
        if let saved = machine.durableMachinePublicKey, let key = try? RelayCrypto.unb64(saved) { keys.append(key) }
        for route in machine.routingRoutes {
            if let saved = route.expectedPublicKey, let key = Data(base64Encoded: saved), key.base64EncodedString() == saved { keys.append(key) }
            if let pin = route.relayPin, let key = try? RelayCrypto.unb64(pin.machinePublicKey) { keys.append(key) }
        }
        return Set(keys.compactMap { key in
            guard (try? MachineIdentityVerifier.machineID(forPublicKey: key)) != nil else { return nil }
            return RelayCrypto.room(key)
        })
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
            var request = RelayPushRequest(type: "secure_push_register_request", id: UUID().uuidString.lowercased(),
                timestamp: Date().ISO8601Format(), token: tokenRegistration.token, environment: tokenRegistration.environment,
                pushPublicKey: RelayCrypto.b64(recipient.publicKey), keyVersion: recipient.keyVersion)
            request.renewExpired = pushRenewalIntents.remove(endpoint) != nil
            let response = try await connection.exchange(request, id: request.id,
                expected: .push(type: "secure_push_register_response", keyVersion: recipient.keyVersion),
                until: .now.advanced(by: .seconds(10)), validate: validate)
            guard connectionGenerations[endpoint] == generation else { return }
            try validate()
            guard case .push(let result) = response else { throw RemiPushError.unavailable }
            if let index = machineIndex(containing: endpoint) {
                pairedNotificationStates[machines[index].id] = result.success ? .registered :
                    result.error == "RENEWAL_REQUIRED" ? .renewalRequired : .failed
            }
            guard result.success else { throw RemiPushError.unavailable }
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

    /// This entry uses the foreground presentation chosen by the person.
    public func answerRelayNotification(choice: String) async {
        guard let original = verifiedRelayNotification else { return }
        _ = await answerRelayNotification(original: original, choice: choice, action: nil)
    }

    /// Background actions enter only through the same facade's opaque verified
    /// original-content context, without creating or replacing an app card.
    public func answerRelayNotification(action: VerifiedPushActionContext) async -> RelayNotificationAnswerOutcome {
        guard let pushStore else { return .refused }
        do { try pushStore.recheckAction(action) }
        catch { return .refused }
        return await answerRelayNotification(original: action.notification, choice: action.action.value, action: action)
    }

    /// One owner per current device authority/room. It suspends and awaits the
    /// foreground channel before a single bounded resume attempt and never retries.
    private func answerRelayNotification(original: VerifiedPushNotification, choice: String,
                                         action: VerifiedPushActionContext?) async -> RelayNotificationAnswerOutcome {
        // Reserve two seconds of the 25-second total for the bounded BYE and
        // URLSession cancellation/actor retirement, not only BYE emission.
        let began = ContinuousClock.now, settlement = began.advanced(by: .seconds(23))
        guard let pushStore else { return .refused }
        guard original.machine.notificationOnly || MachineConnectionPolicyFence.shared.permitsRelay(room: original.machine.room) else {
            if action == nil { relayNotificationNotice = "This machine is locked to a direct layer. Open the session to answer there." }
            return .refused
        }
        guard !relayNotificationBusy, !suspendedRelayRooms.contains(original.machine.room) else { return .busy }
        let brokerKey = RelayChannelBroker.key(device: identity.publicKeyRaw, room: original.machine.room)
        guard let lease = RelayChannelBroker.shared.claim(key: brokerKey) else {
            if action == nil { relayNotificationNotice = "Another relay answer is still settling." }
            return .busy
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
            guard original.machine.notificationOnly || MachineConnectionPolicyFence.shared.permitsRelay(room: original.machine.room) else { throw RemiPushError.changed }
            guard lifetimeStore.matches(lifetime), action != nil || presentationStore.matches(presentation), !Task.isCancelled else { throw RemiPushError.changed }
            try identity.validateForSigning(); try pushStore.recheck(original)
            if let action { try pushStore.recheckAction(action) }
            let reopened = try pushStore.open(carrier: original.originalCarrier)
            guard reopened.machine == original.machine, reopened.contentDigest == original.contentDigest,
                  reopened.revision == original.revision else { throw RemiPushError.changed }
        }
        #if DEBUG
        let ownedBeforeNativeSignature = self.ownedBeforeNativeSignature
        #endif
        let restrict: @Sendable () throws -> Void = {
            #if DEBUG
            try ownedBeforeNativeSignature?()
            #endif
            try validate()
        }
        let answerIdentity = identity.restrictingSignatures(restrict)
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
        var outcome = RelayNotificationAnswerOutcome.refused
        do {
            try validate()
            guard ContinuousClock.now < settlement else { throw RelayFailure.expired }
            let pin = try RelayMachinePin(relayURL: original.machine.relayURL,
                machinePublicKey: RelayCrypto.b64(original.machine.machinePublicKey))
            guard let url = pin.clientURL else { throw RelayFailure.malformed }
            let connection = RemiConnection(configuration: .init(url: url, clientVersion: clientVersion,
                clientId: clientId, relayPin: pin), identity: answerIdentity,
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
            let proof = try NativeAnswerProof.make(reopened, choice: choice, identity: answerIdentity, now: now)
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
            // A signed terminal capsule may arrive before its authenticated,
            // tuple-correlated receipt. That receipt remains valid after the transition.
            outcome = RelayNotificationAnswerOutcome(rawValue: response.outcome) ?? .uncertain
            lastRelayAnswerOutcome = outcome.rawValue
            if action == nil, presentationStore.matches(presentation) {
                relayNotificationNotice = response.outcome == "delivered" ? "Answer delivered." :
                    response.outcome == "uncertain" ? "Delivery is uncertain. Check the current session before answering again." :
                    "The answer was not applied (\(response.outcome))."
                if response.outcome == "delivered" { verifiedRelayNotification = nil }
            }
        } catch {
            outcome = emitted ? .uncertain : .refused
            lastRelayAnswerOutcome = outcome.rawValue
            if action == nil, presentationStore.matches(presentation) {
                relayNotificationNotice = emitted ? "Delivery is uncertain. Check the current session before answering again." : "The notification could not be answered. Open the current session."
            }
        }
        await oneShot?.stop()
        RelayChannelBroker.shared.release(lease)
        suspendedRelayRooms.remove(original.machine.room); relayNotificationBusy = false
        if restoreForeground, running, answerEpoch.matches(lifetime), let matching,
           machines.contains(where: { $0.endpoint == matching }) { connect(matching, parent: matching) }
        return outcome
    }

    public init(
        endpoints: [MachineEndpoint],
        identity: ClientIdentity,
        clientVersion: String,
        clientId: String,
        pushStore: RemiPushStore? = nil,
        displayNames: [String: String] = [:]
    ) {
        self.identity = identity
        self.clientVersion = clientVersion
        self.clientId = clientId
        self.pushStore = pushStore
        machines = endpoints.map {
            MachineState(
                endpoint: $0.publicConfiguration,
                displayName: displayNames[$0.id] ?? $0.displayAddress,
                configuredDisplayName: displayNames[$0.id] != nil
            )
        }
        for endpoint in endpoints {
            if let secret = endpoint.relayPairingSecret {
                pendingRelayIDs.insert(endpoint.id)
                relayPairingContexts[endpoint.publicConfiguration] = (secret, endpoint.relayPairingExpiresAt)
                pushTrustIntents.insert(endpoint.publicConfiguration)
            }
        }
    }

    public init(
        profiles: [MachineRouteProfile],
        identity: ClientIdentity,
        clientVersion: String,
        clientId: String,
        pushStore: RemiPushStore? = nil
    ) {
        self.identity = identity
        self.clientVersion = clientVersion
        self.clientId = clientId
        self.pushStore = pushStore
        MachineConnectionPolicyFence.shared.seed(profiles)
        let safeProfiles = profiles.flatMap { profile -> [(profile: MachineRouteProfile, invalid: Bool)] in
            do {
                guard let verified = try profile.verifiedSavedIdentity() else {
                    return profile.routes.map { (MachineRouteProfile(machineID: nil, routes: [$0], displayName: profile.displayName,
                        connectionPreference: profile.connectionPreference), false) }
                }
                let pinned = profile.routes.map { route in
                    guard route.relayPin == nil else { return route }
                    return MachineEndpoint(host: route.host, port: route.port,
                        expectedFingerprint: route.expectedFingerprint, expectedPublicKey: verified.key.base64EncodedString(),
                        pairingNonce: route.pairingNonce, pairingLabel: route.pairingLabel)
                }
                return [(MachineRouteProfile(machineID: verified.machineID, routes: pinned, displayName: profile.displayName,
                    connectionPreference: profile.connectionPreference, machinePublicKey: RelayCrypto.b64(verified.key), navigationID: profile.navigationID), false)]
            } catch {
                return [(profile, true)]
            }
        }
        machines = safeProfiles.compactMap { item in
            let profile = item.profile
            guard let first = profile.routes.first else { return nil }
            var state = MachineState(
                endpoint: first.publicConfiguration,
                displayName: profile.displayName ?? first.displayAddress,
                configuredDisplayName: profile.displayName != nil
            )
            for route in profile.routes.dropFirst() { state.addRoute(route.publicConfiguration) }
            if let navigationID = profile.navigationID { state.preserveNavigationID(navigationID) }
            state.connectionPreference = profile.connectionPreference
            if item.invalid {
                state.preserveInvalidSavedIdentity(profile)
                return state
            }
            if let machineID = profile.machineID { state.bindPersistedMachineID(machineID) }
            if let encoded = profile.machinePublicKey, let key = try? RelayCrypto.unb64(encoded) {
                state.bindAuthenticatedPublicKey(key)
            }
            if let firstAllowed = state.connectionPreference.orderedRoutes(state.routes).first { state.activate(firstAllowed) }
            if let id = state.policyMachineID {
                MachineConnectionPolicyFence.shared.publish(state.connectionPreference, machineID: id, owner: state.policyOwner)
            }
            return state
        }
        for item in safeProfiles where !item.invalid {
            let profile = item.profile
            for endpoint in profile.routes {
                guard let secret = endpoint.relayPairingSecret else { continue }
                pendingRelayIDs.insert(endpoint.id)
                relayPairingContexts[endpoint.publicConfiguration] = (secret, endpoint.relayPairingExpiresAt)
                pushTrustIntents.insert(endpoint.publicConfiguration)
            }
        }
    }

    private func recovery() -> MachineRecoveryCoordinator {
        if let recoveryCoordinator { return recoveryCoordinator }
        let coordinator = MachineRecoveryCoordinator(identity: identity, clientVersion: clientVersion, clientID: clientId,
            snapshot: { [weak self] in self?.recoveryTargets() ?? [] },
            validate: { [weak self] target, endpoint in
                guard let self else { throw CancellationError() }
                try self.validateRecovery(target, endpoint: endpoint)
            }, admit: { [weak self] target, endpoint, discovered, connection, generation, hello, key in
                guard let self else { throw CancellationError() }
                try self.validateRecovery(target, endpoint: endpoint)
                return try self.admitRecovery(target: target, endpoint: endpoint, discovered: discovered,
                    connection: connection, generation: generation, hello: hello, key: key)
            }, forward: { [weak self] callback, adoption in
                switch callback {
                case .state(let state): self?.receive(state, from: adoption.endpoint, generation: adoption.generation)
                case .event(let event): self?.receive(event, from: adoption.endpoint, generation: adoption.generation)
                case .authenticationRetry: break
                }
            }, resume: { [weak self] adoption in
                self?.resumeRetiredForeground(adoption.endpoint, generation: adoption.generation)
            }, publish: { [weak self] id, progress in
                guard let self, let index = self.machines.firstIndex(where: { $0.id == id }),
                      self.recoveryTerminalRoot(for: self.machines[index]) == nil else { return }
                guard self.machines[index].needsRouteRecovery || progress.phase == .recovered else { return }
                self.machines[index].recoveryProgress = progress
                if progress.phase == .probing { self.recoveryRequestedLifetimes.insert(self.machines[index].pairingLifetime) }
                if self.machines[index].status != .connected {
                    switch progress.phase {
                    case .probing: self.machines[index].status = .connecting
                    case .waiting, .exhausted: self.machines[index].status = .unavailable(reason: progress.message)
                    default: break
                    }
                }
            })
        #if DEBUG
        coordinator.ownedBeforeAdmission = { [weak self] in await self?.ownedBeforeRecoveryAdmission?() }
        #endif
        recoveryCoordinator = coordinator
        return coordinator
    }

    func recoveryTargets() -> [MachineRecoveryTarget] {
        guard running else { return [] }
        return machines.compactMap { machine in
            guard machine.configurationIssue == nil, machine.needsRouteRecovery else { return nil }
            if machine.status == .connecting, !recoveryRequestedLifetimes.contains(machine.pairingLifetime) { return nil }
            if pairingOriginLifetime == machine.pairingLifetime,
               pairingAttempts.last?.phase.isTerminal == false { return nil }
            guard recoveryTerminalRoot(for: machine) == nil else { return nil }
            let profile = MachineRouteProfile(machineID: machine.durableMachineID,
                routes: machine.routes.filter { !pendingRelayIDs.contains($0.id) },
                displayName: machine.usesConfiguredDisplayName ? machine.displayName : nil,
                connectionPreference: machine.connectionPreference, machinePublicKey: machine.durableMachinePublicKey,
                navigationID: machine.id)
            return MachineRecoveryTarget(profile: profile, lifetime: machine.pairingLifetime,
                revision: machine.recoveryRevision, healthyLayer: machine.activeConnectionLayer)
        }
    }

    /// Only owned root callbacks populate this cache. Compare route IDs because
    /// authenticated pin learning can change an endpoint's value (#1575).
    private func recoveryTerminalRoot(for machine: MachineState) -> MachineEndpoint? {
        let roots = Set(machine.routingRoutes.map(\.id))
        return terminalRootStates.first { route, state in
            guard roots.contains(route.id) else { return false }
            switch state {
            case .rejected, .awaitingLocalApproval, .awaitingRelayConfirmation: return true
            default: return false
            }
        }?.key
    }

    func validateRecovery(_ target: MachineRecoveryTarget, endpoint: MachineEndpoint) throws {
        guard running, let machine = machines.first(where: { $0.id == target.id && $0.pairingLifetime == target.lifetime }),
              recoveryTerminalRoot(for: machine) == nil,
              machine.configurationIssue == nil, machine.recoveryRevision == target.revision,
              machine.connectionPreference == target.profile.connectionPreference,
              machine.connectionPreference.permits(endpoint),
              machine.durableMachineID == target.machineID,
              machine.durableMachinePublicKey == RelayCrypto.b64(target.key),
              machine.activeConnectionLayer.map({ endpoint.connectionLayer < $0 }) ?? true,
              endpoint.relayPin == nil || machine.routes.contains(where: { $0.relayPin == endpoint.relayPin && !pendingRelayIDs.contains($0.id) }),
              pairingOriginLifetime != machine.pairingLifetime || pairingAttempts.last?.phase.isTerminal != false else {
            throw PairingAdmissionError.refused("The saved profile, connection policy or active route changed during recovery.")
        }
    }

    /// Called only inside the ordered bridge's synchronous validity fence, after
    /// full-key, machine-ID and session-less Hello verification on this socket.
    func admitRecovery(target: MachineRecoveryTarget, endpoint: MachineEndpoint, discovered: Bool,
                       connection: RemiConnection, generation: UUID, hello: HelloAckMessage, key: Data) throws -> PairingAdoption {
        // The caller rechecked all mutable authority immediately before this
        // synchronous commit. Never add an await between that check and install.
        guard let index = machines.firstIndex(where: { $0.id == target.id && $0.pairingLifetime == target.lifetime }) else {
            throw CancellationError()
        }
        let hadConnection = parentByConnection.values.contains { machines[index].routingRoutes.contains($0) }
        let configured = machines[index].routes.first { $0.id == endpoint.id }
        let admitted = configured.map(target.pinned) ?? endpoint
        retireProfileConnections(machineIndex: index,
            reason: "The connection changed. Delivery is uncertain; check the session before resuming again.")
        // Retire the previous owner before replacing its value. A candidate
        // resolving to a configured route is still that route, not ephemeral.
        if configured != nil { machines[index].replaceRoute(admitted) }
        else if discovered { machines[index].installDiscoveredRoute(admitted) }
        machines[index].activate(admitted)
        recoveryRequestedLifetimes.remove(machines[index].pairingLifetime)
        connections[admitted] = connection
        connectionGenerations[admitted] = generation
        parentByConnection[admitted] = admitted
        if hadConnection {
            latestOperationNotice = "The connection changed. Pending answers, Cancel, chat and session requests may be uncertain. Check the current session before trying again."
        }
        let adoption = PairingAdoption(endpoint: admitted, generation: generation, profileID: machines[index].id)
        receive(.hello(hello, authorityPublicKey: key), from: admitted, generation: generation)
        if admitted.relayPin != nil, pushEnabled.contains(admitted.id) { Task { await registerRelayToken(on: admitted, generation: generation) } }
        return adoption
    }

    func foregroundRecoveryActivated() {
        guard running else { return }
        recovery().start()
        recovery().trigger(newEpisode: true)
    }

    public func start() {
        running = true
        for index in machines.indices {
            startPermittedRoutes(machineIndex: index)
        }
        recovery().start()
    }

    private func startPermittedRoutes(machineIndex index: Int) {
        guard machines[index].configurationIssue == nil else { return }
        let routes = machines[index].connectionPreference.orderedRoutes(machines[index].routes)
        guard let first = routes.first else {
            machines[index].status = .unavailable(reason:
                "No \(machines[index].connectionPreference.title) route is configured. Add that address or pair over that layer.")
            return
        }
        machines[index].activate(first)
        connect(first, parent: first)
    }

    /// A layer change is an explicit routing decision, never a replay of an
    /// outstanding operation. Retire generations before closing the sockets.
    public func setConnectionPreference(_ preference: MachineConnectionPreference, for endpoint: MachineEndpoint) {
        guard let index = machineIndex(containing: endpoint) else { return }
        if machines[index].connectionPreference != preference,
           pairingOriginLifetime == machines[index].pairingLifetime { pairingCoordinator?.cancel() }
        if let id = machines[index].policyMachineID {
            MachineConnectionPolicyFence.shared.publish(preference, machineID: id,
                owner: machines[index].policyOwner, explicit: true)
        }
        guard machines[index].connectionPreference != preference else { return }
        recoveryCoordinator?.invalidate()
        machines[index].recoveryRevision &+= 1
        machines[index].connectionPreference = preference
        retireProfileConnections(machineIndex: index,
            reason: "The connection layer changed. Check the session list before resuming again.")
        machines[index].clearDiscoveredRoutes()
        machines[index].recoveryProgress = nil
        machines[index].status = running ? .connecting : .disconnected
        machines[index].sessionConnectionIssue = nil
        if let selected = preference.orderedRoutes(machines[index].routes).first {
            machines[index].activate(selected)
        } else {
            machines[index].status = .unavailable(reason: "No \(preference.title) route is configured.")
        }
        if running { startPermittedRoutes(machineIndex: index); recovery().trigger(newEpisode: true) }
    }

    private func retireProfileConnections(machineIndex index: Int, reason: String) {
        machines[index].sessionActivity.removeAll()
        let roots = Set(machines[index].routingRoutes)
        failedDirectRoutes.subtract(roots)
        for root in roots { terminalRootStates[root] = nil }
        let retired = parentByConnection.filter { roots.contains($0.value) }.map(\.key)
        let retiredSet = Set(retired)
        for answer in Array(pendingAnswers.values) where routeBySession[answer.key].map(retiredSet.contains) == true {
            finishAnswer(answer.id, outcome: "uncertain")
        }
        for (requestID, attempt) in Array(resumeAttemptsByRequest) where roots.contains(attempt.parent) {
            finishResume(requestID: requestID, error: reason)
        }
        routeBySession = routeBySession.filter { !retiredSet.contains($0.value) }
        transcriptRouteGenerations = transcriptRouteGenerations.filter { routeBySession[$0.key] != nil }
        for route in retired {
            if let key = brokerKey(route), let generation = connectionGenerations[route] {
                RelayChannelBroker.shared.retire(key: key, id: generation)
            }
            connectedRoutes.remove(route)
            failedDirectRoutes.remove(route)
            connectionGenerations[route] = nil
            parentByConnection[route] = nil
            if let connection = connections.removeValue(forKey: route) { Task { await connection.stop() } }
        }
    }

    public func stop() {
        retireForeground(invalidateAnswers: true)
    }

    /// #1385: background suspension retires foreground sockets and prevents their
    /// restoration, while an independently owned, deadline-bound push action finishes.
    public func suspendForegroundConnections() {
        retireForeground(invalidateAnswers: false)
    }

    private func retireForeground(invalidateAnswers: Bool) {
        pairingCoordinator?.cancel()
        recoveryCoordinator?.stop()
        recoveryRequestedLifetimes.removeAll()
        for task in approvalPollTasks.values { task.cancel() }
        approvalPollTasks.removeAll()
        running = false
        registrationEpoch.replace()
        if invalidateAnswers { answerEpoch.replace() }
        for (endpoint, generation) in connectionGenerations {
            if let key = brokerKey(endpoint) { RelayChannelBroker.shared.retire(key: key, id: generation) }
        }
        let activeConnections = Array(connections.values)
        connectionGenerations.removeAll()
        transcriptRouteGenerations.removeAll()
        relayPairingContexts.removeAll()
        connections.removeAll()
        parentByConnection.removeAll()
        connectedRoutes.removeAll()
        failedDirectRoutes.removeAll()
        terminalRootStates.removeAll()
        failedChildConnections.removeAll()
        for index in machines.indices {
            machines[index].status = .disconnected
            machines[index].sessionActivity.removeAll()
            machines[index].sessionConnectionIssue = nil
            machines[index].recoveryProgress = nil
        }
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
        recoveryCoordinator?.invalidate()
        defer { recoveryCoordinator?.trigger(newEpisode: true) }
        if let index = machineIndex(containing: endpoint) {
            guard machines[index].configurationIssue == nil else {
                latestOperationError = machines[index].configurationIssue
                return
            }
            let existing = machines[index]
            machines[index].recoveryRevision &+= 1
            guard let oldRoute = existing.routes.first(where: { $0.id == endpoint.id }) else { return }
            let expected = existing.durableMachinePublicKey.flatMap { try? RelayCrypto.unb64($0).base64EncodedString() }
                ?? oldRoute.expectedPublicKey
            guard endpoint.expectedPublicKey == nil || expected == nil || endpoint.expectedPublicKey == expected else {
                latestOperationError = "The scanned machine key differs from the saved pin. Forget the profile only if you intended to replace that machine."
                return
            }
            let replacement = endpoint.relayPin == nil ? MachineEndpoint(host: endpoint.host, port: endpoint.port,
                expectedFingerprint: oldRoute.expectedFingerprint ?? endpoint.expectedFingerprint,
                expectedPublicKey: expected ?? endpoint.expectedPublicKey,
                pairingNonce: endpoint.pairingNonce, pairingLabel: endpoint.pairingLabel) : endpoint.publicConfiguration
            // Re-pairing refreshes a rendezvous, preserving policy and trust.
            let preference = existing.connectionPreference
            setConnectionPreference(preference, for: oldRoute)
            let affected = parentByConnection.filter { $0.value.id == oldRoute.id }.map(\.key)
            let affectedSet = Set(affected)
            for answer in Array(pendingAnswers.values) where routeBySession[answer.key].map(affectedSet.contains) == true {
                finishAnswer(answer.id, outcome: "uncertain")
            }
            for (requestID, attempt) in Array(resumeAttemptsByRequest) where attempt.parent.id == oldRoute.id {
                finishResume(requestID: requestID, error: "The pairing connection changed. Check the session before resuming again.")
            }
            for route in affected {
                if let key = brokerKey(route), let generation = connectionGenerations[route] {
                    RelayChannelBroker.shared.retire(key: key, id: generation)
                }
                connectionGenerations[route] = nil; parentByConnection[route] = nil
                connectedRoutes.remove(route); failedDirectRoutes.remove(route); terminalRootStates[route] = nil
                if let connection = connections.removeValue(forKey: route) { Task { await connection.stop() } }
            }
            routeBySession = routeBySession.filter { !affectedSet.contains($0.value) }
            machines[index].replaceRoute(replacement)
            if let displayName { machines[index].displayName = displayName; machines[index].usesConfiguredDisplayName = true }
            if let secret = endpoint.relayPairingSecret {
                // Keep an enrolled route durable during a memory-only refresh.
                // A genuinely new pending route remains in pendingRelayIDs.
                relayPairingContexts[replacement] = (secret, endpoint.relayPairingExpiresAt)
                pushTrustIntents.insert(replacement)
            }
            startPermittedRoutes(machineIndex: index)
            return
        }
        let publicEndpoint = endpoint.publicConfiguration
        if let secret = endpoint.relayPairingSecret {
            pendingRelayIDs.insert(publicEndpoint.id)
            relayPairingContexts[publicEndpoint] = (secret, endpoint.relayPairingExpiresAt)
            pushTrustIntents.insert(publicEndpoint)
        }
        machines.append(MachineState(
            endpoint: publicEndpoint,
            displayName: displayName ?? endpoint.displayAddress,
            configuredDisplayName: displayName != nil
        ))
        publishPolicy(machineIndex: machines.count - 1)
        connect(publicEndpoint, parent: publicEndpoint)
    }

    public func pairingAttempt(id: UUID) -> PairingAttemptState? {
        pairingAttempts.first { $0.id == id }
    }

    public func cancelPairing(_ id: UUID) {
        guard pairingCoordinator?.id == id else { return }
        pairingCoordinator?.cancel()
    }

    struct PairingOrigin: Equatable {
        let lifetime: UUID
        let preference: MachineConnectionPreference
    }

    /// Select policy before any dial. Pins and endpoint ownership must agree across
    /// every hint; a QR never chooses between conflicting or ambiguous profiles.
    private func pairingOrigin(hints: [MachineEndpoint], key: Data, machineID: String) throws -> PairingOrigin? {
        let addresses = Set(hints.map(\.pairingAddressIdentity))
        let matches = machines.filter { machine in
            machine.durableMachineID == machineID
                || machine.durableMachinePublicKey == RelayCrypto.b64(key)
                || machine.routes.contains { route in
                    addresses.contains(route.pairingAddressIdentity)
                        || route.expectedPublicKey == key.base64EncodedString()
                        || route.relayPin?.machinePublicKey == RelayCrypto.b64(key)
                }
        }
        guard matches.count <= 1 else { throw PairingAdmissionError.refused("Several saved profiles match this pairing code. Resolve them before pairing.") }
        guard let machine = matches.first else { return nil }
        if let issue = machine.configurationIssue { throw PairingAdmissionError.refused(issue) }
        guard machine.durableMachineID == nil || machine.durableMachineID == machineID,
              machine.durableMachinePublicKey == nil || machine.durableMachinePublicKey == RelayCrypto.b64(key),
              machine.routes.allSatisfy({ route in
                  (route.expectedPublicKey == nil || route.expectedPublicKey == key.base64EncodedString())
                      && (route.expectedFingerprint == nil || route.expectedFingerprint == ClientIdentity.fingerprint(ofPublicKeyRaw: key))
                      && (route.relayPin == nil || route.relayPin?.machinePublicKey == RelayCrypto.b64(key))
              }) else {
            throw PairingAdmissionError.refused("The pairing key conflicts with the saved machine pin. Forget only if you intend to replace that machine.")
        }
        return PairingOrigin(lifetime: machine.pairingLifetime, preference: machine.connectionPreference)
    }

    private func publishPairing(_ state: PairingAttemptState) {
        pairingAttempts.removeAll { $0.id == state.id }
        pairingAttempts.append(state)
        while pairingAttempts.filter({ $0.phase.isTerminal }).count > 8 {
            if let index = pairingAttempts.firstIndex(where: { $0.phase.isTerminal }) { pairingAttempts.remove(at: index) }
        }
    }

    @discardableResult
    public func beginPairing(_ payload: PairingPayload, label: String,
                             newProfilePreference: MachineConnectionPreference = .automatic) -> UUID {
        recoveryCoordinator?.invalidate()
        let retirement = pairingCoordinator?.cancel()
        let id = UUID()
        pairingOriginLifetime = nil
        do {
            guard let key = Data(base64Encoded: payload.daemonPublicKey), key.count == 32,
                  key.base64EncodedString() == payload.daemonPublicKey,
                  ClientIdentity.fingerprint(ofPublicKeyRaw: key) == payload.daemonFingerprint else {
                throw PairingAdmissionError.refused("The pairing authority is invalid.")
            }
            let machineID = try MachineIdentityVerifier.machineID(forPublicKey: key)
            let endpoints = payload.candidateEndpoints(pairingLabel: label)
            let hints = endpoints.map(\.withoutPairingContext)
            let origin = try pairingOrigin(hints: hints, key: key, machineID: machineID)
            let preference = origin?.preference ?? newProfilePreference
            let candidates = preference.orderedRoutes(endpoints)
            guard !candidates.isEmpty else { throw PairingAdmissionError.refused("The pairing code has no address permitted by \(preference.title). Choose that layer explicitly before pairing.") }
            guard PairingPayload.isValidLabel(label), payload.expiresAt.addingTimeInterval(120) > Date() else {
                throw PairingAdmissionError.refused("The pairing code expired or the device label is invalid.")
            }
            pairingOriginLifetime = origin?.lifetime
            let validate: () throws -> Void = { [weak self] in
                guard let self, self.pairingCoordinator?.id == id,
                      try self.pairingOrigin(hints: hints, key: key, machineID: machineID) == origin else {
                    throw PairingAdmissionError.refused("The saved profile or connection layer changed. Start pairing again.")
                }
            }
            let coordinator = PairingAttemptCoordinator(id: id, candidates: candidates, authority: key,
                machineID: machineID, deadline: payload.expiresAt.addingTimeInterval(120), identity: identity,
                clientVersion: clientVersion, clientID: clientId, validate: validate,
                publish: { [weak self] in self?.publishPairing($0) },
                admit: { [weak self] connection, endpoint, hello, authority in
                    try validate()
                    guard let self else { throw RelayFailure.closed }
                    return self.admitPairing(connection, endpoint: endpoint, hints: hints, hello: hello,
                        authority: authority, origin: origin, preference: preference)
                }, forward: { [weak self] callback, adoption in
                    switch callback {
                    case .state(let state): self?.receive(state, from: adoption.endpoint, generation: adoption.generation)
                    case .event(let event): self?.receive(event, from: adoption.endpoint, generation: adoption.generation)
                    case .authenticationRetry: break
                    }
                })
            #if DEBUG
            coordinator.ownedBeforeAdmission = ownedBeforePairingAdmission
            #endif
            pairingCoordinator = coordinator
            publishPairing(.init(id: id, address: nil, layer: nil, phase: .connecting))
            coordinator.start(after: retirement)
        } catch {
            publishPairing(.init(id: id, address: nil, layer: nil, phase: .failed(reason: error.localizedDescription)))
        }
        if running { recoveryCoordinator?.trigger(newEpisode: true) }
        return id
    }

    func admitPairing(_ connection: RemiConnection, endpoint: MachineEndpoint, hints: [MachineEndpoint],
                              hello: HelloAckMessage, authority: Data, origin: PairingOrigin?,
                              preference: MachineConnectionPreference) -> PairingAdoption {
        let index: Int
        if let origin, let existing = machines.firstIndex(where: { $0.pairingLifetime == origin.lifetime }) {
            index = existing
            retireProfileConnections(machineIndex: index,
                reason: "The pairing connection changed. Check the session before resuming again.")
        } else {
            machines.append(MachineState(endpoint: endpoint, displayName: endpoint.displayAddress))
            index = machines.count - 1
            machines[index].connectionPreference = preference
        }
        let navigationID = machines[index].id
        for hint in hints {
            if machines[index].routes.contains(where: { $0.id == hint.id }) { machines[index].replaceRoute(hint) }
            else { machines[index].appendPairingHint(hint) }
        }
        machines[index].preserveNavigationID(navigationID)
        machines[index].bindAuthenticatedPublicKey(authority)
        machines[index].activate(endpoint)
        let generation = UUID()
        running = true
        connections[endpoint] = connection
        connectionGenerations[endpoint] = generation
        parentByConnection[endpoint] = endpoint
        let adoption = PairingAdoption(endpoint: endpoint, generation: generation, profileID: machines[index].id)
        receive(.hello(hello, authorityPublicKey: authority), from: endpoint, generation: generation)
        recovery().start()
        return adoption
    }

    public func renameMachine(_ endpoint: MachineEndpoint, to proposedName: String) {
        let name = proposedName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 80,
              let index = machines.firstIndex(where: { $0.endpoint == endpoint }) else { return }
        machines[index].displayName = name
        machines[index].usesConfiguredDisplayName = true
    }

    @discardableResult public func removeMachine(_ endpoint: MachineEndpoint) -> Bool {
        recoveryCoordinator?.invalidate()
        defer { if running { recoveryCoordinator?.trigger(newEpisode: true) } }
        registrationEpoch.replace(); answerEpoch.replace()
        let removedMachine = machines.first { $0.routingRoutes.contains(where: { $0.id == endpoint.id }) }
        if let removedMachine {
            notificationAttempts[removedMachine.id] = nil
            pairedNotificationStates[removedMachine.id] = nil
        }
        if removedMachine?.pairingLifetime == pairingOriginLifetime { pairingCoordinator?.cancel() }
        let configuredRoutes = removedMachine?.routingRoutes ?? [endpoint]
        for route in configuredRoutes {
            approvalPollTasks.removeValue(forKey: route)?.cancel()
            if let pin = route.relayPin, let room = try? RelayCrypto.room(RelayCrypto.unb64(pin.machinePublicKey)),
               verifiedRelayNotification?.machine.room == room { verifiedRelayNotification = nil }
            pushTrustIntents.remove(route)
            pendingRelayIDs.remove(route.id)
            relayPairingContexts.removeValue(forKey: route)
        }
        let answerIDs: [String] = pendingAnswers.compactMap { id, answer in
            let route = routeBySession[answer.key] ?? endpoint
            guard let parent = parentByConnection[route],
                  configuredRoutes.contains(where: { $0.id == parent.id }) else { return nil }
            return id
        }
        for id in answerIDs {
            pendingAnswers.removeValue(forKey: id)
            answerTimeoutTasks.removeValue(forKey: id)?.cancel()
        }
        let resumeRequestIDs = resumeAttemptsByRequest.compactMap { requestID, attempt in
            configuredRoutes.contains(where: { $0.id == attempt.parent.id }) ? requestID : nil
        }
        for requestID in resumeRequestIDs {
            finishResume(requestID: requestID, error: nil)
        }
        let machineIDs = Set(configuredRoutes.map(\.id) + [removedMachine?.machineID].compactMap { $0 })
        resumeErrorsBySession = resumeErrorsBySession.filter { !machineIDs.contains($0.key.machineID) }
        if let destination = resumedSessionDestination, machineIDs.contains(destination.machineID) {
            resumedSessionDestination = nil
        }
        let resolvedIDs = recentlyResolvedQuestions.filter { machineIDs.contains($0.machineID) }.map(\.id)
        recentlyResolvedQuestions.removeAll { machineIDs.contains($0.machineID) }
        for id in resolvedIDs {
            resolvedQuestionRemovalTasks.removeValue(forKey: id)?.cancel()
        }
        // Per-session tables are keyed by the machine profile id (`MachineState.id`), the same id
        // `sessionKey(machineID:sessionID:)` resolves to; the route and wire ids are covered too.
        let keyMachineIDs = machineIDs.union([removedMachine?.id].compactMap { $0 })
        let endpoints = parentByConnection.compactMap { connection, parent in
            configuredRoutes.contains(where: { $0.id == parent.id }) ? connection : nil
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
            failedChildConnections.remove(child)
        }
        // Callback/reconnect authority is invalidated before durable forget.
        if let pushStore {
            do {
                if let removedMachine {
                    for room in notificationRooms(for: removedMachine) { try pushStore.forgetMachine(room: room) }
                }
                for pin in configuredRoutes.compactMap(\.relayPin) {
                    try pushStore.forgetMachine(room: RelayCrypto.room(RelayCrypto.unb64(pin.machinePublicKey)))
                }
            } catch {
                latestOperationError = "The relay notification trust could not be removed. Try Forget again."
                if let index = machines.firstIndex(where: {
                    $0.routes.contains(where: { $0.id == endpoint.id })
                }) {
                    machines[index].status = .unavailable(reason: latestOperationError)
                }
                return false
            }
        }
        if let removedMachine, let id = removedMachine.policyMachineID {
            MachineConnectionPolicyFence.shared.remove(machineID: id, owner: removedMachine.policyOwner)
        }
        for route in configuredRoutes {
            connectedRoutes.remove(route); failedDirectRoutes.remove(route); terminalRootStates[route] = nil
        }
        machines.removeAll { state in state.routingRoutes.contains(where: { $0.id == endpoint.id }) }
        for route in configuredRoutes { pushEnabled.remove(route.id) }
        routeBySession = routeBySession.filter { _, route in !endpoints.contains(route) }
        sessionByKillRequest = sessionByKillRequest.filter { !keyMachineIDs.contains($0.value.machineID) }
        // Terminal text and partial file bytes go with the machine.
        terminalViews = terminalViews.filter { !keyMachineIDs.contains($0.key.machineID) }
        fileDownloads = fileDownloads.filter { !keyMachineIDs.contains($0.key.machineID) }
        transcriptsBySession = transcriptsBySession.filter { !keyMachineIDs.contains($0.key.machineID) }
        sessionViewsBySession = sessionViewsBySession.filter { !keyMachineIDs.contains($0.key.machineID) }
        for key in transcriptsLoading where keyMachineIDs.contains(key.machineID) { finishTranscriptLoad(key) }
        for machineID in machineIDs { recentRepositoriesByMachine[machineID] = nil }
        return true
    }

    /// Retries a machine that is waiting for local approval a few seconds apart, for a bounded
    /// window, so approving the key on the machine connects without another tap (#1599). The
    /// loop ends when the machine leaves the waiting state, is removed, or the window closes.
    private func startApprovalPolling(for endpoint: MachineEndpoint) {
        guard approvalPollTasks[endpoint] == nil else { return }
        let policy = approvalPollPolicy
        approvalPollTasks[endpoint] = Task { [weak self] in
            let start = ContinuousClock.now
            while !Task.isCancelled {
                try? await Task.sleep(for: policy.interval)
                guard !Task.isCancelled, let self else { return }
                guard self.isWaitingForApproval(endpoint),
                      policy.shouldContinue(elapsed: ContinuousClock.now - start)
                else {
                    self.approvalPollTasks[endpoint] = nil
                    return
                }
                self.retryApproval(for: endpoint)
            }
        }
    }

    private func isWaitingForApproval(_ endpoint: MachineEndpoint) -> Bool {
        guard let index = machineIndex(containing: endpoint) else { return false }
        if case .waitingForApproval = machines[index].status { return true }
        return false
    }

    public func retryApproval(for endpoint: MachineEndpoint) {
        guard let connection = connections[endpoint] else { return }
        Task { await connection.retryAfterApproval() }
    }

    public func retryConnection(for endpoint: MachineEndpoint) {
        guard let index = machineIndex(containing: endpoint) else { return }
        guard machines[index].configurationIssue == nil else { return }
        if machines[index].durableMachinePublicKey != nil {
            if connections[endpoint] != nil { retryFailedChildren(of: endpoint) }
            recoveryCoordinator?.invalidate()
            for route in machines[index].routingRoutes { terminalRootStates[route] = nil }
            recoveryRequestedLifetimes.insert(machines[index].pairingLifetime)
            recovery().start()
            recovery().trigger(newEpisode: true)
            return
        }
        terminalRootStates[endpoint] = nil
        guard let connection = connections[endpoint] else {
            failedDirectRoutes.subtract(machines[index].routes)
            machines[index].status = .connecting
            startPermittedRoutes(machineIndex: index)
            return
        }
        retryFailedChildren(of: endpoint)
        Task { await connection.retry() }
    }

    private func retryFailedChildren(of endpoint: MachineEndpoint) {
        // A healthy hub does not retry itself. Explicit Retry also replaces its
        // rejected session sockets, preserving their advertising machine pin.
        let children = failedChildConnections.filter { parentByConnection[$0]?.id == endpoint.id }
        for child in children {
            connectionGenerations[child] = nil
            parentByConnection[child] = nil
            failedChildConnections.remove(child)
            if let rejected = connections.removeValue(forKey: child) { Task { await rejected.stop() } }
            connect(child, parent: endpoint)
        }
        if !children.isEmpty, let index = machineIndex(containing: endpoint) {
            machines[index].sessionConnectionIssue = nil
            latestOperationError = nil
        }
    }

    /// Resolves either the stable authenticated ID or the legacy endpoint ID. This keeps
    /// persisted notification/navigation destinations usable across the descriptor transition.
    public func machine(withIdentifier identifier: String) -> MachineState? {
        machines.first { $0.id == identifier || $0.machineID == identifier }
    }

    /// What the person sees when no permitted route reaches the machine.
    nonisolated static func unreachableMessage(layer: String) -> String {
        "Remi could not reach this machine over \(layer). Check that it is running and on the network, or choose another way to connect in the machine's settings."
    }

    /// The hub sends CLOSING while it shuts down (a restart, an update).
    nonisolated static func isExpectedClosure(_ error: ErrorMessage) -> Bool { error.code == "CLOSING" }

    public func clearLatestError() {
        latestError = nil
        latestOperationError = nil
        latestOperationNotice = nil
        resumeErrorsBySession.removeAll()
    }

    public func clearRelayNotificationNotice() {
        relayNotificationNotice = nil
    }

    /// The store's key for a session: the machine profile id (a legacy endpoint id is
    /// resolved to it) with the session id.
    public func sessionKey(machineID: String, sessionID: String) -> MachineSessionKey {
        MachineSessionKey(machineID: machine(withIdentifier: machineID)?.id ?? machineID, sessionID: sessionID)
    }

    public func isLoadingTranscript(machineID: String, sessionID: String) -> Bool {
        transcriptsLoading.contains(sessionKey(machineID: machineID, sessionID: sessionID))
    }

    public func transcriptRouteGeneration(machineID: String, sessionID: String) -> UUID? {
        let key = sessionKey(machineID: machineID, sessionID: sessionID)
        guard let route = routeBySession[key], let current = connectionGenerations[route],
              transcriptRouteGenerations[key] == current else { return nil }
        return current
    }

    @discardableResult
    public func loadTranscript(machineID: String, sessionId: String) -> String? {
        let key = sessionKey(machineID: machineID, sessionID: sessionId)
        guard let connection = connection(for: key) else { return nil }
        let request = TranscriptLoadRequestMessage(
            id: UUID().uuidString.lowercased(),
            timestamp: Date().ISO8601Format(),
            sessionId: sessionId
        )
        transcriptsLoading.insert(key)
        if let previous = transcriptLoadTimers[key] { transcriptKeyByRequest[previous.requestID] = nil }
        transcriptLoadTimers[key]?.task.cancel()
        transcriptKeyByRequest[request.id] = key
        Task { [weak self] in
            do {
                #if DEBUG
                if let send = self?.ownedTranscriptSend { try await send(request); return }
                #endif
                try await connection.send(request)
            } catch { self?.finishTranscriptLoad(key, requestID: request.id) }
        }
        // The completion message is the normal end; this keeps a lost one from showing a spinner forever.
        let timeout = transcriptLoadTimeoutOverride ?? Self.transcriptLoadTimeout
        transcriptLoadTimers[key] = (request.id, Task { [weak self] in
            do { try await Task.sleep(for: timeout) } catch { return }
            self?.finishTranscriptLoad(key, requestID: request.id)
        })
        return request.id
    }

    /// Ends a load. With a request id, only the load that request started: a stale timer or
    /// failure from a replaced request must not end the newer one.
    private func finishTranscriptLoad(_ key: MachineSessionKey, requestID: String? = nil) {
        if let requestID, transcriptLoadTimers[key]?.requestID != requestID { return }
        transcriptLoadTimers.removeValue(forKey: key)?.task.cancel()
        transcriptKeyByRequest = transcriptKeyByRequest.filter { $0.value != key }
        transcriptsLoading.remove(key)
    }

    nonisolated static let transcriptLoadTimeout: Duration = .seconds(45)

    public func answer(
        machineID: String,
        sessionId: String,
        questionId: String,
        answer: String,
        claudeSessionId: String? = nil,
        selections: [AnswerSelection]? = nil,
        cancel: Bool? = nil,
        message: String? = nil
    ) {
        let key = sessionKey(machineID: machineID, sessionID: sessionId)
        guard let connection = connection(for: key) else { return }
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
        if let route = routeBySession[key], route.relayPin != nil {
            guard pendingAnswers.count < 64 else {
                latestOperationError = "Too many answers are awaiting confirmation. Wait before answering."
                return
            }
            guard !pendingAnswers.values.contains(where: { $0.key == key && $0.questionId == questionId }) else { return }
            pendingAnswers[response.id] = PendingAnswer(machineID: key.machineID, message: response)
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

    public func localQuestionNotification(for destination: RemiNavigationDestination) -> LocalQuestionNotificationPlan? {
        guard let machine = machine(withIdentifier: destination.machineID),
              machine.status == .connected, machine.endpoint.relayPin == nil,
              let route = routeBySession[sessionKey(machineID: machine.id, sessionID: destination.sessionID)], route.relayPin == nil,
              parentByConnection[route] == machine.endpoint,
              let generation = connectionGenerations[route],
              let current = machine.questions.first(where: {
                  $0.sessionId == destination.sessionID && $0.question.id == destination.questionID &&
                      $0.question.agentId == destination.agentID
              }) else { return nil }
        return LocalQuestionNotificationPlan(machineID: machine.id, message: current, generation: generation)
    }

    public func answerLocalNotification(_ plan: LocalQuestionNotificationPlan,
                                        identifier: String) async -> LocalNotificationAnswerOutcome {
        let destination = plan.destination
        guard !Task.isCancelled,
              let machine = machine(withIdentifier: destination.machineID),
              machine.status == .connected, machine.endpoint.relayPin == nil,
              let route = routeBySession[sessionKey(machineID: machine.id, sessionID: destination.sessionID)], route.relayPin == nil,
              parentByConnection[route] == machine.endpoint,
              let generation = connectionGenerations[route], let connection = connections[route],
              let current = machine.questions.first(where: {
                  $0.sessionId == destination.sessionID && $0.question.id == destination.questionID
              }), let value = plan.answerValue(identifier: identifier, current: current,
                    machineID: machine.id, generation: generation) else { return .refused }
        guard localNotificationAnswers.count < 8, !localNotificationAnswers.contains(destination) else { return .busy }
        localNotificationAnswers.insert(destination)
        defer { localNotificationAnswers.remove(destination) }
        let response = AnswerMessage(id: UUID().uuidString.lowercased(), timestamp: Date().ISO8601Format(),
            sessionId: current.sessionId, questionId: current.question.id, answer: value,
            claudeSessionId: current.claudeSessionId, selections: nil, cancel: nil, message: nil)
        let permit = RelayRegistrationEpoch(), allowed = permit.capture()
        let lifetimeStore = answerEpoch, lifetime = answerEpoch.capture()
        let validate: @Sendable () throws -> Void = {
            guard permit.matches(allowed), lifetimeStore.matches(lifetime), !Task.isCancelled else {
                throw CancellationError()
            }
        }
        return await withTaskCancellationHandler {
            var attempted = false
            do {
                try Task.checkCancellation()
                #if DEBUG
                try await ownedBeforeLocalAnswerSend?()
                #endif
                try validate()
                attempted = true
                let result = try await connection.exchange(response, id: response.id,
                    expected: .answer(session: response.sessionId, question: response.questionId),
                    until: ContinuousClock.now.advanced(by: .seconds(15)), validate: validate)
                guard case .answer(let receipt) = result else { return .uncertain }
                switch receipt.outcome {
                case "delivered": return .delivered
                case "stale", "stale-binding", "session-not-found": return .stale
                case "busy": return .busy
                default: return .uncertain
                }
            } catch { return attempted ? .uncertain : .refused }
        } onCancel: { permit.replace() }
    }

    @discardableResult
    public func sendChat(machineID: String, sessionId: String, content: String, claudeSessionId: String? = nil) async -> Bool {
        guard let connection = connection(for: sessionKey(machineID: machineID, sessionID: sessionId)) else {
            latestOperationError = "Cannot send message: this session is unavailable."
            return false
        }
        let message = UserInputMessage(
            id: UUID().uuidString.lowercased(),
            timestamp: Date().ISO8601Format(),
            sessionId: sessionId,
            content: content,
            claudeSessionId: claudeSessionId
        )
        do {
            try await connection.send(message)
            return true
        } catch {
            latestOperationError = "Message not sent. Check the connection and try again."
            return false
        }
    }

    public func terminateSession(machineID: String, sessionId: String) {
        guard let connection = connection(for: sessionKey(machineID: machineID, sessionID: sessionId)) else {
            latestOperationError = "Cannot exit session: its daemon is unavailable."
            return
        }
        let request = KillSessionRequestMessage(
            id: UUID().uuidString.lowercased(),
            timestamp: Date().ISO8601Format(),
            sessionId: sessionId
        )
        sessionByKillRequest[request.id] = sessionKey(machineID: machineID, sessionID: sessionId)
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
            let machineID = machine(withIdentifier: endpoint.id)?.id ?? endpoint.id
            resumeErrorsBySession[ResumeSessionKey(machineID: machineID, sessionID: sessionId)] = reason
            return
        }
        guard let connection = connections[endpoint] else {
            latestOperationError = "Cannot resume session: its machine is unavailable."
            return
        }
        let key = ResumeSessionKey(machineID: machine(withIdentifier: endpoint.id)?.id ?? endpoint.id,
            sessionID: sessionId)
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
        guard running, let index = machineIndex(containing: parent),
              machines[index].configurationIssue == nil,
              machines[index].connectionPreference.permits(parent),
              connections[endpoint] == nil, let url = endpoint.webSocketURL else { return }
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
                expectedMachineID: machineIndex(containing: parent)
                    .flatMap { machines[$0].durableMachineID },
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

    private func machineIndex(containing route: MachineEndpoint) -> Int? {
        machines.firstIndex { $0.routingRoutes.contains(where: { $0.id == route.id }) }
    }

    private func publishPolicy(machineIndex index: Int) {
        guard machines[index].configurationIssue == nil, let id = machines[index].policyMachineID else { return }
        MachineConnectionPolicyFence.shared.publish(machines[index].connectionPreference,
            machineID: id, owner: machines[index].policyOwner)
    }

    /// Grouping is reached only after RemiConnection has verified the descriptor
    /// against this route's authenticated key (#1531). Names and addresses never enter it.
    @discardableResult
    private func consolidateRoute(_ endpoint: MachineEndpoint, parent: MachineEndpoint,
                                  descriptor: MachineDescriptor, fallbackIndex: Int) -> Int {
        guard let other = machines.firstIndex(where: {
            $0.durableMachineID == descriptor.id && !$0.routes.contains(where: { $0.id == endpoint.id })
        }), other != fallbackIndex else { return fallbackIndex }

        var target = machines[other]
        let source = machines[fallbackIndex]
        target.policyOwner = max(target.policyOwner, source.policyOwner)
        for route in source.routes { target.addRoute(route) }
        if target.connectionPreference == .automatic { target.connectionPreference = source.connectionPreference }
        if target.durableMachinePublicKey == nil, let encoded = source.durableMachinePublicKey,
           let key = try? RelayCrypto.unb64(encoded) { target.bindAuthenticatedPublicKey(key) }
        if !target.usesConfiguredDisplayName && source.usesConfiguredDisplayName {
            target.displayName = source.displayName
            target.usesConfiguredDisplayName = true
        }
        target.sessions = mergeSessions(target.sessions, with: source.sessions)
        target.sessionActivity.merge(source.sessionActivity) { current, _ in current }
        for question in source.questions where !target.questions.contains(where: { $0.question.id == question.question.id }) {
            target.questions.append(question)
        }
        if endpoint == parent, target.connectionPreference.permits(endpoint),
           (!target.connectionPreference.permits(target.endpoint) || endpoint.connectionLayer <= target.endpoint.connectionLayer) {
            target.activate(endpoint)
        }
        machines[other] = target
        let removed = fallbackIndex
        machines.remove(at: removed)
        let finalIndex = other > removed ? other - 1 : other
        // #1561: both profiles' routes are retained. Keep each socket's actual
        // owning route so child discovery and dispatch follow that transport.
        return finalIndex
    }

    private func retireDisallowedRoutes(machineIndex: Int) {
        let forbidden = Set(machines[machineIndex].routingRoutes.filter {
            !machines[machineIndex].connectionPreference.permits($0)
        })
        for route in parentByConnection.filter({ forbidden.contains($0.value) }).map(\.key) {
            machines[machineIndex].sessionActivity = machines[machineIndex].sessionActivity.filter { $0.value.origin != route }
            if let key = brokerKey(route), let generation = connectionGenerations[route] {
                RelayChannelBroker.shared.retire(key: key, id: generation)
            }
            connectedRoutes.remove(route)
            connectionGenerations[route] = nil
            parentByConnection[route] = nil
            if let connection = connections.removeValue(forKey: route) { Task { await connection.stop() } }
        }
    }

    private func routeDidConnect(_ endpoint: MachineEndpoint, machineIndex: Int) {
        connectedRoutes.insert(endpoint)
        terminalRootStates[endpoint] = nil
        failedDirectRoutes.remove(endpoint)
        let permitted = machines[machineIndex].connectionPreference.orderedRoutes(machines[machineIndex].routingRoutes)
        guard let first = permitted.first(where: { connectedRoutes.contains($0) }) else { return }
        let current = machines[machineIndex].endpoint
        let selected = connectedRoutes.contains(current) && current.connectionLayer == first.connectionLayer
            ? current : first
        machines[machineIndex].activate(selected)
        guard selected.relayPin == nil else { return }
        // Once direct is authenticated, retire the relay generation before closing it;
        // late relay events therefore cannot duplicate state or operations.
        for relay in machines[machineIndex].routes where relay.relayPin != nil {
            connectedRoutes.remove(relay)
            guard let connection = connections.removeValue(forKey: relay) else { continue }
            if let key = brokerKey(relay), let generation = connectionGenerations[relay] {
                RelayChannelBroker.shared.retire(key: key, id: generation)
            }
            connectionGenerations[relay] = nil
            parentByConnection[relay] = nil
            Task { await connection.stop() }
        }
    }

    private func directRouteBecameUnreachable(_ endpoint: MachineEndpoint, machineIndex: Int) {
        guard endpoint.relayPin == nil else { return }
        connectedRoutes.remove(endpoint)
        failedDirectRoutes.insert(endpoint)
        if machines[machineIndex].durableMachinePublicKey != nil {
            // A configured authentication/approval stop survives later socket
            // failures. Discovery cannot reinterpret it as permission to fall back.
            if let terminal = recoveryTerminalRoot(for: machines[machineIndex]),
               exposeTerminalState(terminal, machineIndex: machineIndex) { return }
            recoveryRequestedLifetimes.insert(machines[machineIndex].pairingLifetime)
            if machines[machineIndex].status != .connected || machines[machineIndex].endpoint.id == endpoint.id {
                retireProfileConnections(machineIndex: machineIndex,
                    reason: "The connection was lost. Delivery may be uncertain; check the session before trying again.")
                machines[machineIndex].status = .unavailable(reason: "The saved route is unreachable. Checking permitted routes.")
            }
            recovery().start(); recovery().trigger(newEpisode: false)
            return
        }
        let permitted = machines[machineIndex].connectionPreference.orderedRoutes(machines[machineIndex].routes)
        if let connected = permitted.first(where: { connectedRoutes.contains($0) }) {
            machines[machineIndex].activate(connected)
            machines[machineIndex].status = .connected
            return
        }
        if let next = permitted.first(where: { $0.relayPin == nil && !failedDirectRoutes.contains($0) }) {
            machines[machineIndex].activate(next)
            if exposeTerminalState(next, machineIndex: machineIndex) { return }
            machines[machineIndex].status = .connecting
            connect(next, parent: next)
            return
        }
        guard let relay = permitted.first(where: { $0.relayPin != nil }) else {
            let layer = machines[machineIndex].connectionPreference.title
            machines[machineIndex].status = .unavailable(reason: Self.unreachableMessage(layer: layer))
            return
        }
        machines[machineIndex].activate(relay)
        if exposeTerminalState(relay, machineIndex: machineIndex) { return }
        machines[machineIndex].status = .connecting
        connect(relay, parent: relay)
    }

    private func exposeTerminalState(_ endpoint: MachineEndpoint, machineIndex: Int) -> Bool {
        switch terminalRootStates[endpoint] {
        case .rejected(let reason): failClosed(endpoint, machineIndex: machineIndex, reason: reason)
        case .awaitingLocalApproval(let fingerprint): machines[machineIndex].status = .waitingForApproval(fingerprint: fingerprint)
        case .awaitingRelayConfirmation(let fingerprint): machines[machineIndex].status = .waitingForRelayConfirmation(fingerprint: fingerprint)
        default: return false
        }
        return true
    }

    private func failClosed(_ endpoint: MachineEndpoint, machineIndex: Int, reason: String) {
        machines[machineIndex].status = .unavailable(reason: reason)
        machines[machineIndex].sessionActivity.removeAll()
        let roots = Set(machines[machineIndex].routingRoutes)
        for route in parentByConnection.filter({ roots.contains($0.value) }).map(\.key) {
            if let key = brokerKey(route), let generation = connectionGenerations[route] {
                RelayChannelBroker.shared.retire(key: key, id: generation)
            }
            connectedRoutes.remove(route)
            if let connection = connections.removeValue(forKey: route) { Task { await connection.stop() } }
            connectionGenerations[route] = nil
            parentByConnection[route] = nil
        }
    }

    func receive(_ state: RemiConnectionState, from endpoint: MachineEndpoint, generation: UUID) {
        guard connectionGenerations[endpoint] == generation, let parent = parentByConnection[endpoint],
              let index = machineIndex(containing: parent)
        else { return }
        if case .connected = state {} else { panesConnectionLost(endpoint) }
        if case .connected = state {} else {
            machines[index].sessionActivity = machines[index].sessionActivity.filter { $0.value.origin != endpoint }
            transcriptRouteGenerations = transcriptRouteGenerations.filter { routeBySession[$0.key] != endpoint }
            // A lost child does not disconnect its hub. Apply the same conservative idle
            // display as a lost machine, instead of reviving a stale "active" list entry.
            if endpoint.id != parent.id {
                for session in machines[index].activeSessions where
                    routeBySession[MachineSessionKey(machineID: machines[index].id, sessionID: session.sessionId)] == endpoint {
                    machines[index].sessionActivity[session.sessionId] = .init(status: "idle", origin: endpoint)
                }
            }
        }

        // Session sockets do not describe the machine route's reachability, but
        // terminal failures still need an explicit retry path (#1561).
        if endpoint.id != parent.id {
            guard machines[index].endpoint.id == parent.id else { return }
            let issue: String
            switch state {
            case .rejected(let reason):
                issue = "A session connection failed: \(reason) Use Retry connection in machine settings."
            case .awaitingLocalApproval(let fingerprint):
                issue = "A session daemon needs local approval for device \(fingerprint). Authorize it on the machine, then use Retry connection in machine settings."
            case .connected:
                failedChildConnections.remove(endpoint)
                if !failedChildConnections.contains(where: { parentByConnection[$0]?.id == parent.id }) {
                    machines[index].sessionConnectionIssue = nil
                }
                return
            default: return
            }
            failedChildConnections.insert(endpoint)
            machines[index].sessionConnectionIssue = issue
            latestOperationError = issue
            return
        }
        switch state {
        case .rejected, .awaitingLocalApproval, .awaitingRelayConfirmation:
            connectedRoutes.remove(endpoint)
            terminalRootStates[endpoint] = state
            machines[index].recoveryProgress = nil
            recoveryRequestedLifetimes.remove(machines[index].pairingLifetime)
            recoveryCoordinator?.configuredRootStopped(profileID: machines[index].id)
        default: break
        }
        if machines[index].endpoint.id != endpoint.id {
            switch state {
            case .connected, .reachabilityFailed: break
            default: return
            }
        }

        switch state {
        case .stopped:
            machines[index].status = .disconnected
        case .connecting, .authenticating, .retrying:
            if machines[index].recoveryProgress?.phase == .recovered { machines[index].recoveryProgress = nil }
            if machines[index].endpoint == endpoint {
                if case .unavailable = machines[index].status { break }
                // A quiet approval retry must not flash the row between waiting and connecting.
                var quietApprovalRetry = false
                if approvalPollTasks[endpoint] != nil, case .waitingForApproval = machines[index].status {
                    quietApprovalRetry = true
                }
                if !quietApprovalRetry { machines[index].status = .connecting }
            }
            if case .retrying = state, machines[index].durableMachinePublicKey != nil {
                recoveryRequestedLifetimes.insert(machines[index].pairingLifetime)
                recovery().start(); recovery().trigger(newEpisode: false)
            }
        case .connected:
            routeDidConnect(endpoint, machineIndex: index)
            machines[index].status = .connected
            if !machines[index].needsRouteRecovery { machines[index].recoveryProgress = nil }
        case .awaitingLocalApproval(let fingerprint):
            machines[index].status = .waitingForApproval(fingerprint: fingerprint)
            startApprovalPolling(for: endpoint)
        case .awaitingRelayConfirmation(let fingerprint):
            machines[index].status = .waitingForRelayConfirmation(fingerprint: fingerprint)
        case .rejected(let reason):
            failClosed(endpoint, machineIndex: index, reason: reason)
        case .reachabilityFailed:
            directRouteBecameUnreachable(endpoint, machineIndex: index)
        }
    }

    func receive(_ event: RemiInboundEvent, from endpoint: MachineEndpoint, generation: UUID) {
        guard connectionGenerations[endpoint] == generation, let parent = parentByConnection[endpoint],
              let initialIndex = machineIndex(containing: parent)
        else { return }

        var index = initialIndex

        if machines[index].machineDescriptor != nil,
           machines[index].endpoint.id != parent.id {
            switch event {
            case .hello, .sessions:
                break
            default:
                return
            }
        }

        switch event {
        case .sessionUpdate(let message):
            machines[index].sessionActivity[message.session.id] = .init(status: message.session.status, origin: endpoint)
        case .remiStatus(let message):
            machines[index].sessionActivity[message.sessionId] = .init(status: message.status.sessionStatus, origin: endpoint)
        case .terminalView(let message):
            receiveTerminalView(message, from: endpoint, machineIndex: index)
        case .fileFetch(let message):
            receiveFileFetch(message, from: endpoint, machineIndex: index)
        case .relayStreamEnded(let clean):
            if !clean { latestOperationError = "The relay closed without an authenticated ending. Check the session for uncertain delivery." }
        case .relayReady:
            pendingRelayIDs.remove(parent.id)
            if pushEnabled.contains(endpoint.id) { Task { await registerRelayToken(on: endpoint, generation: generation) } }
        case .answerResult(let result):
            guard let pending = pendingAnswers[result.requestId],
                  routeBySession[pending.key] == endpoint,
                  pending.sessionId == result.sessionId, pending.questionId == result.questionId else { return }
            finishAnswer(result.requestId, outcome: result.outcome)
        case .hello(let acknowledgment, let authority):
            if endpoint == parent { connectedRoutes.insert(endpoint) }
            if let descriptor = acknowledgment.machine {
                index = consolidateRoute(endpoint, parent: parent, descriptor: descriptor, fallbackIndex: index)
                machines[index].apply(descriptor)
            }
            if let authority { machines[index].bindAuthenticatedPublicKey(authority) }
            publishPolicy(machineIndex: index)
            retireDisallowedRoutes(machineIndex: index)
            guard machines[index].connectionPreference.permits(parent) else { return }
            if endpoint == parent {
                routeDidConnect(endpoint, machineIndex: index)
                machines[index].status = .connected
                }
            if endpoint == parent && machines[index].endpoint.id == endpoint.id {
                machines[index].capabilities = acknowledgment.capabilities ?? []
                machines[index].helloAck = HubSupportAck(acknowledgment)
                machines[index].harnesses = acknowledgment.harnesses ?? ["claude"]
                if machines[index].capabilities.contains("workspaces") {
                    requestRecentRepositories(from: endpoint)
                }
            }
            if let requestID = resumeRequestByChild.removeValue(forKey: endpoint),
               let attempt = resumeAttemptsByRequest[requestID] {
                let sessionID = attempt.resolvedSessionID ?? acknowledgment.sessionId
                    ?? attempt.requestedSessionID
                routeBySession[MachineSessionKey(machineID: machines[index].id, sessionID: sessionID)] = endpoint
                completeResume(requestID: requestID, sessionID: sessionID)
            }
            requestSessions(from: endpoint)
        case .sessions(let response):
            #if DEBUG
            if ownedSessionListReceipts.count < 128 { ownedSessionListReceipts.insert(response.requestId) }
            #endif
            if let descriptor = response.machine {
                index = consolidateRoute(endpoint, parent: parent, descriptor: descriptor, fallbackIndex: index)
                machines[index].apply(descriptor)
            }
            publishPolicy(machineIndex: index)
            retireDisallowedRoutes(machineIndex: index)
            guard machines[index].connectionPreference.permits(parent) else { return }
            let activeOrigin = machines[index].endpoint.id == parent.id
            if activeOrigin {
                for session in response.sessions {
                    let key = MachineSessionKey(machineID: machines[index].id, sessionID: session.sessionId)
                    // Siblings list the same on-disk transcripts. Keep a ready reader so
                    // an unrelated census cannot retrigger the selected history task.
                    if session.source != "daemon", let owner = routeBySession[key],
                       let ready = transcriptRouteGenerations[key], connectionGenerations[owner] == ready {
                        continue
                    }
                    routeBySession[key] = endpoint
                    transcriptRouteGenerations[key] = generation
                }
            }
            machines[index].sessions = mergeSessions(
                machines[index].sessions,
                with: response.sessions
            )
            if endpoint == parent && activeOrigin {
                machines[index].hasLoadedSessions = true
            }
            if activeOrigin {
                for port in response.daemonPorts ?? [] where port != parent.port && parent.relayPin == nil {
                    connect(MachineEndpoint(host: parent.host, port: port), parent: parent)
                }
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
            routeBySession[MachineSessionKey(machineID: machines[index].id, sessionID: message.sessionId)] = endpoint
            machines[index].questions.removeAll { $0.question.id == message.question.id }
            machines[index].questions.append(message)
            let resolvedID = Self.resolvedQuestionID(
                machineID: machines[index].id,
                sessionID: message.sessionId,
                questionID: message.question.id
            )
            recentlyResolvedQuestions.removeAll { $0.id == resolvedID }
            resolvedQuestionRemovalTasks.removeValue(forKey: resolvedID)?.cancel()
        case .questionResolved(let message):
            resolveQuestion(message, machineIndex: index, machineID: machines[index].id)
        case .questionSnapshot(let snapshot):
            machines[index] = Self.reconcilingQuestionSnapshot(
                in: machines[index],
                sessionId: snapshot.sessionId,
                liveQuestionIDs: Set(snapshot.questionIds)
            )
        case .transcript(let message):
            let key = MachineSessionKey(machineID: machines[index].id, sessionID: message.sessionId)
            var transcript = transcriptsBySession[key, default: []]
            transcript.removeAll { $0.entryUuid == message.entryUuid }
            transcript.append(message)
            transcriptsBySession[key] = transcript
        case .sessionViews(let message):
            sessionViewsBySession[MachineSessionKey(machineID: machines[index].id, sessionID: message.sessionId)] = message.subagents.sorted {
                if $0.active != $1.active { return $0.active && !$1.active }
                return $0.agentType.localizedCaseInsensitiveCompare($1.agentType) == .orderedAscending
            }
            for subagent in message.subagents {
                let key = MachineSessionKey(machineID: machines[index].id, sessionID: subagent.agentId)
                routeBySession[key] = endpoint
                transcriptRouteGenerations[key] = generation
            }
        case .recentRepositories(let response):
            guard endpoint == parent else { return }
            recentRepositoriesByMachine[machines[index].id] = response.repositories
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
            guard let killedKey = sessionByKillRequest.removeValue(forKey: response.requestId) else {
                return
            }
            if response.success {
                let sessionId = killedKey.sessionID
                machines[index].sessions.removeAll { $0.sessionId == sessionId }
                machines[index].sessionActivity[sessionId] = nil
                machines[index].questions.removeAll { $0.sessionId == sessionId }
                transcriptsBySession[killedKey] = nil
                transcriptRouteGenerations[killedKey] = nil
                sessionViewsBySession[killedKey] = nil
                routeBySession[killedKey] = nil
                terminalViews[killedKey] = nil
                fileDownloads[killedKey] = nil
                requestSessions(from: parent)
            } else {
                latestOperationError = "Could not exit session: \(response.error ?? "Unknown daemon error")"
            }
        case .error(let error):
            // A hub announcing that it is closing is expected, not an error: the machine's own
            // offline row says what the person needs to know (#1603).
            if !Self.isExpectedClosure(error) { latestError = error }
            finishTranscriptLoadFailed(by: error, machineID: machines[index].id)
            if error.code == "AUTH_REQUIRED" {
                let requestIDs = resumeAttemptsByRequest.compactMap { requestID, attempt in
                    attempt.parent == endpoint ? requestID : nil
                }
                for requestID in requestIDs {
                    finishResume(requestID: requestID, error: error.message)
                }
            }
        case .transcriptComplete(let complete):
            finishTranscriptLoad(MachineSessionKey(machineID: machines[index].id, sessionID: complete.sessionId))
        case .unsupported, .pushRegistration:
            break
        }
    }

    /// An error that names a transcript request (`details.requestId`, as the relay's delivery
    /// errors do) or a session (`details.sessionId`) ends that load, so a refused request does
    /// not leave a spinner until the timeout. No other wire field is read.
    private func finishTranscriptLoadFailed(by error: ErrorMessage, machineID: String) {
        if case .string(let requestID)? = error.details?["requestId"],
           let key = transcriptKeyByRequest[requestID], key.machineID == machineID {
            finishTranscriptLoad(key, requestID: requestID)
        }
        if case .string(let sessionID)? = error.details?["sessionId"] {
            finishTranscriptLoad(MachineSessionKey(machineID: machineID, sessionID: sessionID))
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
            let machineID = machine(withIdentifier: parent.id)?.id ?? parent.id
            routeBySession[MachineSessionKey(machineID: machineID, sessionID: sessionID)] = endpoint
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
            machineID: machine(withIdentifier: attempt.parent.id)?.id ?? attempt.parent.id,
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
            machineID: machine(withIdentifier: attempt.parent.id)?.id ?? attempt.parent.id,
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

    @discardableResult private func requestSessions(from endpoint: MachineEndpoint) -> String? {
        guard let connection = connections[endpoint] else { return nil }
        let request = SessionListRequestMessage(
            id: UUID().uuidString.lowercased(),
            timestamp: Date().ISO8601Format(),
            includeExternal: true
        )
        Task { try? await connection.send(request) }
        return request.id
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

    /// The connection that holds this session on this machine. There is deliberately no
    /// session-id-only lookup: two machines can hold the same id (#1601).
    func connection(for key: MachineSessionKey) -> RemiConnection? {
        routeBySession[key].flatMap { connections[$0] }
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

/// An answer awaiting its receipt, with the machine it was sent to.
private struct PendingAnswer {
    let machineID: String
    let message: AnswerMessage
    var id: String { message.id }
    var sessionId: String { message.sessionId }
    var questionId: String { message.questionId }
    var key: MachineSessionKey { MachineSessionKey(machineID: machineID, sessionID: message.sessionId) }
}

private struct ResumeAttempt {
    let parent: MachineEndpoint
    let requestedSessionID: String
    var resolvedSessionID: String?
}
