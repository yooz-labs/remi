import Foundation

/// Monotonic scheduling state, shared by every trigger in one Store. Path
/// changes reset an episode, never the global cooldown. It grants no authority.
struct MachineRecoverySchedule {
    static let debounce: Duration = .milliseconds(750)
    static let cooldown: Duration = .seconds(30)
    static let sweepTimeout: Duration = .seconds(180)
    static let maximumSweeps = 3

    private(set) var sweeps = 0
    private(set) var due: ContinuousClock.Instant?
    private(set) var deadline: ContinuousClock.Instant?
    private(set) var lastStart: ContinuousClock.Instant?
    var exhausted: Bool { sweeps >= Self.maximumSweeps && deadline == nil }

    mutating func request(at now: ContinuousClock.Instant, newEpisode: Bool) {
        if newEpisode { sweeps = 0 }
        guard sweeps < Self.maximumSweeps, deadline == nil else { return }
        due = max(now.advanced(by: Self.debounce), lastStart?.advanced(by: Self.cooldown) ?? now)
    }

    mutating func begin(at now: ContinuousClock.Instant) -> Bool {
        guard deadline == nil, let due, now >= due, sweeps < Self.maximumSweeps else { return false }
        sweeps += 1
        self.due = nil
        lastStart = now
        deadline = now.advanced(by: Self.sweepTimeout)
        return true
    }

    mutating func finish(at now: ContinuousClock.Instant, retry: Bool) {
        deadline = nil
        due = nil
        guard retry, sweeps < Self.maximumSweeps else { return }
        let backoff: Duration = sweeps == 1 ? .seconds(15) : .seconds(60)
        due = max(now.advanced(by: backoff), lastStart?.advanced(by: Self.cooldown) ?? now)
    }

    mutating func cancel() {
        due = nil
        deadline = nil
    }
}

/// Counts starts rather than successes. Cancellation and authentication refusal
/// never refund an attempt. Retire sockets before releasing their lease.
struct MachineRecoveryProbeBudget {
    static let maximumStarts = 8
    static let concurrent = 2
    private(set) var starts = 0
    private var active: [UUID: String] = [:]
    var activeCount: Int { active.count }
    var exhausted: Bool { starts >= Self.maximumStarts }

    mutating func reserve(profileID: String) -> UUID? {
        guard starts < Self.maximumStarts, active.count < Self.concurrent,
              !active.values.contains(profileID) else { return nil }
        let lease = UUID()
        active[lease] = profileID
        starts += 1
        return lease
    }

    mutating func retire(_ lease: UUID) { active[lease] = nil }
}
