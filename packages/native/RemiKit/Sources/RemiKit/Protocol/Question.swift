import Foundation

public enum QuestionAnswerPath: String, Codable, Sendable, Equatable {
    case structured
    case keystroke
    case none
}

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
    /// A separate session capability, never a one-time notification choice (#1141).
    public let sessionGrant: String?
}

public struct QuestionStep: Codable, Sendable, Equatable {
    public let header: String?
    public let text: String
    public let multiSelect: Bool
    public let options: [QuestionOption]
}

/// A card: the agent needs the person (`Question` in `packages/shared/src/types.ts`).
/// Only the fields every card has are required; the rest are optional on the wire.
public struct Question: Decodable, Sendable, Equatable, Identifiable {
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
    public let answerPath: QuestionAnswerPath?
    /// True when the wire supplied an answer path this client does not understand.
    /// Callers must fail closed instead of treating that value like a legacy omission.
    public let hasUnknownAnswerPath: Bool

    enum CodingKeys: String, CodingKey {
        case id, text, options, allowsFreeText, isAnswered, detail, terminalOnly
        case cancelDismissesOnly, kind, questions, submitLabel, held, agentId, answerPath
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        text = try values.decode(String.self, forKey: .text)
        options = try values.decode([QuestionOption].self, forKey: .options)
        allowsFreeText = try values.decode(Bool.self, forKey: .allowsFreeText)
        isAnswered = try values.decode(Bool.self, forKey: .isAnswered)
        detail = try values.decodeIfPresent(String.self, forKey: .detail)
        terminalOnly = try values.decodeIfPresent(Bool.self, forKey: .terminalOnly)
        cancelDismissesOnly = try values.decodeIfPresent(Bool.self, forKey: .cancelDismissesOnly)
        kind = try values.decodeIfPresent(String.self, forKey: .kind)
        questions = try values.decodeIfPresent([QuestionStep].self, forKey: .questions)
        submitLabel = try values.decodeIfPresent(String.self, forKey: .submitLabel)
        held = try values.decodeIfPresent(Bool.self, forKey: .held)
        agentId = try values.decodeIfPresent(String.self, forKey: .agentId)
        let rawAnswerPath = try values.decodeIfPresent(String.self, forKey: .answerPath)
        answerPath = rawAnswerPath.flatMap(QuestionAnswerPath.init(rawValue:))
        hasUnknownAnswerPath = rawAnswerPath != nil && answerPath == nil
    }
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
