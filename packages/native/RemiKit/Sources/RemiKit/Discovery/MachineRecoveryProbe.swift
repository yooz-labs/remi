import Foundation

struct MachineRecoveryTarget: Sendable, Equatable {
    let profile: MachineRouteProfile
    let lifetime: UUID
    let revision: UInt64
    let key: Data
    let machineID: String
    let healthyLayer: MachineConnectionLayer?
    var id: String { profile.navigationID ?? profile.id }
    var local: LocalDiscoveryTarget? { LocalDiscoveryTarget(profile: profile, lifetime: lifetime, policyRevision: revision) }

    init?(profile: MachineRouteProfile, lifetime: UUID, revision: UInt64, healthyLayer: MachineConnectionLayer?) {
        guard let identity = try? profile.verifiedSavedIdentity() else { return nil }
        self.profile = profile; self.lifetime = lifetime; self.revision = revision
        key = identity.key; machineID = identity.machineID; self.healthyLayer = healthyLayer
    }

    func permits(_ endpoint: MachineEndpoint) -> Bool {
        profile.connectionPreference.permits(endpoint)
            && (healthyLayer.map { endpoint.connectionLayer < $0 } ?? true)
    }

    func pinned(_ route: MachineEndpoint) -> MachineEndpoint {
        guard route.relayPin == nil else { return route }
        return MachineEndpoint(host: route.host, port: route.port,
            expectedFingerprint: ClientIdentity.fingerprint(ofPublicKeyRaw: key), expectedPublicKey: key.base64EncodedString())
    }
}

enum MachineRecoveryProbeOutcome {
    case promoted, unreachable, cancelled
    case refused(String)
}

/// A terminal callback can arrive while the MainActor awaits transport
/// admission. Revoke candidate promotion synchronously at that producer edge.
private final class RecoveryAdmissionFence: @unchecked Sendable {
    private let lock = NSLock()
    private var valid = true
    func observe(_ callback: PairingCallbackBridge.Callback) {
        switch callback {
        case .state(.rejected), .state(.stopped), .state(.reachabilityFailed), .state(.retrying),
             .state(.awaitingLocalApproval), .state(.awaitingRelayConfirmation), .event(.relayStreamEnded):
            lock.lock(); valid = false; lock.unlock()
        default: break
        }
    }
    func commit<T>(_ body: () throws -> T) rethrows -> T? {
        lock.lock(); defer { lock.unlock() }
        guard valid else { return nil }
        return try body()
    }
}

@MainActor private final class RecoveryAdoptedRoute { var value: PairingAdoption? }

/// A single quarantined connection. Its ordered callback owner survives adoption
/// and forwards only through the adopted generation, just like initial pairing.
@MainActor
final class MachineRecoveryProbe {
    let id = UUID()
    let target: MachineRecoveryTarget
    let endpoint: MachineEndpoint
    let discovered: Bool
    let candidateID: String?
    private let bridge = PairingCallbackBridge()
    private let admissionFence = RecoveryAdmissionFence()
    private let adoptedRoute = RecoveryAdoptedRoute()
    private let identity: ClientIdentity
    private let clientVersion: String
    private let clientID: String
    private let validate: () throws -> Void
    private let admit: (RemiConnection, UUID, HelloAckMessage, Data) throws -> PairingAdoption
    private let forward: (PairingCallbackBridge.Callback, PairingAdoption) -> Void
    private let resume: @MainActor @Sendable (PairingAdoption) -> Void
    private let completion: (MachineRecoveryProbeOutcome) -> Void
    private var connection: RemiConnection?
    private var active = true
    private var adoption: PairingAdoption?
    private var completed = false
    private var worker: Task<Void, Never>?
    private var launch: Task<Void, Never>?
    private var retirement: Task<Void, Never>?
    private var brokerKey: String?
    #if DEBUG
    var ownedBeforeAdmission: (@MainActor () async -> Void)?
    #endif

    init(target: MachineRecoveryTarget, endpoint: MachineEndpoint, discovered: Bool, candidateID: String?,
         identity: ClientIdentity, clientVersion: String, clientID: String,
         validate: @escaping () throws -> Void,
         admit: @escaping (RemiConnection, UUID, HelloAckMessage, Data) throws -> PairingAdoption,
         forward: @escaping (PairingCallbackBridge.Callback, PairingAdoption) -> Void,
         resume: @escaping @MainActor @Sendable (PairingAdoption) -> Void,
         completion: @escaping (MachineRecoveryProbeOutcome) -> Void) {
        self.target = target; self.endpoint = endpoint; self.discovered = discovered; self.candidateID = candidateID
        self.identity = identity; self.clientVersion = clientVersion; self.clientID = clientID
        self.validate = validate; self.admit = admit; self.forward = forward; self.resume = resume; self.completion = completion
    }

    func start() { worker = Task { await run() } }

    @discardableResult func cancel() -> Task<Void, Never> {
        guard adoption == nil else { return Task {} }
        active = false; bridge.invalidate()
        return retire()
    }

    private func retire() -> Task<Void, Never> {
        if let retirement { return retirement }
        if let brokerKey { RelayChannelBroker.shared.retire(key: brokerKey, id: id) }
        let connection = connection, launch = launch
        let task = Task { await launch?.value; await connection?.stop() }
        retirement = task
        return task
    }

    private func check() throws {
        guard active, !Task.isCancelled else { throw CancellationError() }
        try validate()
    }

    private func finish(_ outcome: MachineRecoveryProbeOutcome) {
        guard !completed else { return }
        completed = true; completion(outcome)
    }

    private func run() async {
        var result: MachineRecoveryProbeOutcome = .cancelled
        do {
            try check()
            guard let url = endpoint.webSocketURL else { throw PairingAdmissionError.refused("The recovery address is invalid.") }
            let connection = RemiConnection(configuration: .init(url: url, clientVersion: clientVersion,
                clientId: clientID, deviceId: clientID, expectedServerFingerprint: endpoint.expectedFingerprint,
                expectedServerPublicKey: target.key.base64EncodedString(), expectedMachineID: target.machineID,
                relayPin: endpoint.relayPin, directRetryPolicy: .recoveryProbe), identity: identity,
                stateHandler: { [bridge, admissionFence] in
                    admissionFence.observe(.state($0)); bridge.yield(.state($0))
                }, eventHandler: { [bridge, admissionFence] in
                    admissionFence.observe(.event($0)); bridge.yield(.event($0))
                })
            self.connection = connection
            if let pin = endpoint.relayPin {
                let key = RelayChannelBroker.key(device: identity.publicKeyRaw, room: RelayCrypto.room(try RelayCrypto.unb64(pin.machinePublicKey)))
                brokerKey = key
                guard let launch = RelayChannelBroker.shared.adopt(key: key, id: id, connection: connection,
                    current: { [weak self] in await self?.isCurrent() == true },
                    // A notification can retire this owner. It may not resume a
                    // probe outside the recovery epoch or refund its start.
                    resume: { [weak self, adoptedRoute, resume] in
                        await MainActor.run {
                            if let adoption = adoptedRoute.value { resume(adoption) }
                            else { self?.brokerRetired() }
                        }
                    }) else {
                    throw PairingAdmissionError.refused("Relay is busy with another answer. Retry after it finishes.")
                }
                self.launch = launch
                await launch.value
            } else { await connection.start() }
            for await callback in bridge.stream {
                guard active else { break }
                if bridge.didOverflow { result = .refused("Recovery stopped because the callback queue overflowed."); break }
                if let adoption {
                    _ = bridge.ifValid { forward(callback, adoption) }
                    if case .state(.stopped) = callback { active = false; bridge.invalidate(); return }
                    continue
                }
                switch callback {
                case .state(.reachabilityFailed): result = .unreachable
                case .state(.rejected(let reason)): result = .refused(reason)
                case .state(.awaitingLocalApproval(let fingerprint)):
                    result = .refused("This device needs approval on the machine. Run remi authorize \(fingerprint), then Retry.")
                case .state(.awaitingRelayConfirmation): result = .refused("Relay enrollment is unavailable. Pair this device explicitly before using Relay.")
                case .state(.stopped): result = .refused("The recovery connection stopped before verified Hello.")
                case .event(.hello(let hello, let key)):
                    try check()
                    guard key == target.key, hello.sessionId == nil, (hello.protocolVersion ?? 1) == PairingPayload.protocolVersion,
                          (hello.machine.map { $0.id == target.machineID } ?? true) else {
                        throw PairingAdmissionError.refused("The recovery endpoint did not verify as the saved hub identity.")
                    }
                    #if DEBUG
                    await ownedBeforeAdmission?()
                    #endif
                    try await connection.completeCoordinatedAdmission()
                    try check()
                    let commitment = try bridge.ifValid { try admissionFence.commit { try admit(connection, id, hello, target.key) } }
                    guard let adopted = commitment ?? nil else {
                        throw PairingAdmissionError.refused("Recovery callbacks are no longer current.")
                    }
                    adoption = adopted
                    adoptedRoute.value = adopted
                    finish(.promoted)
                    continue
                default: continue
                }
                break
            }
            if adoption != nil {
                // An overflow after promotion revokes this route, not another
                // healthy root. Normal generation checks fence its callbacks.
                if bridge.didOverflow, let adoption { forward(.state(.rejected(reason: "The connection callback queue overflowed.")), adoption) }
                active = false; bridge.invalidate(); await retire().value; return
            }
            if bridge.didOverflow { result = .refused("Recovery stopped because the callback queue overflowed.") }
        } catch is CancellationError { result = .cancelled }
        catch let error as PairingAdmissionError { result = .refused(error.reason) }
        catch { result = .refused("The recovery socket ended before admission. Check the hub and Retry.") }
        active = false; bridge.invalidate()
        await retire().value
        finish(result)
    }

    private func isCurrent() -> Bool {
        if adoption != nil { return active }
        return active && (try? validate()) != nil
    }

    private func brokerRetired() {
        guard adoption == nil else { return }
        active = false; bridge.invalidate()
        _ = retire()
    }
}
