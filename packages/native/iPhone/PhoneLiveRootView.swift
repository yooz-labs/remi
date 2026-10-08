import RemiKit
import RemiUI
import SwiftUI

struct PhoneLiveRootView: View {
    let store: MachineStore
    @AppStorage("selectedMachineID") private var selectedMachineID = ""
    @State private var knownQuestionIDs: Set<String> = []
    @State private var notificationBaselineEstablished = false
    @State private var questionFeedbackTrigger = 0
    @State private var answerFeedbackTrigger = 0
    @State private var notificationRouter = PhoneNotificationRouter.shared
    @State private var notificationPath: [RemiNavigationDestination] = []
    @State private var pendingResume: ResumeSessionKey?
    @AppStorage(PhonePreferenceKey.haptics) private var hapticsEnabled = true

    var body: some View {
        NavigationStack(path: $notificationPath) {
            HomeScreen(
                questions: allQuestions,
                sessions: allSessions,
                machines: machineSummaries,
                sessionMachines: store.machines,
                recentRepositories: store.recentRepositoriesByMachine,
                publicIdentity: store.publicIdentity,
                selectedMachineID: $selectedMachineID,
                errorMessage: store.latestOperationError ?? store.latestError?.message,
                noticeMessage: store.latestOperationNotice,
                transcriptForSession: transcript,
                questionsForSession: questions,
                viewsForSession: { store.sessionViewsBySession[$0] ?? [] },
                onAnswer: answer,
                onSubmit: submit,
                onCancel: cancel,
                onOpenSession: openSession,
                onSend: sendChat,
                onTerminateSession: store.terminateSession,
                onResumeSession: resumeSession,
                onCreateSession: createSession,
                onAddMachine: addMachine,
                onRemoveMachine: removeMachine,
                onRetryApproval: store.retryApproval,
                onDismissError: store.clearLatestError
            )
            .navigationDestination(for: RemiNavigationDestination.self) { destination in
                notificationDestination(destination)
            }
        }
        .task { store.start() }
        .task { routePendingNotification() }
        .sensoryFeedback(.warning, trigger: questionFeedbackTrigger) { _, _ in
            hapticsEnabled
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: answerFeedbackTrigger) { _, _ in
            hapticsEnabled
        }
        .onChange(of: Set<String>(allQuestions.map(\.id)), initial: true) { oldValue, newValue in
            guard notificationBaselineEstablished else {
                knownQuestionIDs = newValue
                notificationBaselineEstablished = true
                return
            }
            let removed = knownQuestionIDs.subtracting(newValue)
            PhoneNotificationCoordinator.remove(ids: Array(removed))
            for id in newValue.subtracting(knownQuestionIDs) {
                guard let question = allQuestions.first(where: { $0.id == id }),
                      let destination = destination(forQuestionID: id)
                else { continue }
                Task {
                    await PhoneNotificationCoordinator.notify(
                        id: id,
                        title: "\(question.sessionName) needs you",
                        body: question.text,
                        destination: destination
                    )
                }
            }
            if !newValue.subtracting(knownQuestionIDs).isEmpty {
                questionFeedbackTrigger += 1
            }
            knownQuestionIDs = newValue
        }
        .onChange(of: notificationRouter.destination) { _, destination in
            guard destination != nil else { return }
            routePendingNotification()
        }
        .onChange(of: store.resumedSessionDestination) { _, destination in
            guard let destination,
                  pendingResume == ResumeSessionKey(
                    machineID: destination.machineID,
                    sessionID: destination.requestedSessionID
                  )
            else { return }
            pendingResume = nil
            selectedMachineID = destination.machineID
            notificationPath = [RemiNavigationDestination(
                machineID: destination.machineID,
                sessionID: destination.sessionID
            )]
            store.consumeResumedSessionDestination(id: destination.id)
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
                sessionCount: machine.activeSessions.count
            )
        }
    }

    private var allSessions: [RemiSessionSummary] {
        store.machines.flatMap { machine in
            machine.sessions.filter { $0.source == "daemon" || $0.canResume == true }.map { session in
                let count = machine.questions.count { $0.sessionId == session.sessionId }
                return RemiSessionSummary(
                    id: session.sessionId,
                    machineID: machine.id,
                    machineName: machine.displayName,
                    name: session.name ?? URL(fileURLWithPath: session.projectPath).lastPathComponent,
                    harness: session.harness ?? "claude",
                    project: URL(fileURLWithPath: session.projectPath).lastPathComponent,
                    status: session.source == "daemon"
                        ? (count > 0 ? .needsYou : session.status == "active" ? .working : .idle)
                        : .offline,
                    lastMessage: session.lastMessage,
                    openQuestionCount: count,
                    canTerminate: session.source == "daemon",
                    canResume: session.source != "daemon" && session.canResume == true,
                    isResuming: store.resumingSessions.contains(ResumeSessionKey(
                        machineID: machine.id,
                        sessionID: session.sessionId
                    )),
                    resumeIdentity: session.source == "daemon" ? nil : String(session.sessionId.prefix(8)),
                    resumeError: store.resumeErrorsBySession[ResumeSessionKey(
                        machineID: machine.id,
                        sessionID: session.sessionId
                    )]
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
        answerFeedbackTrigger += 1
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
        answerFeedbackTrigger += 1
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
        answerFeedbackTrigger += 1
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

    private func removeMachine(_ machineID: String) {
        guard let machine = store.machines.first(where: { $0.id == machineID }) else { return }
        store.removeMachine(machine.endpoint)
        MachineConfigurationStore.shared.save(store.machines.map(\.endpoint))
    }

    private func createSession(
        endpoint: MachineEndpoint,
        directory: String,
        harness: String,
        workspace: WorkspaceRequest?
    ) {
        store.createSession(
            on: endpoint,
            directory: directory,
            harness: harness,
            workspace: workspace
        )
    }

    private func openSession(_ sessionID: String) {
        pendingResume = nil
        store.loadTranscript(sessionId: sessionID)
    }

    private func resumeSession(machineID: String, sessionID: String) {
        guard let machine = store.machines.first(where: { $0.id == machineID }) else { return }
        pendingResume = ResumeSessionKey(machineID: machine.id, sessionID: sessionID)
        store.resumeSession(on: machine.endpoint, sessionId: sessionID)
    }

    private func rawQuestion(_ id: String) -> QuestionMessage? {
        store.machines.lazy.flatMap(\.questions).first { $0.question.id == id }
    }

    private func destination(forQuestionID id: String) -> RemiNavigationDestination? {
        for machine in store.machines {
            if let message = machine.questions.first(where: { $0.question.id == id }) {
                return RemiNavigationDestination(
                    machineID: machine.id,
                    sessionID: message.sessionId,
                    questionID: id,
                    agentID: message.question.agentId
                )
            }
        }
        return nil
    }

    private func routePendingNotification() {
        guard let destination = notificationRouter.destination else { return }
        pendingResume = nil
        selectedMachineID = destination.machineID
        notificationPath = [destination]
        notificationRouter.destination = nil
    }

    @ViewBuilder
    private func notificationDestination(_ destination: RemiNavigationDestination) -> some View {
        if let session = allSessions.first(where: {
            $0.id == destination.sessionID && $0.machineID == destination.machineID
        }) {
            SessionScreen(
                session: session,
                transcript: transcript(session.id),
                questions: questions(session.id),
                views: store.sessionViewsBySession[session.id] ?? [],
                initialConversationID: destination.agentID,
                transcriptForView: transcript,
                onSelectView: store.loadTranscript,
                onAnswer: { answer(sessionId: session.id, questionId: $0, value: $1) },
                onSubmit: { submit(sessionId: session.id, questionId: $0, values: $1) },
                onCancel: { cancel(sessionId: session.id, questionId: $0) },
                onSend: { sendChat(sessionId: session.id, content: $0) },
                onTerminate: { store.terminateSession(sessionId: session.id) }
            )
            .onAppear {
                store.loadTranscript(sessionId: destination.agentID ?? session.id)
            }
        } else {
            ContentUnavailableView(
                "Conversation unavailable",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("The session may have ended or the machine may be offline.")
            )
        }
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
