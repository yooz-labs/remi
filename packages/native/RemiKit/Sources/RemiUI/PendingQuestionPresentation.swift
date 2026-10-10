import Foundation
import RemiKit

public struct RemiPendingQuestionGroup: Identifiable, Sendable, Equatable {
    public let id: String
    public let machineName: String
    public let address: String
    public let reachability: RemiMachineReachability
    public let transport: RemiTransport
    public let items: [RemiPendingQuestionItem]
}

public struct RemiPendingQuestionItem: Identifiable, Sendable, Equatable {
    public let id: String
    public let model: RemiQuestionCardModel
    public let sessionID: String
    public let questionID: String
    public let agentID: String?
    public let claudeSessionID: String?
    public let projectName: String?
    public let harnessName: String?
    public let conversationName: String

    public var destination: RemiNavigationDestination {
        RemiNavigationDestination(
            machineID: model.machineID,
            sessionID: sessionID,
            questionID: questionID,
            agentID: agentID
        )
    }
}

public enum RemiPendingQuestionPresentation {
    public static func groups(
        machines: [MachineState],
        viewsBySession: [String: [SessionViewMeta]] = [:]
    ) -> [RemiPendingQuestionGroup] {
        machines.compactMap { machine in
            let items = machine.questions.map { message in
                item(machine: machine, message: message, views: viewsBySession[message.sessionId] ?? [])
            }
            .sorted(by: itemOrder)
            guard !items.isEmpty else { return nil }
            return RemiPendingQuestionGroup(
                id: machine.id,
                machineName: machine.displayName,
                address: machine.endpoint.displayAddress,
                reachability: reachability(machine.status),
                transport: transport(machine.endpoint),
                items: items
            )
        }
        .sorted { lhs, rhs in
            let nameOrder = lhs.machineName.localizedCaseInsensitiveCompare(rhs.machineName)
            return nameOrder == .orderedSame ? lhs.id < rhs.id : nameOrder == .orderedAscending
        }
    }

    private static func item(
        machine: MachineState,
        message: QuestionMessage,
        views: [SessionViewMeta]
    ) -> RemiPendingQuestionItem {
        let question = message.question
        let kind = RemiQuestionKind(wireValue: question.kind)
        let session = machine.sessions.first { $0.sessionId == message.sessionId }
        let sessionName = session?.name ?? String(message.sessionId.prefix(8))
        let agentName = question.agentId.flatMap { agentID in
            views.first(where: { $0.agentId == agentID })?.agentType
        }

        let model = RemiQuestionCardModel(
            id: RemiQuestionCardModel.identity(
                machineID: machine.id,
                sessionID: message.sessionId,
                questionID: question.id
            ),
            questionID: question.id,
            kind: kind,
            text: question.text,
            detail: question.detail,
            machineID: machine.id,
            machineName: machine.displayName,
            sessionName: sessionName,
            options: question.options.map { option in
                RemiQuestionOption(
                    id: option.value,
                    label: option.label,
                    detail: option.description,
                    role: kind.optionRole(isYes: option.isYes, isNo: option.isNo),
                    grantsForSession: option.standingGrant != nil || option.sessionGrant != nil,
                    isRecommended: option.isRecommended
                )
            },
            steps: (question.questions ?? []).enumerated().map { index, step in
                RemiQuestionStep(
                    id: String(index),
                    header: step.header,
                    text: step.text,
                    allowsMultipleSelection: step.multiSelect,
                    allowsFreeText: !step.multiSelect,
                    options: step.options.enumerated().map { optionIndex, option in
                        RemiQuestionOption(
                            id: String(optionIndex),
                            label: option.label,
                            detail: option.description,
                            role: .neutral,
                            isRecommended: option.isRecommended
                        )
                    }
                )
            },
            terminalOnly: question.terminalOnly == true
                || question.answerPath == QuestionAnswerPath.none
                || question.hasUnknownAnswerPath,
            answerPath: answerPath(question.answerPath)
        )

        return RemiPendingQuestionItem(
            id: model.id,
            model: model,
            sessionID: message.sessionId,
            questionID: question.id,
            agentID: question.agentId,
            claudeSessionID: message.claudeSessionId,
            projectName: session.map { URL(fileURLWithPath: $0.projectPath).lastPathComponent },
            harnessName: session?.harness.map(harnessName),
            conversationName: agentName ?? (question.agentId == nil ? "Main conversation" : "Subagent")
        )
    }

    private static func itemOrder(_ lhs: RemiPendingQuestionItem, _ rhs: RemiPendingQuestionItem) -> Bool {
        let sessionOrder = lhs.model.sessionName.localizedCaseInsensitiveCompare(rhs.model.sessionName)
        if sessionOrder != .orderedSame { return sessionOrder == .orderedAscending }
        let conversationOrder = lhs.conversationName.localizedCaseInsensitiveCompare(rhs.conversationName)
        if conversationOrder != .orderedSame { return conversationOrder == .orderedAscending }
        return lhs.id < rhs.id
    }

    private static func reachability(_ status: MachineConnectionStatus) -> RemiMachineReachability {
        switch status {
        case .connected: .connected
        case .connecting: .connecting
        case .waitingForApproval, .waitingForRelayConfirmation: .waitingForApproval
        case .disconnected, .unavailable: .unreachable
        }
    }

    private static func transport(_ endpoint: MachineEndpoint) -> RemiTransport {
        if endpoint.relayPin != nil { return .relay }
        let host = endpoint.host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        return ["127.0.0.1", "::1", "localhost"].contains(host) ? .local : .direct
    }

    private static func harnessName(_ value: String) -> String {
        switch value.lowercased() {
        case "claude": "Claude Code"
        case "codex": "Codex"
        default: value.capitalized
        }
    }

    private static func answerPath(_ value: QuestionAnswerPath?) -> RemiAnswerPath? {
        switch value {
        case .some(.structured): .structured
        case .some(.keystroke): .keystroke
        case .some(.none): RemiAnswerPath.none
        case nil: nil
        }
    }
}
