import Foundation

public struct RemiCommandCenterSnapshot: Sendable, Equatable {
    public let sessions: [RemiSessionSummary]
    public let questions: [RemiQuestionCardModel]

    public init(
        sessions: [RemiSessionSummary],
        questions: [RemiQuestionCardModel],
        selectedMachineID: String,
        query: String
    ) {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let machineSessions = selectedMachineID.isEmpty
            ? sessions
            : sessions.filter { $0.machineID == selectedMachineID }
        let machineQuestions = selectedMachineID.isEmpty
            ? questions
            : questions.filter { $0.machineID == selectedMachineID }

        self.sessions = machineSessions.filter { session in
            trimmedQuery.isEmpty || sessionSearchText(session)
                .localizedCaseInsensitiveContains(trimmedQuery)
        }
        self.questions = machineQuestions.filter { question in
            trimmedQuery.isEmpty || questionSearchText(question)
                .localizedCaseInsensitiveContains(trimmedQuery)
        }
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
