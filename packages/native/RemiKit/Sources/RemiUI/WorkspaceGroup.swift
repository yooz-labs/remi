import Foundation

/// The sessions of one project folder on one machine, in the order the Mac list shows them.
///
/// The first session is the project's latest: the most urgent, then the most recent. Clicking a
/// closed project opens it.
public struct RemiWorkspaceGroup: Identifiable, Sendable, Equatable {
    public let id: String
    public let project: String
    public let projectPath: String
    public let sessions: [RemiSessionSummary]

    /// Nil when there are no sessions.
    public init?(sessions: [RemiSessionSummary]) {
        guard let first = sessions.first else { return nil }
        id = "\(first.machineID)|\(first.projectPath)"
        project = first.project
        projectPath = first.projectPath
        self.sessions = sessions.sorted { lhs, rhs in
            if lhs.status.triagePriority != rhs.status.triagePriority {
                return lhs.status.triagePriority < rhs.status.triagePriority
            }
            return (lhs.lastActivity ?? "") > (rhs.lastActivity ?? "")
        }
    }

    public var priority: Int { sessions.first?.status.triagePriority ?? .max }
    public var lastActivity: String? { sessions.compactMap(\.lastActivity).max() }
    public var hasLiveSessions: Bool { sessions.contains(where: \.isLive) }
    public var needsAttention: Bool { sessions.contains { $0.status == .needsYou } }
    public var workingCount: Int { sessions.filter { $0.status == .working }.count }
    public var questionCount: Int { sessions.reduce(0) { $0 + $1.openQuestionCount } }

    /// What the project's row shows to the right of its name.
    public struct RowSummary: Sendable, Equatable {
        /// The count of open questions. When present it is the only mark: "Needs you" outranks
        /// "Working".
        public let questionCount: Int?
        /// "2/5 active" when something is running in a project with several sessions, "5" when
        /// there are several and nothing shows as running, nil for a single session.
        public let countText: String?
        /// A collapsed project still shows that something in it is running; an open one shows
        /// each session's own status.
        public let showsWorking: Bool
    }

    public func rowSummary(isExpanded: Bool) -> RowSummary {
        if questionCount > 0 {
            return RowSummary(questionCount: questionCount, countText: nil, showsWorking: false)
        }
        let showsWorking = !isExpanded && workingCount > 0
        let countText: String? =
            if showsWorking, sessions.count > 1 {
                "\(workingCount)/\(sessions.count) active"
            } else if sessions.count > 1 {
                "\(sessions.count)"
            } else {
                nil
            }
        return RowSummary(questionCount: nil, countText: countText, showsWorking: showsWorking)
    }

    /// The row's VoiceOver label: project, folder, session count, and what is going on in it.
    public func accessibilityLabel() -> String {
        var parts = [
            project,
            projectPath,
            sessions.count == 1 ? "1 session" : "\(sessions.count) sessions",
        ]
        if questionCount > 0 {
            parts.append(questionCount == 1 ? "1 question needs attention" : "\(questionCount) questions need attention")
        }
        if workingCount > 0 {
            parts.append(workingCount == 1 ? "1 working" : "\(workingCount) working")
        }
        return parts.joined(separator: ", ")
    }
}

extension RemiSessionStatus {
    /// Lower sorts first in the session list.
    var triagePriority: Int {
        switch self {
        case .needsYou: 0
        case .working: 1
        case .connecting: 2
        case .idle: 3
        case .offline: 4
        }
    }
}
