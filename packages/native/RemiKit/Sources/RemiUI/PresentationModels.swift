import Foundation

public enum RemiQuestionState: Sendable, Equatable {
    case pending
    case sending
    case answered(String)
    case resolvedElsewhere(RemiResolutionSource?)
    case stale
}

public enum RemiQuestionKind: Sendable, Equatable {
    case generic
    case permission
    case multipleChoice
    case askUser
    case planApproval

    public init(wireValue: String?) {
        switch wireValue {
        case "permission": self = .permission
        case "multi_question": self = .askUser
        case "plan_approval": self = .planApproval
        default: self = .generic
        }
    }

    public func optionRole(isYes: Bool, isNo: Bool) -> RemiQuestionOptionRole {
        guard self != .generic else { return .neutral }
        if isYes { return .allow }
        if isNo { return .deny }
        return .neutral
    }
}

public enum RemiResolutionSource: Sendable, Equatable {
    case phone
    case lockscreen
    case terminal
    case harness
    case timeout
}

public enum RemiAnswerPath: Sendable, Equatable {
    case structured
    case keystroke
    case none
}

public enum RemiQuestionOptionRole: Sendable, Equatable {
    case allow
    case deny
    case neutral
}

public struct RemiQuestionOption: Identifiable, Sendable, Equatable {
    public let id: String
    public let label: String
    public let detail: String?
    public let role: RemiQuestionOptionRole
    public let grantsForSession: Bool
    public let isRecommended: Bool

    public init(id: String, label: String, detail: String? = nil, role: RemiQuestionOptionRole = .neutral, grantsForSession: Bool = false, isRecommended: Bool = false) {
        self.id = id
        self.label = label
        self.detail = detail
        self.role = role
        self.grantsForSession = grantsForSession
        self.isRecommended = isRecommended
    }
}

public struct RemiQuestionStep: Identifiable, Sendable, Equatable {
    public let id: String
    public let header: String?
    public let text: String
    public let allowsMultipleSelection: Bool
    public let allowsFreeText: Bool
    public let options: [RemiQuestionOption]

    public init(id: String, header: String? = nil, text: String, allowsMultipleSelection: Bool = false, allowsFreeText: Bool = true, options: [RemiQuestionOption]) {
        self.id = id
        self.header = header
        self.text = text
        self.allowsMultipleSelection = allowsMultipleSelection
        self.allowsFreeText = allowsFreeText && !allowsMultipleSelection
        self.options = options
    }
}

public struct RemiQuestionStepSelection: Sendable, Equatable {
    public let stepID: String
    public let optionIDs: [String]
    public let text: String?

    public init(stepID: String, optionIDs: [String], text: String? = nil) {
        self.stepID = stepID
        self.optionIDs = optionIDs
        self.text = text
    }
}

public enum RemiQuestionForm {
    public static let freeTextLimit = 2_000

    public static func isComplete(
        steps: [RemiQuestionStep],
        selections: [RemiQuestionStepSelection]
    ) -> Bool {
        let selectionByStep = Dictionary(uniqueKeysWithValues: selections.map { ($0.stepID, $0) })
        return steps.allSatisfy { step in
            guard let selection = selectionByStep[step.id] else { return false }
            if step.allowsMultipleSelection {
                return !selection.optionIDs.isEmpty && selection.text == nil
            }
            let text = selection.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard text.count <= freeTextLimit else { return false }
            return (selection.optionIDs.count == 1 && text.isEmpty)
                || (selection.optionIDs.isEmpty && !text.isEmpty)
        }
    }
}

public struct RemiQuestionCardModel: Identifiable, Sendable, Equatable {
    public let id: String
    public let questionID: String
    public let kind: RemiQuestionKind
    public let text: String
    public let detail: String?
    public let machineID: String
    public let machineName: String
    public let sessionID: String
    public let sessionName: String
    public let options: [RemiQuestionOption]
    public let steps: [RemiQuestionStep]
    public let terminalOnly: Bool
    public let answerPath: RemiAnswerPath?
    public let state: RemiQuestionState

    public init(id: String, questionID: String? = nil, kind: RemiQuestionKind, text: String, detail: String? = nil, machineID: String? = nil, machineName: String, sessionID: String? = nil, sessionName: String, options: [RemiQuestionOption] = [], steps: [RemiQuestionStep] = [], terminalOnly: Bool = false, answerPath: RemiAnswerPath? = nil, state: RemiQuestionState = .pending) {
        self.id = id
        self.questionID = questionID ?? id
        self.kind = kind
        self.text = text
        self.detail = detail
        self.machineID = machineID ?? machineName
        self.machineName = machineName
        self.sessionID = sessionID ?? sessionName
        self.sessionName = sessionName
        self.options = options
        self.steps = steps
        self.terminalOnly = terminalOnly
        self.answerPath = answerPath
        self.state = state
    }

    public static func identity(machineID: String, sessionID: String, questionID: String) -> String {
        "\(machineID)|\(sessionID)|\(questionID)"
    }
}

public enum RemiSessionStatus: Sendable, Equatable { case needsYou, working, idle, connecting, offline }

public struct RemiSessionSummary: Identifiable, Sendable, Equatable {
    public let id: String
    public let machineID: String
    public let machineName: String
    public let name: String
    public let harness: String
    public let project: String
    public let projectPath: String
    public let lastActivity: String?
    public let status: RemiSessionStatus
    public let lastMessage: String?
    public let openQuestionCount: Int
    public let isLive: Bool
    public let canTerminate: Bool
    public let canResume: Bool
    public let isResuming: Bool
    public let resumeIdentity: String?
    public let resumeError: String?

    public init(id: String, machineID: String? = nil, machineName: String, name: String, harness: String, project: String, projectPath: String? = nil, lastActivity: String? = nil, status: RemiSessionStatus, lastMessage: String? = nil, openQuestionCount: Int = 0, isLive: Bool? = nil, canTerminate: Bool = false, canResume: Bool = false, isResuming: Bool = false, resumeIdentity: String? = nil, resumeError: String? = nil) {
        self.id = id
        self.machineID = machineID ?? machineName
        self.machineName = machineName
        self.name = name
        self.harness = harness
        self.project = project
        self.projectPath = projectPath ?? project
        self.lastActivity = lastActivity
        self.status = status
        self.lastMessage = lastMessage
        self.openQuestionCount = openQuestionCount
        self.isLive = isLive ?? (status != .offline)
        self.canTerminate = canTerminate
        self.canResume = canResume
        self.isResuming = isResuming
        self.resumeIdentity = resumeIdentity
        self.resumeError = resumeError
    }
}

public enum RemiMachineReachability: Sendable, Equatable { case connected, connecting, unreachable, waitingForApproval }
public enum RemiTransport: String, Sendable, Equatable { case local, direct, relay }

public struct RemiMachineSummary: Identifiable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let address: String
    public let reachability: RemiMachineReachability
    public let transport: RemiTransport
    public let sessionCount: Int
    public let openQuestionCount: Int

    public init(
        id: String,
        name: String,
        address: String,
        reachability: RemiMachineReachability,
        transport: RemiTransport,
        sessionCount: Int,
        openQuestionCount: Int = 0
    ) {
        self.id = id
        self.name = name
        self.address = address
        self.reachability = reachability
        self.transport = transport
        self.sessionCount = sessionCount
        self.openQuestionCount = openQuestionCount
    }
}

public enum RemiTranscriptEntry: Identifiable, Sendable, Equatable {
    case user(id: String, text: String)
    case agent(id: String, text: String)
    case tool(id: String, name: String, summary: String)
    case error(id: String, text: String)

    public var id: String {
        switch self {
        case .user(let id, _), .agent(let id, _), .tool(let id, _, _), .error(let id, _): id
        }
    }

    public var searchableText: String {
        switch self {
        case .user(_, let text), .agent(_, let text), .error(_, let text):
            text
        case .tool(_, let name, let summary):
            "\(name)\n\(summary)"
        }
    }

    public var copyText: String {
        switch self {
        case .user(_, let text), .agent(_, let text), .error(_, let text):
            text
        case .tool(_, let name, let summary):
            "\(name)\n\(summary)"
        }
    }
}

public struct RemiTranscriptReviewState: Sendable, Equatable {
    public private(set) var query = ""
    public private(set) var matchingEntryIDs: [String] = []
    public private(set) var selectedMatchIndex: Int?

    public init() {}

    public var selectedEntryID: String? {
        guard let selectedMatchIndex, matchingEntryIDs.indices.contains(selectedMatchIndex) else {
            return nil
        }
        return matchingEntryIDs[selectedMatchIndex]
    }

    public var resultPosition: Int? {
        selectedMatchIndex.map { $0 + 1 }
    }

    public mutating func update(query: String, entries: [RemiTranscriptEntry]) {
        let previousSelection = selectedEntryID
        self.query = query
        matchingEntryIDs = Self.matches(query: query, entries: entries)

        if let previousSelection,
           let preservedIndex = matchingEntryIDs.firstIndex(of: previousSelection) {
            selectedMatchIndex = preservedIndex
        } else {
            selectedMatchIndex = matchingEntryIDs.isEmpty ? nil : 0
        }
    }

    public mutating func refresh(entries: [RemiTranscriptEntry]) {
        update(query: query, entries: entries)
    }

    public mutating func selectNext() {
        guard !matchingEntryIDs.isEmpty else { return }
        selectedMatchIndex = ((selectedMatchIndex ?? -1) + 1) % matchingEntryIDs.count
    }

    public mutating func selectPrevious() {
        guard !matchingEntryIDs.isEmpty else { return }
        selectedMatchIndex = ((selectedMatchIndex ?? 0) - 1 + matchingEntryIDs.count) % matchingEntryIDs.count
    }

    public mutating func reset() {
        self = RemiTranscriptReviewState()
    }

    private static func matches(query: String, entries: [RemiTranscriptEntry]) -> [String] {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedQuery.isEmpty else { return [] }
        return entries.compactMap { entry in
            entry.searchableText.localizedCaseInsensitiveContains(trimmedQuery) ? entry.id : nil
        }
    }
}
