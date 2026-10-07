import RemiKit
import RemiUI
import SwiftUI

struct PhoneLiveRootView: View {
    let store: MachineStore
    @AppStorage("selectedMachineID") private var selectedMachineID = ""
    @State private var knownQuestionIDs: Set<String> = []
    @State private var notificationBaselineEstablished = false

    var body: some View {
        NavigationStack {
            HomeScreen(
                questions: allQuestions,
                sessions: allSessions,
                machines: machineSummaries,
                selectedMachineID: $selectedMachineID,
                errorMessage: store.latestOperationError ?? store.latestError?.message,
                transcriptForSession: transcript,
                questionsForSession: questions,
                viewsForSession: { store.sessionViewsBySession[$0] ?? [] },
                onAnswer: answer,
                onSubmit: submit,
                onCancel: cancel,
                onOpenSession: store.loadTranscript,
                onSend: sendChat,
                onTerminateSession: store.terminateSession,
                onAddMachine: addMachine,
                onDismissError: store.clearLatestError
            )
        }
        .task { store.start() }
        .task { await PhoneNotificationCoordinator.requestAuthorization() }
        .onChange(of: Set(allQuestions.map(\.id)), initial: true) { oldValue, newValue in
            guard notificationBaselineEstablished else {
                knownQuestionIDs = newValue
                notificationBaselineEstablished = true
                return
            }
            let removed = knownQuestionIDs.subtracting(newValue)
            PhoneNotificationCoordinator.remove(ids: Array(removed))
            for id in newValue.subtracting(knownQuestionIDs) {
                guard let question = allQuestions.first(where: { $0.id == id }) else { continue }
                Task {
                    await PhoneNotificationCoordinator.notify(
                        id: id,
                        title: "\(question.sessionName) needs you",
                        body: question.text
                    )
                }
            }
            knownQuestionIDs = newValue
        }
    }

    private var machineSummaries: [RemiMachineSummary] {
        store.machines.map { machine in
            RemiMachineSummary(
                id: machine.id,
                name: machine.displayName,
                address: machine.endpoint.id,
                reachability: reachability(machine.status),
                transport: machine.endpoint.host == "127.0.0.1" ? .local : .direct,
                sessionCount: machine.sessions.count
            )
        }
    }

    private var allSessions: [RemiSessionSummary] {
        store.machines.flatMap { machine in
            machine.sessions.map { session in
                let count = machine.questions.count { $0.sessionId == session.sessionId }
                return RemiSessionSummary(
                    id: session.sessionId,
                    machineID: machine.id,
                    machineName: machine.displayName,
                    name: session.name ?? URL(fileURLWithPath: session.projectPath).lastPathComponent,
                    harness: session.harness ?? "claude",
                    project: URL(fileURLWithPath: session.projectPath).lastPathComponent,
                    status: count > 0 ? .needsYou : session.status == "active" ? .working : .idle,
                    lastMessage: session.lastMessage,
                    openQuestionCount: count,
                    canTerminate: session.source == "daemon"
                )
            }
        }
    }

    private var allQuestions: [RemiQuestionCardModel] {
        store.machines.flatMap { machine in
            machine.questions.map { presentation($0, machine: machine) }
        }
    }

    private func questions(_ sessionId: String) -> [RemiQuestionCardModel] {
        store.machines.flatMap { machine in
            machine.questions.filter { $0.sessionId == sessionId }.map {
                presentation($0, machine: machine)
            }
        }
    }

    private func presentation(
        _ message: QuestionMessage,
        machine: MachineState
    ) -> RemiQuestionCardModel {
        let question = message.question
        return RemiQuestionCardModel(
            id: question.id,
            kind: question.kind == "multi_question" ? .askUser
                : question.kind == "plan_approval" ? .planApproval : .permission,
            text: question.text,
            detail: question.detail,
            machineID: machine.id,
            machineName: machine.displayName,
            sessionName: machine.sessions.first(where: { $0.sessionId == message.sessionId })?.name
                ?? message.sessionId,
            options: question.options.map { option in
                RemiQuestionOption(
                    id: option.value,
                    label: option.label,
                    detail: option.description,
                    role: option.isYes ? .allow : option.isNo ? .deny : .neutral,
                    grantsForSession: option.standingGrant != nil,
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
                            isRecommended: option.isRecommended
                        )
                    }
                )
            },
            terminalOnly: question.terminalOnly ?? false
        )
    }

    private func transcript(_ sessionId: String) -> [RemiTranscriptEntry] {
        (store.transcriptsBySession[sessionId] ?? []).compactMap { message in
            let content = message.content.trimmingCharacters(in: .whitespacesAndNewlines)
            if !content.isEmpty {
                return message.role == "user"
                    ? .user(id: message.entryUuid, text: content)
                    : .agent(id: message.entryUuid, text: content)
            }
            guard let tool = message.contentBlocks?.first(where: {
                $0.type == "tool_use" || $0.type == "tool_result"
            }) else { return nil }
            let summary = tool.toolInput ?? tool.toolOutput ?? ""
            return .tool(
                id: message.entryUuid,
                name: tool.toolName ?? "Tool",
                summary: String(summary.prefix(240))
            )
        }
    }

    private func answer(sessionId: String, questionId: String, value: String) {
        store.answer(
            sessionId: sessionId,
            questionId: questionId,
            answer: value,
            claudeSessionId: rawQuestion(questionId)?.claudeSessionId
        )
    }

    private func submit(
        sessionId: String,
        questionId: String,
        values: [RemiQuestionStepSelection]
    ) {
        store.answer(
            sessionId: sessionId,
            questionId: questionId,
            answer: "",
            claudeSessionId: rawQuestion(questionId)?.claudeSessionId,
            selections: values.compactMap { value in
                guard let questionIndex = Int(value.stepID) else { return nil }
                return AnswerSelection(
                    questionIndex: questionIndex,
                    optionIndices: value.optionIDs.compactMap(Int.init).sorted(),
                    text: value.text
                )
            }
        )
    }

    private func cancel(sessionId: String, questionId: String) {
        store.answer(
            sessionId: sessionId,
            questionId: questionId,
            answer: "",
            claudeSessionId: rawQuestion(questionId)?.claudeSessionId,
            cancel: true
        )
    }

    private func sendChat(sessionId: String, content: String) {
        let binding = store.machines.lazy.flatMap(\.sessions)
            .first { $0.sessionId == sessionId }?.claudeSessionId
        store.sendChat(sessionId: sessionId, content: content, claudeSessionId: binding)
    }

    private func addMachine(_ endpoint: MachineEndpoint) {
        store.addMachine(endpoint)
        MachineConfigurationStore.shared.save(store.machines.map(\.endpoint))
    }

    private func rawQuestion(_ id: String) -> QuestionMessage? {
        store.machines.lazy.flatMap(\.questions).first { $0.question.id == id }
    }

    private func reachability(_ status: MachineConnectionStatus) -> RemiMachineReachability {
        switch status {
        case .connected: .connected
        case .connecting: .connecting
        case .waitingForApproval: .waitingForApproval
        case .disconnected, .unavailable: .unreachable
        }
    }
}
