import Foundation

/// One choice on a card (`QuestionOption` in `packages/shared/src/types.ts`).
public struct QuestionOption: Codable, Sendable, Equatable, Hashable {
    public let label: String
    public let value: String
    public let isRecommended: Bool
    public let isYes: Bool
    public let isNo: Bool
    /// The option's own explanation (an AskUserQuestion choice), when it has one.
    public let description: String?
    public let suggestionIndex: Int?
    public let standingGrant: String?
}

public struct QuestionStep: Codable, Sendable, Equatable {
    public let header: String?
    public let text: String
    public let multiSelect: Bool
    public let options: [QuestionOption]
}

/// A card: the agent needs the person (`Question` in `packages/shared/src/types.ts`).
/// Only the fields every card has are required; the rest are optional on the wire.
public struct Question: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let text: String
    public let options: [QuestionOption]
    public let allowsFreeText: Bool
    public let isAnswered: Bool
    /// The whole command or plan when the text is cut short.
    public let detail: String?
    /// Only the terminal can answer it; the app offers no controls.
    public let terminalOnly: Bool?
    public let cancelDismissesOnly: Bool?
    public let kind: String?
    public let questions: [QuestionStep]?
    public let submitLabel: String?
    public let held: Bool?
    public let agentId: String?
}

/// `{ "type": "question", ... }`: a card for a session.
public struct QuestionMessage: Decodable, Sendable, Equatable {
    public let type: String
    public let id: String
    public let timestamp: String
    public let question: Question
    public let sessionId: String
    public let claudeSessionId: String?
    public let harness: String?
    public let harnessSessionId: String?
}
