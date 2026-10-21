import Foundation
import RemiPush

public struct MachineRecoveryProgress: Sendable, Equatable {
    public enum Phase: Sendable, Equatable { case scheduled, discovering, probing, waiting, recovered, exhausted }
    public let phase: Phase
    public let attemptedLayer: MachineConnectionLayer?
    public let message: String
    public var allowsRetry: Bool { phase == .waiting || phase == .exhausted }
    init(phase: Phase, attemptedLayer: MachineConnectionLayer?, message: String) {
        self.phase = phase; self.attemptedLayer = attemptedLayer; self.message = PushDisplayText.escape(message)
    }
}

/// Store-owned bounded recovery. Candidate callbacks never enter its active
/// dictionaries until the same-socket admission callback commits synchronously.
@MainActor
final class MachineRecoveryCoordinator {
    private struct Queued {
        let target: MachineRecoveryTarget
        let endpoint: MachineEndpoint
        let discovered: Bool
        let candidateID: String?
        var key: String { "\(target.id)|\(endpoint.id)" }
    }
    private let discovery = LocalMachineDiscovery()
    private let path = MachineNetworkPathMonitor()
    private let identity: ClientIdentity
    private let clientVersion: String
    private let clientID: String
    private let snapshot: () -> [MachineRecoveryTarget]
    private let validate: (MachineRecoveryTarget, MachineEndpoint) throws -> Void
    private let admit: (MachineRecoveryTarget, MachineEndpoint, Bool, RemiConnection, UUID, HelloAckMessage, Data) throws -> PairingAdoption
    private let forward: (PairingCallbackBridge.Callback, PairingAdoption) -> Void
    private let resume: @MainActor @Sendable (PairingAdoption) -> Void
    private let publish: (String, MachineRecoveryProgress) -> Void
    private var active = false
    private var epoch = UUID()
    private var schedule = MachineRecoverySchedule()
    private var budget = MachineRecoveryProbeBudget()
    private var targets: [MachineRecoveryTarget] = []
    private var queue: [Queued] = []
    private var seen: Set<String> = []
    private var liveCandidates: Set<String> = []
    private var blocked: Set<String> = []
    private var promoted: Set<String> = []
    private var failures: [String: String] = [:]
    private var probes: [UUID: (MachineRecoveryProbe, UUID)] = [:]
    private var browseDone = true
    private var scheduled: Task<Void, Never>?
    private var timeout: Task<Void, Never>?
    private var retirement: Task<Void, Never>?
    #if DEBUG
    var ownedBeforeAdmission: (@MainActor () async -> Void)?
    private(set) var ownedStarts: [(String, MachineConnectionLayer, Bool)] = []
    private(set) var ownedStartTimes: [ContinuousClock.Instant] = []
    private(set) var ownedAdmittedConnections: [UUID: ObjectIdentifier] = [:]
    private(set) var ownedRefusalReasons: [String] = []
    var ownedIsBrowsing: Bool { discovery.isBrowsing }
    var ownedActiveProbes: Int { probes.count }
    var ownedEpoch: UUID { epoch }
    var ownedSweepCount: Int { schedule.sweeps }
    var ownedLastSweepStart: ContinuousClock.Instant? { schedule.lastStart }
    var ownedNextSweep: ContinuousClock.Instant? { schedule.due }
    private(set) var ownedScheduleEvents: [String] = []
    private func recordOwnedSchedule(_ event: String) {
        ownedScheduleEvents.append("\(ContinuousClock.now):\(event) sweeps=\(schedule.sweeps) starts=\(budget.starts) due=\(String(describing: schedule.due)) deadline=\(String(describing: schedule.deadline)) epoch=\(epoch)")
        if ownedScheduleEvents.count > 32 { ownedScheduleEvents.removeFirst(ownedScheduleEvents.count - 32) }
    }
    #endif

    init(identity: ClientIdentity, clientVersion: String, clientID: String,
         snapshot: @escaping () -> [MachineRecoveryTarget],
         validate: @escaping (MachineRecoveryTarget, MachineEndpoint) throws -> Void,
         admit: @escaping (MachineRecoveryTarget, MachineEndpoint, Bool, RemiConnection, UUID, HelloAckMessage, Data) throws -> PairingAdoption,
         forward: @escaping (PairingCallbackBridge.Callback, PairingAdoption) -> Void,
         resume: @escaping @MainActor @Sendable (PairingAdoption) -> Void,
         publish: @escaping (String, MachineRecoveryProgress) -> Void) {
        self.identity = identity; self.clientVersion = clientVersion; self.clientID = clientID
        self.snapshot = snapshot; self.validate = validate; self.admit = admit; self.forward = forward; self.resume = resume; self.publish = publish
    }

    func start() {
        guard !active else { return }
        active = true
        path.start { [weak self] _ in self?.trigger(newEpisode: true) }
        trigger(newEpisode: true)
    }

    func stop() {
        active = false; path.stop(); invalidate()
    }

    func invalidate() {
        #if DEBUG
        recordOwnedSchedule("invalidate")
        #endif
        epoch = UUID()
        scheduled?.cancel(); scheduled = nil; timeout?.cancel(); timeout = nil
        discovery.cancel()
        let previous = retirement
        let stops = probes.values.map { $0.0.cancel() }
        retirement = Task { await previous?.value; for stop in stops { await stop.value } }
        probes.removeAll(); queue.removeAll(); targets.removeAll(); liveCandidates.removeAll()
        schedule.cancel()
    }

    func trigger(newEpisode: Bool) {
        #if DEBUG
        recordOwnedSchedule("trigger newEpisode=\(newEpisode)")
        #endif
        guard active else { return }
        // A transient duplicate failure cannot interrupt an ongoing sweep or
        // endlessly extend its debounce. A new path/foreground/Retry can.
        if !newEpisode, schedule.deadline != nil || schedule.due != nil { return }
        invalidate()
        schedule.request(at: .now, newEpisode: newEpisode)
        arm()
    }

    /// An owned configured/admitted root stopped. Candidate refusals never call
    /// this: they remain quarantined in completed(). Retiring the current sweep
    /// preserves its consumed starts and the episode's sweep count/cooldown.
    func configuredRootStopped(profileID: String) {
        guard active else { return }
        blocked.insert(profileID)
        if schedule.deadline != nil {
            finishSweep()
        } else {
            let pending = schedule
            invalidate()
            // Preserve an already armed backoff exactly, including its due
            // instant; requesting again could shorten the 60-second backoff.
            schedule = pending
            arm()
        }
    }

    private func arm() {
        guard active, let due = schedule.due else { return }
        for target in snapshot() {
            publish(target.id, .init(phase: .scheduled, attemptedLayer: nil,
                message: (failures[target.id].map { $0 + " " } ?? "")
                    + "Recovery is waiting for its bounded debounce or network cooldown."))
        }
        let run = epoch, retirement = retirement
        scheduled = Task { [weak self] in
            await retirement?.value
            do { try await Task.sleep(until: due, clock: .continuous) } catch { return }
            guard let self, self.active, self.epoch == run else { return }
            let targets = self.snapshot()
            guard !targets.isEmpty else { self.schedule.cancel(); return }
            guard self.schedule.begin(at: .now) else { return }
            self.beginSweep(targets)
        }
    }

    private func beginSweep(_ snapshots: [MachineRecoveryTarget]) {
        #if DEBUG
        recordOwnedSchedule("beginSweep targets=\(snapshots.count)")
        #endif
        targets = snapshots
        budget = MachineRecoveryProbeBudget(); queue = []; seen = []; blocked = []; promoted = []; failures = [:]
        let run = epoch
        for target in targets {
            for route in target.profile.connectionPreference.orderedRoutes(target.profile.routes) where target.permits(route) {
                queue.append(Queued(target: target, endpoint: target.pinned(route), discovered: false, candidateID: nil))
            }
            if target.local == nil, !queue.contains(where: { $0.target.id == target.id }) {
                blocked.insert(target.id)
                failures[target.id] = target.profile.connectionPreference == .relayOnly
                    ? "No enrolled Relay route is available. Pair this device explicitly over Relay first."
                    : "No Tailscale address is configured. Add that address and keep Tailscale connected on both devices."
            }
            publish(target.id, .init(phase: .discovering, attemptedLayer: nil,
                message: target.local == nil ? "Checking the selected connection layer." : "Looking for your saved hub on this local network."))
        }
        sortQueue()
        browseDone = false
        discovery.start(targets: targets.compactMap(\.local)) { [weak self] event in
            guard let self, self.active, self.epoch == run else { return }
            switch event {
            case .candidates(let candidates):
                self.liveCandidates = Set(candidates.map(\.id))
                self.queue.removeAll { $0.discovered }
                for candidate in candidates {
                    guard let target = self.targets.first(where: { $0.id == candidate.target.profileID }), target.permits(candidate.endpoint) else { continue }
                    self.queue.append(Queued(target: target, endpoint: candidate.endpoint, discovered: true, candidateID: candidate.id))
                }
                self.sortQueue()
            case .finished(let outcome):
                self.browseDone = true
                if outcome == .permissionDenied || outcome == .unavailable {
                    for target in self.targets where target.local != nil {
                        self.failures[target.id] = outcome == .permissionDenied
                            ? "Local network permission is denied. Allow Remi in system privacy settings, then Retry."
                            : "Local discovery is unavailable. Check the network and Retry."
                    }
                }
            }
            self.pump()
        }
        guard epoch == run, schedule.deadline != nil else { return }
        timeout = Task { [weak self] in
            do { try await Task.sleep(for: MachineRecoverySchedule.sweepTimeout) } catch { return }
            guard let self, self.epoch == run else { return }
            for target in self.targets { self.failures[target.id] = "Recovery timed out. Check the selected network and Retry." }
            self.finishSweep()
        }
        pump()
    }

    private func sortQueue() {
        queue.sort {
            if $0.endpoint.connectionLayer != $1.endpoint.connectionLayer { return $0.endpoint.connectionLayer < $1.endpoint.connectionLayer }
            if $0.discovered != $1.discovered { return !$0.discovered }
            return $0.key < $1.key
        }
    }

    private func pump() {
        guard active, schedule.deadline != nil else { return }
        queue.removeAll { seen.contains($0.key) || blocked.contains($0.target.id) || promoted.contains($0.target.id) }
        while !budget.exhausted, budget.activeCount < MachineRecoveryProbeBudget.concurrent {
            let busy = Set(probes.values.map { $0.0.target.id })
            guard let index = queue.firstIndex(where: {
                !busy.contains($0.target.id) && (browseDone || $0.target.local == nil || $0.endpoint.connectionLayer == .local)
            }) else { break }
            let next = queue.remove(at: index)
            guard let lease = budget.reserve(profileID: next.target.id) else { break }
            seen.insert(next.key)
            let run = epoch
            let probe = MachineRecoveryProbe(target: next.target, endpoint: next.endpoint, discovered: next.discovered,
                candidateID: next.candidateID, identity: identity, clientVersion: clientVersion, clientID: clientID,
                validate: { [weak self] in
                    guard let self, self.active, self.epoch == run, self.schedule.deadline.map({ .now < $0 }) == true,
                          !next.discovered || next.candidateID.map(self.liveCandidates.contains) == true else { throw CancellationError() }
                    try self.validate(next.target, next.endpoint)
                }, admit: { [weak self] connection, generation, hello, key in
                    guard let self else { throw CancellationError() }
                    let adopted = try self.admit(next.target, next.endpoint, next.discovered, connection, generation, hello, key)
                    #if DEBUG
                    self.ownedAdmittedConnections[generation] = ObjectIdentifier(connection)
                    #endif
                    return adopted
                }, forward: forward, resume: resume,
                completion: { [weak self] outcome in self?.completed(lease: lease, next: next, run: run, outcome: outcome) })
            #if DEBUG
            probe.ownedBeforeAdmission = ownedBeforeAdmission
            ownedStarts.append((next.target.id, next.endpoint.connectionLayer, next.discovered))
            ownedStartTimes.append(.now)
            if ownedStarts.count > 128 { ownedStarts.removeFirst(ownedStarts.count - 128) }
            if ownedStartTimes.count > 128 { ownedStartTimes.removeFirst(ownedStartTimes.count - 128) }
            #endif
            probes[probe.id] = (probe, lease)
            publish(next.target.id, .init(phase: .probing, attemptedLayer: next.endpoint.connectionLayer,
                message: "Verifying a \(next.endpoint.connectionLayer.title) connection to the saved hub."))
            probe.start()
        }
        if probes.isEmpty, (budget.exhausted || (browseDone && queue.isEmpty)) { finishSweep() }
    }

    private func completed(lease: UUID, next: Queued, run: UUID, outcome: MachineRecoveryProbeOutcome) {
        guard active, epoch == run else { return }
        if let id = probes.first(where: { $0.value.1 == lease })?.key { probes[id] = nil }
        budget.retire(lease)
        switch outcome {
        case .promoted:
            promoted.insert(next.target.id)
            publish(next.target.id, .init(phase: .recovered, attemptedLayer: nil, message: "Connected over \(next.endpoint.connectionLayer.title). Session state has been refreshed."))
        case .unreachable:
            // A later address timeout must not hide an authenticated refusal or
            // an identity mismatch already observed for this profile.
            if failures[next.target.id] == nil {
                failures[next.target.id] = "The permitted addresses are unreachable. Check that the hub is running on this network."
            }
            publish(next.target.id, .init(phase: .waiting, attemptedLayer: nil,
                message: failures[next.target.id] ?? "The address is unreachable."))
        case .refused(let reason):
            #if DEBUG
            ownedRefusalReasons.append(reason)
            if ownedRefusalReasons.count > 128 { ownedRefusalReasons.removeFirst(ownedRefusalReasons.count - 128) }
            #endif
            failures[next.target.id] = reason
            if !next.discovered { blocked.insert(next.target.id) }
            publish(next.target.id, .init(phase: .waiting, attemptedLayer: nil,
                message: reason + (next.target.healthyLayer == nil ? "" : " The active connection was kept.")))
        case .cancelled:
            publish(next.target.id, .init(phase: .waiting, attemptedLayer: nil,
                message: failures[next.target.id] ?? "The discovery candidate changed before verification. The active connection was kept."))
        }
        pump()
    }

    private func finishSweep() {
        #if DEBUG
        recordOwnedSchedule("finishSweep")
        #endif
        guard schedule.deadline != nil else { return }
        let remaining = targets.filter { !promoted.contains($0.id) }
        let retry = remaining.contains { !blocked.contains($0.id) }
        let snapshots = remaining
        // Retire epochs and every candidate socket before the next sweep.
        invalidate()
        schedule.finish(at: .now, retry: retry)
        for target in snapshots {
            let exhausted = schedule.due == nil
            let reason = failures[target.id] ?? "No advertising hub was verified on this network. Bonjour needs a compatible reachable hub and supplies no VPN."
            publish(target.id, .init(phase: exhausted ? .exhausted : .waiting, attemptedLayer: nil,
                message: reason + (exhausted ? " Use Retry after checking the selected layer." : " Recovery will retry within this bounded episode.")))
        }
        arm()
    }
}
