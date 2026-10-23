import RemiKit
import RemiUI
import SwiftUI

/// A sheet the shell presents over any destination.
enum PhoneShellSheet: Identifiable {
    case newSession(machineID: String?, repository: String?)
    case pairing
    case preferences
    case machines
    /// A relay notification question. One presentation with the others: two `.sheet`
    /// modifiers on one host cannot both be up.
    case relayNotification

    var id: String {
        switch self {
        case .newSession: "newSession"
        case .pairing: "pairing"
        case .preferences: "preferences"
        case .machines: "machines"
        case .relayNotification: "relayNotification"
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
    @State private var relayNotifications = NativeRelayNotifications.shared
    @AppStorage(PhonePreferenceKey.haptics) private var hapticsEnabled = true
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    /// The sidebar's visibility at regular width; the Mac column helpers remember the
    /// visible layout while it is hidden.
    @State private var columnLayout = RemiMacColumnLayout(visibility: .all, expandedVisibility: .all)

    private var layoutMode: RemiLayoutMode {
        RemiLayoutMode.resolve(horizontalSizeClass: horizontalSizeClass)
    }

    private var chrome: RemiShellChrome { RemiShellChrome.resolve(mode: layoutMode) }

    private var columnVisibility: Binding<NavigationSplitViewVisibility> {
        Binding(
            get: { columnLayout.visibility },
            set: { visibility in
                let expanded = visibility == .detailOnly ? columnLayout.expandedVisibility : visibility
                columnLayout = RemiMacColumnLayout(visibility: visibility, expandedVisibility: expanded)
            }
        )
    }

    var body: some View {
        // Worked out once per pass and handed down: building them is the costly part of a
        // store tick, and the drawer, the Inbox and the session all need them.
        let sessions = allSessions
        let machines = machineSummaries
        return rootLayout(sessions: sessions, machines: machines)
        .onChange(of: layoutMode, initial: true) { _, mode in
            shell.layoutModeChanged(to: mode)
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
        .onChange(of: relayNotifications.presentsRelayNotification, initial: true) { _, presents in
            if presents {
                activeSheet = .relayNotification
            } else if case .relayNotification = activeSheet {
                activeSheet = nil
            }
        }
        .onChange(of: activeSheet?.id) { old, new in
            // However the panel went away (swipe, Close, another sheet), tell the store.
            if old == PhoneShellSheet.relayNotification.id, new != old {
                relayNotifications.closeNotification()
            }
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
            guard let destination else { return }
            // Lands only while this resume is still pending: any navigation the person made
            // since clears it (PhoneShellState), and then the landing must not move them.
            shell.landResume(
                ResumeSessionKey(machineID: destination.machineID, sessionID: destination.requestedSessionID),
                at: PhoneSessionRoute(machineKey: destination.machineID, sessionID: destination.sessionID)
            )
            store.consumeResumedSessionDestination(id: destination.id)
        }
    }

    /// Compact: the drawer over the content. Regular: the same drawer content as a
    /// persistent sidebar beside the same destination content.
    @ViewBuilder
    private func rootLayout(sessions: [RemiSessionSummary], machines: [RemiMachineSummary]) -> some View {
        if let sidebar = chrome.sidebarEnvironment {
            NavigationSplitView(columnVisibility: columnVisibility) {
                drawerContent(sessions: sessions, machines: machines)
                    .environment(\.phoneDrawerBlocksTaps, sidebar.blocksTaps)
                    .environment(\.phoneDrawerOrderFrozen, sidebar.orderFrozen)
                    .environment(\.phoneDrawerIsOpen, sidebar.isOpen)
                    .environment(\.phoneDrawerShowsCloseButton, chrome.showsDrawerCloseButton)
                    .toolbar(.hidden, for: .navigationBar)
                    .navigationSplitViewColumnWidth(RemiTheme.Size.sidebarWidth)
            } detail: {
                shellContent(sessions: sessions, machines: machines)
            }
            .navigationSplitViewStyle(.balanced)
        } else {
            PhoneShell(state: $shell, chrome: chrome) {
                shellContent(sessions: sessions, machines: machines)
            } drawer: {
                drawerContent(sessions: sessions, machines: machines)
            }
        }
    }

    private func shellContent(sessions: [RemiSessionSummary], machines: [RemiMachineSummary]) -> some View {
        // Built here, before the NavigationStack. Doing it this way made the Inbox refresh
        // live when a machine changes state; building it inside the stack's closure did
        // not. The mechanism is not verified (#1592).
        let destination = destinationContent(sessions: sessions, machines: machines)
        return NavigationStack {
            destination
                .toolbar {
                    if chrome.showsMenuButton {
                        ToolbarItem(placement: .topBarLeading) { menuButton }
                    }
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
    private func destinationContent(sessions: [RemiSessionSummary], machines: [RemiMachineSummary]) -> some View {
        switch shell.destination {
        case .inbox:
            inboxContent(sessions: sessions, machines: machines)
        case .session(let route):
            sessionContent(route, sessions: sessions)
        }
    }

    private func inboxContent(sessions: [RemiSessionSummary], machines: [RemiMachineSummary]) -> some View {
        InboxScreen(
            questions: allQuestions,
            sessions: sessions,
            machines: machines,
            sessionMachines: store.machines,
            errorMessage: store.latestOperationError ?? store.latestError?.message,
            noticeMessage: store.latestOperationNotice ?? relayNotifications.notice ?? store.relayNotificationNotice,
            onAnswer: { answer(machineID: $0, sessionId: $1, questionId: $2, value: $3) },
            onSubmit: { submit(machineID: $0, sessionId: $1, questionId: $2, values: $3) },
            onCancel: { cancel(machineID: $0, sessionId: $1, questionId: $2) },
            onNewSession: { activeSheet = .newSession(machineID: nil, repository: nil) },
            onOpenQuestionSession: openQuestionSession,
            onPresentPairing: { activeSheet = .pairing },
            onPresentPreferences: { activeSheet = .preferences },
            onManageMachines: { activeSheet = .machines },
            onDismissError: store.clearLatestError,
            onDismissNotice: dismissNotice
        )
    }

    private func drawerContent(sessions: [RemiSessionSummary], machines: [RemiMachineSummary]) -> some View {
        PhoneDrawerView(
            sessions: sessions,
            machines: machines,
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
        store.loadTranscript(machineID: session.machineID, sessionId: session.id)
        shell.selectSession(machineKey: session.machineID, sessionID: session.id)
    }

    /// Navigates to the conversation of `target` and focuses its question. It never answers.
    private func openQuestionSession(_ target: RemiInboxPresentation.OpenTarget, questionID: String) {
        store.loadTranscript(machineID: target.machineID, sessionId: target.sessionID)
        // Opening a subagent conversation of the session already on screen changes the
        // route's conversation id on purpose (the screen must show that conversation); the
        // same route is a no-op.
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
                machineLabels: RemiMachineStripPresentation.uniqueLabels(for: machineSummaries),
                preferredMachineID: machineID,
                preferredRepository: repository,
                onCreate: createSession
            )
        case .pairing:
            pairingScreen { activeSheet = nil }
                .presentationSizing(.form)
        case .preferences:
            PhonePreferencesSheet(publicIdentity: store.publicIdentity)
        case .relayNotification:
            RelayNotificationPanel(store: store, onClose: relayNotifications.closeNotification)
                .presentationSizing(.form)
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
            .presentationSizing(.form)
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

    private func questions(machineID: String, sessionID sessionId: String) -> [RemiQuestionCardModel] {
        guard let owner = store.machine(withIdentifier: machineID) else { return [] }
        let active = owner.questions.filter { $0.sessionId == sessionId }.map {
            presentation($0, machine: owner)
        }
        let resolved: [RemiQuestionCardModel] = store.recentlyResolvedQuestions.compactMap { record in
            guard record.message.sessionId == sessionId, record.machineID == owner.id,
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

    private func transcript(machineID: String, sessionID: String) -> [RemiTranscriptEntry] {
        (store.transcriptsBySession[store.sessionKey(machineID: machineID, sessionID: sessionID)] ?? []).compactMap { message in
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

    private func answer(machineID: String, sessionId: String, questionId: String, value: String) {
        answerFeedbackTrigger += 1
        store.answer(
            machineID: machineID,
            sessionId: sessionId,
            questionId: questionId,
            answer: value,
            claudeSessionId: rawQuestion(machineID: machineID, questionId)?.claudeSessionId
        )
    }

    private func submit(
        machineID: String,
        sessionId: String,
        questionId: String,
        values: [RemiQuestionStepSelection]
    ) {
        answerFeedbackTrigger += 1
        store.answer(
            machineID: machineID,
            sessionId: sessionId,
            questionId: questionId,
            answer: "",
            claudeSessionId: rawQuestion(machineID: machineID, questionId)?.claudeSessionId,
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

    private func cancel(machineID: String, sessionId: String, questionId: String) {
        answerFeedbackTrigger += 1
        store.answer(
            machineID: machineID,
            sessionId: sessionId,
            questionId: questionId,
            answer: "",
            claudeSessionId: rawQuestion(machineID: machineID, questionId)?.claudeSessionId,
            cancel: true
        )
    }

    private func sendChat(machineID: String, sessionId: String, content: String) async -> Bool {
        let binding = store.machine(withIdentifier: machineID)?.sessions
            .first { $0.sessionId == sessionId }?.claudeSessionId
        return await store.sendChat(machineID: machineID, sessionId: sessionId, content: content, claudeSessionId: binding)
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

    private func resumeSession(machineID: String, sessionID: String) {
        guard let machine = store.machine(withIdentifier: machineID) else { return }
        shell.beginResume(ResumeSessionKey(machineID: machine.id, sessionID: sessionID))
        store.resumeSession(on: machine.endpoint, sessionId: sessionID)
    }

    private func rawQuestion(machineID: String, _ id: String) -> QuestionMessage? {
        store.machine(withIdentifier: machineID)?.questions.first { $0.question.id == id }
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
        // A sheet would hide the session this notification opens.
        activeSheet = nil
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
    private func sessionContent(_ route: PhoneSessionRoute, sessions: [RemiSessionSummary]) -> some View {
        if let machine = store.machine(withIdentifier: route.machineKey),
           let session = sessions.first(where: { $0.machineID == machine.id && $0.id == route.sessionID }) {
            sessionScreen(session, route: route)
        } else if store.machine(withIdentifier: route.machineKey) == nil {
            // The machine was removed: nothing can bring this session back, so leave at
            // once. A known machine whose session is briefly missing keeps the grace period.
            Color.clear.onAppear { shell.sessionVanished(route) }
        } else {
            reconnectingPlaceholder(route)
        }
    }

    private func sessionScreen(_ session: RemiSessionSummary, route: PhoneSessionRoute) -> some View {
        let focus = shell.focusQuestionID(for: route)
        let viewsKey = store.sessionKey(machineID: session.machineID, sessionID: session.id)
        return SessionScreen(
            session: session,
            transcript: transcript(machineID: session.machineID, sessionID: session.id),
            questions: questions(machineID: session.machineID, sessionID: session.id),
            views: store.sessionViewsBySession[viewsKey] ?? [],
            viewsLoaded: store.sessionViewsBySession[viewsKey] != nil,
            isLoadingTranscript: { store.isLoadingTranscript(machineID: session.machineID, sessionID: $0) },
            initialConversationID: route.conversationID,
            initialQuestionID: focus,
            transcriptForView: { transcript(machineID: session.machineID, sessionID: $0) },
            onSelectView: { store.loadTranscript(machineID: session.machineID, sessionId: $0) },
            onAnswer: { answer(machineID: session.machineID, sessionId: session.id, questionId: $0, value: $1) },
            onSubmit: { submit(machineID: session.machineID, sessionId: session.id, questionId: $0, values: $1) },
            onCancel: { cancel(machineID: session.machineID, sessionId: session.id, questionId: $0) },
            onSend: { await sendChat(machineID: session.machineID, sessionId: session.id, content: $0) },
            onTerminate: { store.terminateSession(machineID: session.machineID, sessionId: session.id) },
            onClose: { shell.select(.inbox) },
            focusQuestionRequest: focus
        )
        .id(route)
        .onAppear {
            store.loadTranscript(machineID: session.machineID, sessionId: route.conversationID ?? session.id)
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
