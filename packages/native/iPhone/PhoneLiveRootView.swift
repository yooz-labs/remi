import RemiKit
import RemiUI
import SwiftUI

/// A sheet the shell presents over any destination.
enum PhoneShellSheet: Identifiable {
    case newSession(machineID: String?, repository: String?)
    case pairing
    case preferences
    case machines

    var id: String {
        switch self {
        case .newSession: "newSession"
        case .pairing: "pairing"
        case .preferences: "preferences"
        case .machines: "machines"
        }
    }
}

struct PhoneLiveRootView: View {
    let store: MachineStore
    @State private var knownQuestionIDs: Set<String> = []
    @State private var notificationBaselineEstablished = false
    @State private var questionFeedbackTrigger = 0
    @State private var answerFeedbackTrigger = 0
    @State private var notificationRouter = PhoneNotificationRouter.shared
    @State private var shell = PhoneShellState()
    @State private var activeSheet: PhoneShellSheet?
    @State private var pairingAttemptID: UUID?
    @State private var pendingResume: ResumeSessionKey?
    @State private var relayNotifications = NativeRelayNotifications.shared
    @AppStorage(PhonePreferenceKey.haptics) private var hapticsEnabled = true

    var body: some View {
        PhoneShell(state: $shell) {
            shellContent
        } drawer: {
            drawerContent
        }
        .sheet(item: $activeSheet) { sheet in
            sheetContent(sheet)
        }
        .onChange(of: store.pairingAttempts) { _, _ in
            guard let id = pairingAttemptID, let result = store.pairingAttempt(id: id),
                  case .admitted = result.phase else { return }
            // A filter on another machine would hide the one just paired.
            shell.clearFilter()
            pairingAttemptID = nil
        }
        .onChange(of: store.machines.map(\.id), initial: true) { _, ids in
            shell.machinesChanged(ids: ids)
        }
        .onChange(of: store.persistableProfiles) { _, profiles in
            MachineConfigurationStore.shared.saveProfiles(profiles)
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
            shell.select(.session(PhoneSessionRoute(
                machineKey: destination.machineID,
                sessionID: destination.sessionID
            )))
            store.consumeResumedSessionDestination(id: destination.id)
        }
    }

    private var shellContent: some View {
        // Built here, before the NavigationStack. Doing it this way made the Inbox refresh
        // live when a machine changes state; building it inside the stack's closure did
        // not. The mechanism is not verified (#1592).
        let destination = destinationContent
        return NavigationStack {
            destination
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { menuButton }
                }
        }
    }

    // iOS 27 has `topBarPinnedTrailing` only; there is no pinned leading placement.
    private var menuButton: some View {
        Button {
            shell.toggleDrawer()
        } label: {
            Label("Menu", systemImage: "line.3.horizontal")
                .labelStyle(.iconOnly)
                .frame(
                    minWidth: RemiTheme.Size.minimumTapTarget,
                    minHeight: RemiTheme.Size.minimumTapTarget
                )
                .contentShape(.rect)
        }
    }

    @ViewBuilder
    private var destinationContent: some View {
        switch shell.destination {
        case .inbox:
            inboxContent
        case .session(let route):
            sessionContent(route)
        }
    }

    private var inboxContent: some View {
        InboxScreen(
            questions: allQuestions,
            sessions: allSessions,
            machines: machineSummaries,
            sessionMachines: store.machines,
            errorMessage: store.latestOperationError ?? store.latestError?.message,
            noticeMessage: store.latestOperationNotice ?? relayNotifications.notice ?? store.relayNotificationNotice,
            onAnswer: answer,
            onSubmit: submit,
            onCancel: cancel,
            onNewSession: { activeSheet = .newSession(machineID: nil, repository: nil) },
            onOpenQuestionSession: openQuestionSession,
            onPresentPairing: { activeSheet = .pairing },
            onPresentPreferences: { activeSheet = .preferences },
            onManageMachines: { activeSheet = .machines },
            onDismissError: store.clearLatestError,
            onDismissNotice: dismissNotice
        )
    }

    private var drawerContent: some View {
        PhoneDrawerView(
            sessions: allSessions,
            machines: machineSummaries,
            filter: shell.drawerFilter,
            questionCount: store.machines.reduce(0) { $0 + $1.questions.count },
            destination: shell.destination,
            canCreateSession: !availableSessionMachines.isEmpty,
            onClose: { shell.closeDrawer() },
            onSelectAllMachines: { shell.clearFilter() },
            onSelectMachine: { shell.selectMachineFilter($0) },
            onManageMachines: { present(.machines) },
            onResumeSession: resumeSession,
            onNewSessionHere: { present(.newSession(machineID: $0, repository: $1)) },
            onSelectInbox: { shell.select(.inbox) },
            onSelectSession: selectSession,
            onNewSession: { present(.newSession(machineID: shell.filteredMachineKey, repository: nil)) },
            onAddMachine: { present(.pairing) },
            onPreferences: { present(.preferences) }
        )
    }

    private func present(_ sheet: PhoneShellSheet) {
        shell.closeDrawer()
        activeSheet = sheet
    }

    /// `machineKey` is the machine profile id (`MachineState.id`), the id the rest of this
    /// view uses. Switching it to the authenticated machine identity id is a follow-up;
    /// `store.machine(withIdentifier:)` already accepts either.
    private func route(for session: RemiSessionSummary) -> PhoneSessionRoute {
        PhoneSessionRoute(machineKey: session.machineID, sessionID: session.id)
    }

    private func selectSession(_ session: RemiSessionSummary) {
        openSession(session.id)
        shell.select(.session(route(for: session)))
    }

    /// Navigates to the conversation of `target` and focuses its question. It never answers.
    private func openQuestionSession(_ target: RemiInboxPresentation.OpenTarget, questionID: String) {
        openSession(target.sessionID)
        shell.openFromNotification(
            route: PhoneSessionRoute(
                machineKey: target.machineID,
                sessionID: target.sessionID,
                conversationID: target.conversationID
            ),
            questionID: questionID
        )
    }

    @ViewBuilder
    private func sheetContent(_ sheet: PhoneShellSheet) -> some View {
        switch sheet {
        case .newSession(let machineID, let repository):
            PhoneNewSessionSheet(
                machines: availableSessionMachines,
                recentRepositories: store.recentRepositoriesByMachine,
                preferredMachineID: machineID,
                preferredRepository: repository,
                onCreate: createSession
            )
        case .pairing:
            pairingScreen { activeSheet = nil }
        case .preferences:
            PhonePreferencesSheet(publicIdentity: store.publicIdentity)
        case .machines:
            PhoneMachinesSheet(
                machines: machineSummaries,
                states: store.machines,
                publicIdentity: store.publicIdentity,
                enablingRelayNotifications: relayNotifications.enabling,
                onRemove: removeMachine,
                onRetryApproval: store.retryApproval,
                onRetryConnection: store.retryConnection,
                onSetConnectionPreference: { store.setConnectionPreference($1, for: $0) },
                onEnableRelayNotifications: relayNotifications.enable,
                onDone: { activeSheet = nil },
                pairingContent: { close in pairingScreen(onDone: close) }
            )
        }
    }

    /// The pairing screen, shared by the root sheet and the one the Machines sheet hosts.
    private func pairingScreen(onDone: @escaping () -> Void) -> some View {
        NavigationStack {
            PairingScreen(
                publicIdentity: store.publicIdentity,
                machineStates: store.machines,
                pairingAttempts: store.pairingAttempts,
                onCancelPairing: store.cancelPairing,
                onAddMachine: addMachine
            )
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done", action: onDone)
                }
            }
        }
    }

    private var availableSessionMachines: [MachineState] {
        store.machines.filter { $0.status == .connected }
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
                machineIdentityID: machine.machineDescriptor?.id,
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
                    machineIdentityID: session.machineId ?? machine.machineDescriptor?.id,
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
            guard let machine = store.machine(withIdentifier: record.machineID) else {
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
                  let machine = store.machine(withIdentifier: record.machineID)
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
            machineIdentityID: machine.machineDescriptor?.id,
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

    private func addMachine(_ request: AddMachineRequest) -> UUID? {
        switch request {
        case .pairing(let payload, let label):
            let id = store.beginPairing(payload, label: label)
            pairingAttemptID = id
            return id
        case .endpoint(let endpoint):
            // Same reason as a paired machine: do not let a filter hide the new one.
            shell.clearFilter()
            relayNotifications.machineWillChange(endpoint)
            store.addMachine(endpoint)
            MachineConfigurationStore.shared.saveProfiles(store.persistableProfiles)
            return nil
        }
    }

    private func removeMachine(_ machineID: String) {
        guard let machine = store.machine(withIdentifier: machineID) else { return }
        relayNotifications.machineWillChange(machine.endpoint)
        if store.removeMachine(machine.endpoint) { relayNotifications.didForget(machine.endpoint) }
        MachineConfigurationStore.shared.saveProfiles(store.persistableProfiles)
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
        guard let machine = store.machine(withIdentifier: machineID) else { return }
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
        shell.openFromNotification(
            route: PhoneSessionRoute(
                machineKey: destination.machineID,
                sessionID: destination.sessionID,
                conversationID: destination.agentID
            ),
            questionID: destination.questionID
        )
        notificationRouter.destination = nil
    }

    @ViewBuilder
    private func sessionContent(_ route: PhoneSessionRoute) -> some View {
        if let machine = store.machine(withIdentifier: route.machineKey),
           let session = allSessions.first(where: { $0.machineID == machine.id && $0.id == route.sessionID }) {
            sessionScreen(session, route: route)
        } else {
            reconnectingPlaceholder(route)
        }
    }

    private func sessionScreen(_ session: RemiSessionSummary, route: PhoneSessionRoute) -> some View {
        let focus = shell.focusQuestionID(for: route)
        return SessionScreen(
            session: session,
            transcript: transcript(session.id),
            questions: questions(session.id),
            views: store.sessionViewsBySession[session.id] ?? [],
            viewsLoaded: store.sessionViewsBySession[session.id] != nil,
            initialConversationID: route.conversationID,
            initialQuestionID: focus,
            transcriptForView: transcript,
            onSelectView: store.loadTranscript,
            onAnswer: { answer(sessionId: session.id, questionId: $0, value: $1) },
            onSubmit: { submit(sessionId: session.id, questionId: $0, values: $1) },
            onCancel: { cancel(sessionId: session.id, questionId: $0) },
            onSend: { await sendChat(sessionId: session.id, content: $0) },
            onTerminate: { store.terminateSession(sessionId: session.id) },
            onClose: { shell.select(.inbox) },
            focusQuestionRequest: focus
        )
        .id(route)
        .onAppear {
            store.loadTranscript(sessionId: route.conversationID ?? session.id)
        }
        .onChange(of: shell.pendingFocus, initial: true) { _, _ in
            guard shell.focusQuestionID(for: route) != nil else { return }
            // Consume in a later transaction so SessionScreen's own onChange sees the
            // request first.
            Task { @MainActor in _ = shell.consumeFocus(for: route) }
        }
    }

    private func reconnectingPlaceholder(_ route: PhoneSessionRoute) -> some View {
        VStack(spacing: RemiTheme.Spacing.s) {
            ProgressView()
            Text("Reconnecting")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .task(id: route) {
            try? await Task.sleep(for: .seconds(8))
            guard !Task.isCancelled else { return }
            shell.sessionVanished(route)
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
