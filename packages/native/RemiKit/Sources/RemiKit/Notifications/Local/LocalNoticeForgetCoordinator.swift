import Foundation

/// Synchronous current-process forget protocol. It never associates prior-process owners with
/// profiles. The caller must show a pending/error state and must not fall back to another writer.
@MainActor final class LocalNoticeForgetCoordinator {
    enum Outcome: Equatable { case completed, pending, unavailable }
    private struct Attempt {
        let endpoint: MachineEndpoint
        let plan: LocalNoticeProfileWritePlan
        var removed: Bool
    }
    private let store: MachineStore
    private let lifecycle: LocalNoticeLifecycle
    private let profiles: MachineConfigurationStore
    private let defaults: UserDefaults
    private let domainName: String
    private let flush: (UserDefaults) -> Bool
    private let willRemove: (MachineEndpoint) -> Void
    private let didRemove: (MachineEndpoint) -> Void
    private var attempts: [UUID: Attempt] = [:]
    private static let maximumAttempts = 128

    init(store: MachineStore, lifecycle: LocalNoticeLifecycle, profiles: MachineConfigurationStore,
         defaults: UserDefaults, domainName: String, flush: @escaping (UserDefaults) -> Bool,
         willRemove: @escaping (MachineEndpoint) -> Void = { _ in },
         didRemove: @escaping (MachineEndpoint) -> Void = { _ in }) {
        self.store = store; self.lifecycle = lifecycle; self.profiles = profiles
        self.defaults = defaults; self.domainName = domainName; self.flush = flush
        self.willRemove = willRemove; self.didRemove = didRemove
    }

    func begin(owner: UUID) -> Outcome {
        if attempts[owner] != nil { return retry(owner: owner) }
        guard attempts.count < Self.maximumAttempts,
              let machine = store.machines.first(where: { $0.pairingLifetime == owner }),
              uniqueOwner(of: machine.endpoint, is: owner),
              let intended = store.profilesForLocalForget(excluding: owner)
        else { return .unavailable }
        do {
            let plan = try profiles.prepareLocalForgetProfiles(intended, defaults: defaults, domainName: domainName,
                                                               expectedCurrent: store.persistableProfiles)
            attempts[owner] = Attempt(endpoint: machine.endpoint, plan: plan, removed: false)
            return retry(owner: owner)
        } catch { return .unavailable }
    }

    func retry(owner: UUID) -> Outcome {
        guard var attempt = attempts[owner] else { return .unavailable }
        if !attempt.removed {
            guard uniqueOwner(of: attempt.endpoint, is: owner), lifecycle.retireOwner(owner) else { return .pending }
            willRemove(attempt.endpoint)
            guard uniqueOwner(of: attempt.endpoint, is: owner), store.removeMachine(attempt.endpoint) else { return .pending }
            attempt.removed = true
            attempts[owner] = attempt
            didRemove(attempt.endpoint)
        }
        // A new same-endpoint lifetime or unrelated profile edit invalidates the old plan.
        guard !store.machines.contains(where: { $0.pairingLifetime == owner }),
              profiles.localForgetPlan(attempt.plan, matches: store.persistableProfiles) else { return .pending }
        do {
            try profiles.commitLocalForgetProfiles(attempt.plan, defaults: defaults, flush: flush)
            // A synchronous injected callback can reenter the Store; check again before completing.
            guard !store.machines.contains(where: { $0.pairingLifetime == owner }),
                  profiles.localForgetPlan(attempt.plan, matches: store.persistableProfiles) else { return .pending }
            try lifecycle.finishOwnerForget(owner)
            attempts[owner] = nil
            return .completed
        } catch { return .pending }
    }

    private func uniqueOwner(of endpoint: MachineEndpoint, is owner: UUID) -> Bool {
        let matching = store.machines.filter { $0.routingRoutes.contains(where: { $0.id == endpoint.id }) }
        return matching.count == 1 && matching.first?.pairingLifetime == owner
    }
}
