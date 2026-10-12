import Foundation

public enum RemiCommandCenterScope: String, CaseIterable, Hashable, Sendable {
    case overview
    case needsYou
    case active
    case recent
}

public struct RemiCommandCenterScopeCounts: Sendable, Equatable {
    public let overview: Int
    public let needsYou: Int
    public let active: Int
    public let recent: Int

    public subscript(scope: RemiCommandCenterScope) -> Int {
        switch scope {
        case .overview: overview
        case .needsYou: needsYou
        case .active: active
        case .recent: recent
        }
    }
}

public struct RemiCommandCenterSnapshot: Sendable, Equatable {
    public let sessions: [RemiSessionSummary]
    public let questions: [RemiQuestionCardModel]
    public let scopeCounts: RemiCommandCenterScopeCounts

    public init(
        sessions: [RemiSessionSummary],
        questions: [RemiQuestionCardModel],
        selectedMachineID: String,
        query: String,
        scope: RemiCommandCenterScope = .overview
    ) {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let machineSessions = selectedMachineID.isEmpty
            ? sessions
            : sessions.filter { $0.machineID == selectedMachineID }
        let machineQuestions = selectedMachineID.isEmpty
            ? questions
            : questions.filter { $0.machineID == selectedMachineID }

        let unresolvedQuestions = machineQuestions.filter(\.needsAttention)
        let machineSessionIDs = Set(machineSessions.map(\.id))
        let attentionSessionIDs = Set(unresolvedQuestions.map(\.sessionID))
            .intersection(machineSessionIDs)
        scopeCounts = RemiCommandCenterScopeCounts(
            overview: machineSessions.count,
            needsYou: attentionSessionIDs.count,
            active: machineSessions.count(where: \.isLive),
            recent: machineSessions.count { !$0.isLive }
        )

        let scopedSessions: [RemiSessionSummary]
        let scopedQuestions: [RemiQuestionCardModel]
        switch scope {
        case .overview:
            scopedSessions = machineSessions
            scopedQuestions = machineQuestions
        case .needsYou:
            scopedSessions = machineSessions.filter { attentionSessionIDs.contains($0.id) }
            scopedQuestions = unresolvedQuestions
        case .active:
            scopedSessions = machineSessions.filter(\.isLive)
            let activeIDs = Set(scopedSessions.map(\.id))
            scopedQuestions = machineQuestions.filter { activeIDs.contains($0.sessionID) }
        case .recent:
            scopedSessions = machineSessions.filter { !$0.isLive }
            scopedQuestions = []
        }

        let matchingQuestions = scopedQuestions.filter { question in
            trimmedQuery.isEmpty || questionSearchText(question)
                .localizedCaseInsensitiveContains(trimmedQuery)
        }
        let matchingQuestionSessionIDs = Set(matchingQuestions.map(\.sessionID))
        self.sessions = scopedSessions.filter { session in
            trimmedQuery.isEmpty
                || matchingQuestionSessionIDs.contains(session.id)
                || sessionSearchText(session).localizedCaseInsensitiveContains(trimmedQuery)
        }
        self.questions = matchingQuestions
    }

    public var activeSessionCount: Int {
        sessions.count(where: \.isLive)
    }

    public var waitingQuestionCount: Int {
        questions.count { question in
            switch question.state {
            case .pending, .sending: true
            case .answered, .resolvedElsewhere, .stale: false
            }
        }
    }

    public var workspaceCount: Int {
        Set(sessions.map { "\($0.machineID)|\($0.projectPath)" }).count
    }
}

public enum RemiCommandCenterDisclosure {
    public static func showsRecent(
        scope: RemiCommandCenterScope,
        query: String,
        manuallyExpanded: Bool
    ) -> Bool {
        scope == .recent
            || !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || manuallyExpanded
    }

    public static func showsMachineManagement(
        hasRecoveryWork: Bool,
        manuallyExpanded: Bool
    ) -> Bool {
        hasRecoveryWork || manuallyExpanded
    }
}

public enum RemiWorkspaceOrdering {
    public static func sortsBefore(
        _ lhs: [RemiSessionSummary],
        _ rhs: [RemiSessionSummary]
    ) -> Bool {
        let left = rank(lhs)
        let right = rank(rhs)
        if left.priority != right.priority { return left.priority < right.priority }
        if left.lastActivity != right.lastActivity { return left.lastActivity > right.lastActivity }
        if left.machineName != right.machineName {
            return left.machineName.localizedCaseInsensitiveCompare(right.machineName) == .orderedAscending
        }
        return left.project.localizedCaseInsensitiveCompare(right.project) == .orderedAscending
    }

    private static func rank(_ sessions: [RemiSessionSummary]) -> (
        priority: Int,
        lastActivity: String,
        machineName: String,
        project: String
    ) {
        let priority = sessions.map(\.commandCenterPriority).min() ?? .max
        let lastActivity = sessions.compactMap(\.lastActivity).max() ?? ""
        return (
            priority,
            lastActivity,
            sessions.first?.machineName ?? "",
            sessions.first?.project ?? ""
        )
    }
}

private extension RemiQuestionCardModel {
    var needsAttention: Bool {
        switch state {
        case .pending, .sending: true
        case .answered, .resolvedElsewhere, .stale: false
        }
    }
}

private extension RemiSessionSummary {
    var commandCenterPriority: Int {
        switch status {
        case .needsYou: 0
        case .working: 1
        case .connecting: 2
        case .idle: 3
        case .offline: 4
        }
    }
}

private func sessionSearchText(_ session: RemiSessionSummary) -> String {
    [
        session.name,
        session.machineName,
        session.project,
        session.projectPath,
        session.harness,
        session.lastMessage,
    ]
    .compactMap { $0 }
    .joined(separator: "\n")
}

private func questionSearchText(_ question: RemiQuestionCardModel) -> String {
    [
        question.text,
        question.detail,
        question.machineName,
        question.sessionName,
    ]
    .compactMap { $0 }
    .joined(separator: "\n")
}
