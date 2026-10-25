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
    @State private var pendingResume: ResumeSessionKey?
    @State private var relayNotifications = NativeRelayNotifications.shared
    @AppStorage(PhonePreferenceKey.haptics) private var hapticsEnabled = true
    /// The session shown in the detail pane. In a compact window the split view collapses into a
    /// stack, so this is also the session pushed on top of Home.
    @State private var selectedDestination: RemiNavigationDestination?
    /// Which column a collapsed (compact) split view shows. Ignored when both columns are visible.
    @State private var compactColumn: NavigationSplitViewColumn = .sidebar
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    /// An action chosen in the detail pane's bar that Home runs, because Home owns its sheets.
    @State private var homeActionRequest: PhoneHomeAction?
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    /// In a wide window the detail pane's bar is the one the system puts on the side of the
    /// display, so Home's actions and the sidebar toggle live there. A compact window collapses
    /// the split view, and Home keeps them in its own bar.
    private var actionsInDetail: Bool { horizontalSizeClass == .regular }

    var body: some View {
        navigationLayout
        .onChange(of: store.persistableEndpoints) { _, endpoints in
            MachineConfigurationStore.shared.save(endpoints)
            relayNotifications.reconcileEndpoints()
        }
        .sheet(isPresented: $relayNotifications.presentsRelayNotification, onDismiss: relayNotifications.closeNotification) {
            RelayNotificationPanel(store: store, onClose: relayNotifications.closeNotification)
        }
        .task { routePendingNotification() }
        .sensoryFeedback(.warning, trigger: questionFeedbackTrigger) { _, _ in
            hapticsEnabled
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: answerFeedbackTrigger) { _, _ in
            hapticsEnabled
        }
        .onChange(of: activeQuestionIDs, initial: true) { oldValue, newValue in
            guard notificationBaselineEstablished else {
                knownQuestionIDs = newValue
                notificationBaselineEstablished = true
                return
            }
            let removed = knownQuestionIDs.subtracting(newValue)
            PhoneNotificationCoordinator.remove(ids: Array(removed))
            for id in newValue.subtracting(knownQuestionIDs) {
                guard let question = allQuestions.first(where: { $0.id == id }),
                      let destination = destination(forQuestionIdentity: id)
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
            present(RemiNavigationDestination(
                machineID: destination.machineID,
                sessionID: destination.sessionID
            ))
            store.consumeResumedSessionDestination(id: destination.id)
        }
    }

    private var homeScreen: some View {
        HomeScreen(
            questions: allQuestions,
            sessions: allSessions,
            machines: machineSummaries,
            sessionMachines: store.machines,
            recentRepositories: store.recentRepositoriesByMachine,
            publicIdentity: store.publicIdentity,
            selectedMachineID: $selectedMachineID,
            errorMessage: store.latestOperationError ?? store.latestError?.message,
            noticeMessage: store.latestOperationNotice ?? relayNotifications.notice ?? store.relayNotificationNotice,
            transcriptForSession: transcript,
            questionsForSession: questions,
            viewsForSession: { store.sessionViewsBySession[$0] ?? [] },
            viewsLoadedForSession: { store.sessionViewsBySession[$0] != nil },
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
            onRetryConnection: store.retryConnection,
            onEnableRelayNotifications: relayNotifications.enable,
            enablingRelayNotifications: relayNotifications.enabling,
            onDismissError: store.clearLatestError,
            onDismissNotice: dismissNotice
        )
    }

    /// Session list on the leading side, the selected session on the trailing side. In a wide
    /// window, such as the open inner display of iPhone Duo, the system keeps the sidebar bar
    /// horizontal and presents the detail pane's bar on the side of the display, which puts the
    /// session controls under the right hand. In a compact window the same view collapses into a
    /// stack, so a rotation or a fold never rebuilds the screen and loses a draft or a sheet.
    private var navigationLayout: some View {
        NavigationSplitView(columnVisibility: $columnVisibility, preferredCompactColumn: $compactColumn) {
            homeScreen
                .navigationSplitViewColumnWidth(min: 320, ideal: 380, max: 460)
                .environment(\.openSessionInDetail, openSessionInDetail)
                .environment(\.selectedSessionID, selectedDestination?.sessionID)
                .environment(\.homeActionsInDetail, actionsInDetail)
                .environment(\.homeActionRequest, $homeActionRequest)
        } detail: {
            detailContent
                .toolbar {
                    if actionsInDetail {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button(
                                sidebarIsHidden ? "Show sessions" : "Hide sessions",
                                systemImage: "sidebar.leading"
                            ) {
                                withAnimation { columnVisibility = sidebarIsHidden ? .all : .detailOnly }
                            }
                        }
                        .verticalBarPreferred()
                        PhoneHomeToolbar(canCreateSession: canCreateSession) { homeActionRequest = $0 }
                    }
                }
        }
        // The system's own toggle sits in the sidebar's bar; the one above replaces it.
        .toolbar(removing: actionsInDetail ? .sidebarToggle : nil)
    }

    @ViewBuilder
    private var detailContent: some View {
        if let selectedDestination {
            notificationDestination(selectedDestination)
                .id(selectedDestination)
        } else {
            ContentUnavailableView(
                "Select a session",
                systemImage: "rectangle.stack",
                description: Text("Choose a workspace, then a session, to read and answer it here.")
            )
        }
    }

    private var sidebarIsHidden: Bool { columnVisibility == .detailOnly }

    /// Mirrors Home: a session can be started when a machine is connected.
    private var canCreateSession: Bool {
        store.machines.contains { $0.status == .connected }
    }

    private func openSessionInDetail(_ session: RemiSessionSummary) {
        present(RemiNavigationDestination(machineID: session.machineID, sessionID: session.id))
    }

    /// Shows a session in the detail pane, or on top of Home when the window is compact.
    private func present(_ destination: RemiNavigationDestination) {
        selectedDestination = destination
        compactColumn = .detail
    }

    private func dismissNotice() {
        if store.latestOperationNotice != nil {
            store.clearLatestError()
        } else if relayNotifications.notice != nil {
            relayNotifications.clearNotice()
        } else {
            store.clearRelayNotificationNotice()
        }
    }

    private var machineSummaries: [RemiMachineSummary] {
        store.machines.map { machine in
            RemiMachineSummary(
                id: machine.id,
                name: machine.displayName,
                address: machine.endpoint.displayAddress,
                reachability: reachability(machine.status),
                transport: machine.endpoint.relayPin != nil ? .relay :
                    machine.endpoint.host == "127.0.0.1" ? .local : .direct,
                sessionCount: machine.activeSessions.count,
                openQuestionCount: machine.questions.count
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
                    projectPath: session.projectPath,
                    lastActivity: session.lastActivity,
                    status: session.source == "daemon"
                        ? (count > 0 ? .needsYou : session.status == "active" ? .working : .idle)
                        : .offline,
                    lastMessage: session.lastMessage,
                    openQuestionCount: count,
                    isLive: session.source == "daemon",
                    canTerminate: session.source == "daemon",
                    canResume: machine.endpoint.relayPin == nil && session.source != "daemon" && session.canResume == true,
                    isResuming: store.resumingSessions.contains(ResumeSessionKey(
                        machineID: machine.id,
                        sessionID: session.sessionId
                    )),
                    resumeIdentity: session.source == "daemon" ? nil : String(session.sessionId.prefix(8)),
                    resumeError: machine.endpoint.relayPin != nil && session.source != "daemon"
                        ? "Resume this session on the machine. Relay Resume is unavailable."
                        : store.resumeErrorsBySession[ResumeSessionKey(
                        machineID: machine.id,
                        sessionID: session.sessionId
                    )]
                )
            }
        }
    }

    private var allQuestions: [RemiQuestionCardModel] {
        let active = store.machines.flatMap { machine in
            machine.questions.map { presentation($0, machine: machine) }
        }
        let resolved: [RemiQuestionCardModel] = store.recentlyResolvedQuestions.compactMap { record in
            guard let machine = store.machines.first(where: { $0.id == record.machineID }) else {
                return nil
            }
            return presentation(
                record.message,
                machine: machine,
                state: .resolvedElsewhere(resolutionSource(record.resolvedBy))
            )
        }
        return active + resolved
    }

    private var activeQuestionIDs: Set<String> {
        Set(store.machines.flatMap { machine in
            machine.questions.map { message in
                RemiQuestionCardModel.identity(
                    machineID: machine.id,
                    sessionID: message.sessionId,
                    questionID: message.question.id
                )
            }
        })
    }

    private func questions(_ sessionId: String) -> [RemiQuestionCardModel] {
        let active = store.machines.flatMap { machine in
            machine.questions.filter { $0.sessionId == sessionId }.map {
                presentation($0, machine: machine)
            }
        }
        let resolved: [RemiQuestionCardModel] = store.recentlyResolvedQuestions.compactMap { record in
            guard record.message.sessionId == sessionId,
                  let machine = store.machines.first(where: { $0.id == record.machineID })
            else { return nil }
            return presentation(
                record.message,
                machine: machine,
                state: .resolvedElsewhere(resolutionSource(record.resolvedBy))
            )
        }
        return active + resolved
    }

    private func presentation(
        _ message: QuestionMessage,
        machine: MachineState,
        state: RemiQuestionState = .pending
    ) -> RemiQuestionCardModel {
        let question = message.question
        let kind = RemiQuestionKind(wireValue: question.kind)
        return RemiQuestionCardModel(
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
            sessionID: message.sessionId,
            sessionName: machine.sessions.first(where: { $0.sessionId == message.sessionId })?.name
                ?? message.sessionId,
            agentID: question.agentId,
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
                            isRecommended: option.isRecommended
                        )
                    }
                )
            },
            terminalOnly: question.terminalOnly == true
                || question.answerPath == QuestionAnswerPath.none
                || question.hasUnknownAnswerPath,
            answerPath: answerPath(question.answerPath),
            state: state
        )
    }

    private func answerPath(_ value: QuestionAnswerPath?) -> RemiAnswerPath? {
        switch value {
        case .some(.structured): .structured
        case .some(.keystroke): .keystroke
        case .some(.none): RemiAnswerPath.none
        case nil: nil
        }
    }

    private func resolutionSource(_ value: QuestionResolvedBy?) -> RemiResolutionSource? {
        switch value {
        case .phone: .phone
        case .lockscreen: .lockscreen
        case .terminal: .terminal
        case .harness: .harness
        case .timeout: .timeout
        case nil: nil
        }
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

    private func sendChat(sessionId: String, content: String) async -> Bool {
        let binding = store.machines.lazy.flatMap(\.sessions)
            .first { $0.sessionId == sessionId }?.claudeSessionId
        return await store.sendChat(sessionId: sessionId, content: content, claudeSessionId: binding)
    }

    private func addMachine(_ endpoint: MachineEndpoint) {
        relayNotifications.machineWillChange(endpoint)
        if let existing = store.machines.first(where: { $0.id == endpoint.id }) {
            guard store.removeMachine(existing.endpoint) else { return }
            relayNotifications.didForget(existing.endpoint)
        }
        store.addMachine(endpoint)
        MachineConfigurationStore.shared.save(store.persistableEndpoints)
    }

    private func removeMachine(_ machineID: String) {
        guard let machine = store.machines.first(where: { $0.id == machineID }) else { return }
        relayNotifications.machineWillChange(machine.endpoint)
        if store.removeMachine(machine.endpoint) { relayNotifications.didForget(machine.endpoint) }
        MachineConfigurationStore.shared.save(store.persistableEndpoints)
    }

    private func createSession(
        endpoint: MachineEndpoint,
        directory: String,
        harness: String,
        args: [String],
        workspace: WorkspaceRequest?
    ) {
        store.createSession(
            on: endpoint,
            directory: directory,
            harness: harness,
            args: args,
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

    private func destination(forQuestionIdentity id: String) -> RemiNavigationDestination? {
        for machine in store.machines {
            if let message = machine.questions.first(where: {
                RemiQuestionCardModel.identity(
                    machineID: machine.id,
                    sessionID: $0.sessionId,
                    questionID: $0.question.id
                ) == id
            }) {
                return RemiNavigationDestination(
                    machineID: machine.id,
                    sessionID: message.sessionId,
                    questionID: message.question.id,
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
        present(destination)
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
                viewsLoaded: store.sessionViewsBySession[session.id] != nil,
                initialConversationID: destination.agentID,
                initialQuestionID: destination.questionID,
                transcriptForView: transcript,
                onSelectView: store.loadTranscript,
                onAnswer: { answer(sessionId: session.id, questionId: $0, value: $1) },
                onSubmit: { submit(sessionId: session.id, questionId: $0, values: $1) },
                onCancel: { cancel(sessionId: session.id, questionId: $0) },
                onSend: { await sendChat(sessionId: session.id, content: $0) },
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
        case .waitingForApproval, .waitingForRelayConfirmation: .waitingForApproval
        case .disconnected, .unavailable: .unreachable
        }
    }
}
