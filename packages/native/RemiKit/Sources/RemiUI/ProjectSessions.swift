import Foundation

/// The sessions of each project, indexed once so a long-press menu on every row does not
/// scan the whole list.
public struct RemiProjectSessions: Sendable {
    /// The most sessions a row's menu lists.
    public static let defaultLimit = 8

    private let byProject: [String: [RemiSessionSummary]]

    public init(sessions: [RemiSessionSummary]) {
        byProject = Dictionary(grouping: sessions, by: Self.projectKey)
    }

    /// The project's other sessions on the same machine, most recent first, in the order the
    /// session list uses (so ties settle the same way). The one asked about is left out.
    public func others(than session: RemiSessionSummary, limit: Int = defaultLimit) -> [RemiSessionSummary] {
        let siblings = (byProject[Self.projectKey(session)] ?? []).filter { $0.key != session.key }
        return Array(RemiSessionGrouping.sorted(siblings).prefix(limit))
    }

    private static func projectKey(_ session: RemiSessionSummary) -> String {
        "\(session.machineID)\u{1F}\(session.projectPath)"
    }
}

public extension RemiSessionStatus {
    /// Shared activity vocabulary for Claude and Codex (#1673).
    init(activityStatus: String) {
        switch activityStatus {
        case "active", "thinking", "executing", "working", "evaluating", "approved": self = .working
        case "waiting": self = .needsYou
        case "starting": self = .connecting
        default: self = .idle
        }
    }

    /// "Working" is a claim about this moment. From a machine the app cannot reach it is a stale
    /// claim, so it reads as idle until the machine answers. Everything else is shown as known.
    func whileMachine(connected: Bool) -> RemiSessionStatus {
        self == .working && !connected ? .idle : self
    }
}
