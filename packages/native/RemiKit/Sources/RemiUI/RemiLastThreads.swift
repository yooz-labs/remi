import Foundation

/// The last thread open on each machine, so reopening the app (or switching back to a
/// machine) lands where the person left off instead of on the first listed session.
public struct RemiLastThreads: Equatable, Sendable {
    public enum Resolution: Equatable, Sendable {
        /// Open this session: the one wanted, either selected already or remembered.
        case open(String)
        /// Open this session, the first listed, because nothing wanted is listed.
        /// It is not the person's choice and should not be remembered.
        case fallback(String)
        /// The wanted session is not listed yet; leave the selection alone.
        case wait
        /// Nothing to open.
        case clear
    }

    private var sessionByMachine: [String: String] = [:]

    public init() {}

    /// Reads the value written by `storageValue`; anything unreadable is an empty memory.
    public init(storage: String) {
        guard let data = storage.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([String: String].self, from: data)
        else { return }
        sessionByMachine = decoded
    }

    public var storageValue: String {
        guard let data = try? JSONEncoder().encode(sessionByMachine) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    public mutating func remember(machineID: String, sessionID: String) {
        guard !machineID.isEmpty, !sessionID.isEmpty else { return }
        sessionByMachine[machineID] = sessionID
    }

    /// Forgets every machine not in `machineIDs`.
    public mutating func prune(keepingMachines machineIDs: Set<String>) {
        sessionByMachine = sessionByMachine.filter { machineIDs.contains($0.key) }
    }

    /// Whether a machine has been connected long enough for its session list to be complete.
    /// A machine that is not connected (`connectedAt` nil) is never settled.
    public static func isSettled(connectedAt: Date?, now: Date, grace: TimeInterval = 4) -> Bool {
        guard let connectedAt else { return false }
        return now.timeIntervalSince(connectedAt) >= grace
    }

    /// Decides what a machine's thread selection should be.
    ///
    /// A hub lists its own sessions first and each session daemon a moment later, so a
    /// wanted thread that is missing from an unsettled list is waited for, never replaced.
    /// - Parameters:
    ///   - current: the selected session id, empty for none.
    ///   - available: the session ids the machine lists now, in display order.
    ///   - settled: the caller's answer from `isSettled` for this machine: true once it has
    ///     been connected for the grace period, false while it is disconnected or still inside it.
    public func resolve(machineID: String, current: String, available: [String], settled: Bool) -> Resolution {
        let wanted = current.isEmpty ? (sessionByMachine[machineID] ?? "") : current
        if !wanted.isEmpty, available.contains(wanted) { return .open(wanted) }
        if !wanted.isEmpty, !settled { return .wait }
        if let first = available.first { return .fallback(first) }
        return .clear
    }
}
