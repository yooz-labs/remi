import RemiKit
import RemiUI
import SwiftUI

struct MacLiveRootView: View {
    let store: MachineStore

    @AppStorage("remi.mac.selected-machine") private var selectedMachineID = ""
    @AppStorage("remi.mac.selected-session") private var selectedSessionID = ""
    @State private var showingNewSession = false
    @State private var showingAddMachine = false
    @State private var pendingMachineRemoval: MachineState?
    @State private var notificationRouter = MacNotificationRouter.shared
    @State private var notificationDestination: RemiNavigationDestination?
    @State private var pendingResume: ResumeSessionKey?
    @State private var relayNotifications = NativeRelayNotifications.shared
    @State private var columnVisibility = NavigationSplitViewVisibility.all
    @State private var expandedColumnVisibility = NavigationSplitViewVisibility.all

    private var mainContent: some View {
        Group {
            if store.machines.isEmpty {
                MacFirstRunView(onAddMachine: { showingAddMachine = true })
            } else {
                NavigationSplitView(columnVisibility: $columnVisibility) {
                    List(store.machines, selection: machineSelection) { machine in
                        RemiMachineRow(machine: machinePresentation(machine))
                            .tag(machine.id)
                            .contextMenu {
                                if machine.endpoint.relayPin != nil {
                                    Button("Enable relay notifications", systemImage: "bell.badge") {
                                        relayNotifications.enable(on: machine.endpoint)
                                    }
                                    .disabled(relayNotifications.enabling || !store.persistableEndpoints.contains(machine.endpoint))
                                }
                                Button("Remove machine", systemImage: "trash", role: .destructive) {
                                    pendingMachineRemoval = machine
                                }
                            }
                    }
                    .navigationSplitViewColumnWidth(min: 210, ideal: 240, max: 300)
                    .navigationTitle("Remi")
                    .toolbar {
                        if #available(macOS 26.1, *) {
                            ToolbarItem {
                                Button {
                                    showingAddMachine = true
                                } label: {
                                    Label("Add machine", systemImage: "plus")
                                }
                                .keyboardShortcut("n", modifiers: [.command, .shift])
                                .help("Add another Remi machine")
                            }
                            .visibilityPriority(.high)
                        } else {
                            ToolbarItem {
                                Button {
                                    showingAddMachine = true
                                } label: {
                                    Label("Add machine", systemImage: "plus")
                                }
                                .keyboardShortcut("n", modifiers: [.command, .shift])
                                .help("Add another Remi machine")
                            }
                        }
                    }
                } content: {
                    MacSessionsColumn(
                        machine: selectedMachine,
                        sessions: visibleSessions,
                        selection: sessionSelection,
                        onResume: resume,
                        onRetryApproval: store.retryApproval,
                        onNewSession: { showingNewSession = true }
                    )
                    .navigationSplitViewColumnWidth(min: 380, ideal: 440, max: 540)
                    .navigationTitle("Sessions")
                    .toolbar {
                        if #available(macOS 26.1, *) {
                            ToolbarItem {
                                Button {
                                    showingNewSession = true
                                } label: {
                                    Label("New session", systemImage: "plus")
                                }
                                .keyboardShortcut("n", modifiers: .command)
                                .help("Start a new session")
                                .disabled(sessionCreationMachines.isEmpty)
                            }
                            .visibilityPriority(.high)
                        } else {
                            ToolbarItem {
                                Button {
                                    showingNewSession = true
                                } label: {
                                    Label("New session", systemImage: "plus")
                                }
                                .keyboardShortcut("n", modifiers: .command)
                                .help("Start a new session")
                                .disabled(sessionCreationMachines.isEmpty)
                            }
                        }
                    }
                } detail: {
                    if let session = visibleSessions.first(where: { $0.id == selectedSessionID }),
                       session.canResume {
                        ContentUnavailableView {
                            Label("Stored session", systemImage: "clock.arrow.circlepath")
                        } description: {
                            Text("Resume this session on the machine to continue its conversation.")
                        } actions: {
                            Button(session.isResuming ? "Resuming…" : "Resume session") {
                                resume(session)
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(session.isResuming)
                        }
                    } else if let session = visibleSessions.first(where: { $0.id == selectedSessionID }) {
                        MacSessionDetail(
                            session: session,
                            transcript: transcript(for: session.id),
                            questions: questions(for: session.id),
                            views: store.sessionViewsBySession[session.id] ?? [],
                            initialConversationID: notificationDestination?.agentID,
                            transcriptForView: transcript,
                            onSelectView: store.loadTranscript,
                            onAnswer: { questionId, value in
                                store.answer(
                                    sessionId: session.id,
                                    questionId: questionId,
                                    answer: value,
                                    claudeSessionId: rawQuestion(id: questionId)?.claudeSessionId
                                )
                            },
                            onSubmit: { questionId, selections in
                                store.answer(
                                    sessionId: session.id,
                                    questionId: questionId,
                                    answer: "",
                                    claudeSessionId: rawQuestion(id: questionId)?.claudeSessionId,
                                    selections: selections.compactMap { selection in
                                        guard let questionIndex = Int(selection.stepID) else { return nil }
                                        return AnswerSelection(
                                            questionIndex: questionIndex,
                                            optionIndices: selection.optionIDs.compactMap(Int.init).sorted(),
                                            text: selection.text
                                        )
                                    }
                                )
                            },
                            onCancel: { questionId in
                                store.answer(
                                    sessionId: session.id,
                                    questionId: questionId,
                                    answer: "",
                                    claudeSessionId: rawQuestion(id: questionId)?.claudeSessionId,
                                    cancel: true
                                )
                            },
                            onSend: { content in
                                let binding = selectedMachine?.sessions
                                    .first { $0.sessionId == session.id }?.claudeSessionId
                                store.sendChat(
                                    sessionId: session.id,
                                    content: content,
                                    claudeSessionId: binding
                                )
                            },
                            onTerminate: { store.terminateSession(sessionId: session.id) }
                        )
                        .id(notificationDestination?.agentID ?? session.id)
                        .task(id: session.id) { store.loadTranscript(sessionId: session.id) }
                    } else if notificationDestination != nil {
                        ContentUnavailableView(
                            "Conversation unavailable",
                            systemImage: "bubble.left.and.bubble.right",
                            description: Text("The session may have ended or the machine may be offline.")
                        )
                    } else {
                        MacSelectSessionState(
                            canCreateSession: !sessionCreationMachines.isEmpty,
                            onNewSession: { showingNewSession = true }
                        )
                    }
                }
                .toolbar {
                    ToolbarItemGroup(placement: .navigation) {
                        Button {
                            toggleMachineColumn()
                        } label: {
                            Label("Toggle machines", systemImage: "sidebar.leading")
                        }
                        .labelStyle(.iconOnly)
                        .keyboardShortcut("1", modifiers: [.command, .control])
                        .help("Show or hide machines (Control-Command-1)")

                        Button {
                            toggleSessionColumn()
                        } label: {
                            Label("Focus conversation", systemImage: "rectangle.split.3x1")
                        }
                        .labelStyle(.iconOnly)
                        .keyboardShortcut("2", modifiers: [.command, .control])
                        .help("Show or hide both navigation columns (Control-Command-2)")
                    }
                }
            }
        }
    }

    var body: some View {
        // Split columns can paint beneath a root safe-area inset on Mac (#1141).
        VStack(spacing: 0) {
            feedbackBanner
            mainContent
        }
        .task {
            reconcileNavigation()
        }
        .onChange(of: store.persistableEndpoints) { _, endpoints in
            MachineConfigurationStore.shared.save(endpoints)
            relayNotifications.reconcileEndpoints()
        }
        .onChange(of: navigationSnapshot, initial: true) { _, _ in
            reconcileNavigation()
        }
        .onChange(of: notificationRouter.destination, initial: true) { _, destination in
            guard let destination else { return }
            pendingResume = nil
            notificationDestination = destination
            selectedMachineID = destination.machineID
            selectedSessionID = destination.sessionID
            store.loadTranscript(sessionId: destination.agentID ?? destination.sessionID)
            notificationRouter.destination = nil
        }
        .onChange(of: store.resumedSessionDestination) { _, destination in
            guard let destination,
                  pendingResume == ResumeSessionKey(
                    machineID: destination.machineID,
                    sessionID: destination.requestedSessionID
                  ),
                  selectedMachineID == destination.machineID,
                  selectedSessionID == destination.requestedSessionID
            else { return }
            pendingResume = nil
            selectedMachineID = destination.machineID
            selectedSessionID = destination.sessionID
            store.consumeResumedSessionDestination(id: destination.id)
        }
        .sheet(isPresented: $showingAddMachine) {
            MacAddMachineSheet { endpoint in
                relayNotifications.machineWillChange(endpoint)
                if let existing = store.machines.first(where: { $0.id == endpoint.id }) {
                    guard store.removeMachine(existing.endpoint) else { return }
                    relayNotifications.didForget(existing.endpoint)
                }
                store.addMachine(endpoint)
                MachineConfigurationStore.shared.save(store.persistableEndpoints)
            }
        }
        .sheet(isPresented: $relayNotifications.presentsRelayNotification, onDismiss: relayNotifications.closeNotification) {
            RelayNotificationPanel(store: store, onClose: relayNotifications.closeNotification)
                .frame(minWidth: 440, minHeight: 320)
        }
        .sheet(isPresented: $showingNewSession) {
            MacLiveNewSessionSheet(
                machines: sessionCreationMachines,
                recentRepositories: store.recentRepositoriesByMachine
            ) { endpoint, directory, harness, args, workspace in
                store.createSession(
                    on: endpoint,
                    directory: directory,
                    harness: harness,
                    args: args,
                    workspace: workspace
                )
            }
        }
        .confirmationDialog(
            "Remove \(pendingMachineRemoval?.displayName ?? "machine")?",
            isPresented: Binding(
                get: { pendingMachineRemoval != nil },
                set: { if !$0 { pendingMachineRemoval = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Remove machine", role: .destructive) {
                guard let machine = pendingMachineRemoval else { return }
                relayNotifications.machineWillChange(machine.endpoint)
                if store.removeMachine(machine.endpoint) { relayNotifications.didForget(machine.endpoint) }
                relayNotifications.reconcileEndpoints()
                MachineConfigurationStore.shared.save(store.persistableEndpoints)
                pendingMachineRemoval = nil
                reconcileNavigation()
            }
            Button("Cancel", role: .cancel) { pendingMachineRemoval = nil }
        } message: {
            Text("Remi will forget this endpoint and its cached conversations on this Mac. Sessions on the machine keep running.")
        }
    }

    @ViewBuilder private var feedbackBanner: some View {
        if let message = notificationRouter.notice {
            MacFeedbackBanner(message: message, isError: true, onDismiss: { notificationRouter.notice = nil })
        } else if let message = store.latestOperationError ?? store.latestError?.message {
            MacFeedbackBanner(message: message, isError: true, onDismiss: store.clearLatestError)
        } else if let message = store.latestOperationNotice {
            MacFeedbackBanner(message: message, isError: false, onDismiss: store.clearLatestError)
        } else if let message = relayNotifications.notice {
            MacFeedbackBanner(message: message, isError: false, onDismiss: relayNotifications.clearNotice)
        } else if let message = store.relayNotificationNotice {
            MacFeedbackBanner(message: message, isError: false, onDismiss: store.clearRelayNotificationNotice)
        }
    }

    private var selectedMachine: MachineState? {
        store.machines.first { $0.id == selectedMachineID } ?? store.machines.first
    }

    private var machineSelection: Binding<String?> {
        Binding(
            get: { selectedMachineID.isEmpty ? nil : selectedMachineID },
            set: { newValue in
                let next = newValue ?? ""
                guard next != selectedMachineID else { return }
                selectedMachineID = next
                selectedSessionID = ""
                pendingResume = nil
                notificationDestination = nil
                reconcileNavigation()
            }
        )
    }

    private var sessionSelection: Binding<String?> {
        Binding(
            get: { selectedSessionID.isEmpty ? nil : selectedSessionID },
            set: {
                selectedSessionID = $0 ?? ""
                if pendingResume?.machineID != selectedMachineID
                    || pendingResume?.sessionID != selectedSessionID {
                    pendingResume = nil
                }
                notificationDestination = nil
            }
        )
    }

    private var navigationSnapshot: [[String]] {
        store.machines.map { machine in
            [machine.id, machine.hasLoadedSessions ? "loaded" : "loading"]
                + machine.activeSessions.map(\.sessionId)
        }
    }

    private func reconcileNavigation() {
        if let destination = notificationDestination {
            guard let machine = store.machines.first(where: { $0.id == destination.machineID }) else {
                return
            }
            selectedMachineID = machine.id
            guard machine.hasLoadedSessions else { return }
            selectedSessionID = machine.activeSessions.contains(where: { $0.sessionId == destination.sessionID })
                ? destination.sessionID : ""
            return
        }
        if !store.machines.contains(where: { $0.id == selectedMachineID }) {
            selectedMachineID = store.machines.first?.id ?? ""
        }
        guard selectedMachine?.hasLoadedSessions == true else { return }
        let sessionIDs = selectedMachine?.sessions.map(\.sessionId) ?? []
        if !sessionIDs.contains(selectedSessionID) {
            selectedSessionID = sessionIDs.first ?? ""
        }
    }

    private var sessionCreationMachines: [MachineState] {
        store.machines.filter { $0.status == .connected }
    }

    private func machinePresentation(_ machine: MachineState) -> RemiMachineSummary {
        RemiMachineSummary(
            id: machine.id,
            name: machine.displayName,
            address: machine.endpoint.displayAddress,
            reachability: reachability(machine.status),
            transport: machine.endpoint.relayPin != nil ? .relay
                : isLoopback(machine.endpoint.host) ? .local : .direct,
            sessionCount: machine.activeSessions.count
        )
    }

    private func reachability(_ status: MachineConnectionStatus) -> RemiMachineReachability {
        switch status {
        case .connected: .connected
        case .connecting: .connecting
        case .waitingForApproval, .waitingForRelayConfirmation: .waitingForApproval
        case .disconnected, .unavailable: .unreachable
        }
    }

    private func isLoopback(_ host: String) -> Bool {
        ["127.0.0.1", "::1", "localhost"].contains(host.lowercased())
    }

    private func toggleMachineColumn() {
        if columnVisibility == .all {
            columnVisibility = .doubleColumn
            expandedColumnVisibility = .doubleColumn
        } else if columnVisibility == .doubleColumn {
            columnVisibility = .all
            expandedColumnVisibility = .all
        } else {
            columnVisibility = .all
            expandedColumnVisibility = .all
        }
    }

    private func toggleSessionColumn() {
        if columnVisibility == .detailOnly {
            columnVisibility = expandedColumnVisibility
        } else {
            if columnVisibility == .all || columnVisibility == .doubleColumn {
                expandedColumnVisibility = columnVisibility
            }
            columnVisibility = .detailOnly
        }
    }

    private var visibleSessions: [RemiSessionSummary] {
        guard let machine = selectedMachine else { return [] }
        return machine.sessions.filter { $0.source == "daemon" || $0.canResume == true }.map { session in
            let questionCount = machine.questions.count { $0.sessionId == session.sessionId }
            return RemiSessionSummary(
                id: session.sessionId,
                machineID: machine.id,
                machineName: machine.displayName,
                name: session.name ?? URL(fileURLWithPath: session.projectPath).lastPathComponent,
                harness: session.harness ?? "claude",
                project: URL(fileURLWithPath: session.projectPath).lastPathComponent,
                status: session.source == "daemon"
                    ? (questionCount > 0 ? .needsYou : status(for: session.status))
                    : .offline,
                lastMessage: session.lastMessage,
                openQuestionCount: questionCount,
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

    private func resume(_ session: RemiSessionSummary) {
        guard let machine = store.machines.first(where: { $0.id == session.machineID }) else { return }
        selectedMachineID = machine.id
        selectedSessionID = session.id
        pendingResume = ResumeSessionKey(machineID: machine.id, sessionID: session.id)
        store.resumeSession(on: machine.endpoint, sessionId: session.id)
    }

    private func questions(for sessionId: String) -> [RemiQuestionCardModel] {
        guard let machine = selectedMachine else { return [] }
        let active = machine.questions.filter { $0.sessionId == sessionId }.map { message in
            questionPresentation(message, machine: machine)
        }
        let resolved: [RemiQuestionCardModel] = store.recentlyResolvedQuestions.compactMap { record in
            guard record.machineID == machine.id, record.message.sessionId == sessionId else {
                return nil
            }
            return questionPresentation(
                record.message,
                machine: machine,
                state: .resolvedElsewhere(resolutionSource(record.resolvedBy))
            )
        }
        return active + resolved
    }

    private func questionPresentation(
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
                sessionName: visibleSessions.first(where: { $0.id == message.sessionId })?.name
                    ?? message.sessionId,
                options: question.options.map { option in
                    RemiQuestionOption(
                        id: option.value,
                        label: option.label,
                        detail: option.description,
                        role: kind.optionRole(isYes: option.isYes, isNo: option.isNo),
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
                                role: .neutral,
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

    private func transcript(for sessionId: String) -> [RemiTranscriptEntry] {
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

    private func rawQuestion(id: String) -> QuestionMessage? {
        selectedMachine?.questions.first { $0.question.id == id }
    }

    private func status(for value: String) -> RemiSessionStatus {
        switch value {
        case "active": .working
        case "idle": .idle
        default: .offline
        }
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

}

private struct MacSessionsColumn: View {
    let machine: MachineState?
    let sessions: [RemiSessionSummary]
    @Binding var selection: String?
    let onResume: (RemiSessionSummary) -> Void
    let onRetryApproval: (MachineEndpoint) -> Void
    let onNewSession: () -> Void

    var body: some View {
        Group {
            if let machine, shouldShowSessions(machine) {
                if sessions.isEmpty {
                    MacNoSessionsState(onNewSession: onNewSession)
                } else {
                    MacSessionList(sessions: sessions, selection: $selection, onResume: onResume)
                }
            } else if let machine {
                MacMachineConnectionState(
                    machine: machine,
                    onRetryApproval: { onRetryApproval(machine.endpoint) }
                )
            } else {
                ContentUnavailableView("Select a machine", systemImage: "desktopcomputer")
            }
        }
    }

    private func shouldShowSessions(_ machine: MachineState) -> Bool {
        machine.hasLoadedSessions && machine.status == .connected
    }
}

private struct MacSessionList: View {
    let sessions: [RemiSessionSummary]
    @Binding var selection: String?
    let onResume: (RemiSessionSummary) -> Void

    var body: some View {
        List(sessions, selection: $selection) { session in
            MacSessionListRow(session: session, onResume: { onResume(session) })
            .tag(session.id)
        }
    }
}

private struct MacSessionListRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let session: RemiSessionSummary
    let onResume: () -> Void

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: RemiTheme.Spacing.s))
            : AnyLayout(HStackLayout(alignment: .center, spacing: RemiTheme.Spacing.s))

        layout {
            RemiSessionRow(session: session)
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
            if session.canResume {
                Button(action: onResume) {
                    if session.isResuming {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("Resume", systemImage: "play.fill")
                    }
                }
                .buttonStyle(.borderedProminent)
                .frame(minHeight: RemiTheme.Size.minimumTapTarget)
                .contentShape(.rect)
                .disabled(session.isResuming)
                .accessibilityLabel(session.isResuming ? "Resuming session" : "Resume session")
            }
        }
    }
}

private struct MacNoSessionsState: View {
    let onNewSession: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("No sessions", systemImage: "bubble.left.and.bubble.right")
        } description: {
            Text("Start an agent session on this machine. It will appear here and stay available as you switch machines.")
        } actions: {
            Button("New session", systemImage: "plus", action: onNewSession)
                .buttonStyle(.borderedProminent)
        }
    }
}

private struct MacSelectSessionState: View {
    let canCreateSession: Bool
    let onNewSession: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Choose a conversation", systemImage: "rectangle.split.3x1")
        } description: {
            Text("Select a session from the middle column, or start a new one on a connected machine.")
        } actions: {
            if canCreateSession {
                Button("New session", systemImage: "plus", action: onNewSession)
                    .buttonStyle(.glassProminent)
            }
        }
    }
}

private struct MacMachineConnectionState: View {
    let machine: MachineState
    let onRetryApproval: () -> Void

    var body: some View {
        switch machine.status {
        case .connecting:
            ContentUnavailableView {
                Label("Connecting to \(machine.displayName)", systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
            } description: {
                Text("Remi will load this machine’s active and resumable sessions when the connection is ready.")
            } actions: {
                ProgressView().controlSize(.small)
            }
        case .waitingForApproval(let fingerprint):
            MacAuthorizationState(
                title: "Authorization needed",
                detail: "Approve this Mac on \(machine.displayName) with fingerprint \(fingerprint), then retry the connection.",
                onRetry: onRetryApproval
            )
        case .waitingForRelayConfirmation(let fingerprint):
            MacAuthorizationState(
                title: "Confirm this Mac",
                detail: "Compare fingerprint \(fingerprint) in the terminal on \(machine.displayName) and complete the pairing approval there.",
                onRetry: nil
            )
        case .unavailable(let reason):
            ContentUnavailableView(
                "Machine unavailable",
                systemImage: "desktopcomputer.trianglebadge.exclamationmark",
                description: Text(reason ?? "Remi will keep trying to reconnect to \(machine.displayName).")
            )
        case .disconnected:
            ContentUnavailableView(
                "Machine offline",
                systemImage: "desktopcomputer.trianglebadge.exclamationmark",
                description: Text("Remi will keep trying to reconnect to \(machine.displayName).")
            )
        case .connected:
            ContentUnavailableView {
                Label("Loading sessions", systemImage: "clock")
            } description: {
                Text("Connected to \(machine.displayName). Waiting for its session list.")
            } actions: {
                ProgressView().controlSize(.small)
            }
        }
    }
}

private struct MacAuthorizationState: View {
    let title: LocalizedStringKey
    let detail: String
    let onRetry: (() -> Void)?

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: "person.badge.clock")
        } description: {
            Text(detail)
                .textSelection(.enabled)
        } actions: {
            if let onRetry {
                Button("Retry connection", systemImage: "arrow.clockwise", action: onRetry)
                    .buttonStyle(.borderedProminent)
            }
        }
    }
}

private struct MacFeedbackBanner: View {
    let message: String
    let isError: Bool
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: RemiTheme.Spacing.s) {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "info.circle.fill")
                .foregroundStyle(isError ? .orange : .blue)
            Text(message)
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Dismiss", systemImage: "xmark", action: onDismiss)
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
        }
        .padding(.horizontal, RemiTheme.Spacing.m)
        .padding(.vertical, RemiTheme.Spacing.s)
        .background((isError ? Color.orange : Color.blue).opacity(0.1))
        .accessibilityElement(children: .combine)
    }
}

private struct MacAddMachineSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var host = "127.0.0.1"
    @State private var port = 18765
    @State private var relayMode = false
    @State private var relayToken = ""
    @State private var relayError: String?
    let onAdd: (MachineEndpoint) -> Void

    var body: some View {
        Form {
            Toggle("Connect over the relay", isOn: $relayMode)
            if relayMode {
                SecureField("Relay pairing token", text: $relayToken)
                Text("Run remi pair --relay on the machine and paste its token. Compare the fingerprint in the terminal before approving. The machine is saved after confirmation.")
                    .font(.footnote).foregroundStyle(.secondary)
                if let relayError { Text(relayError).foregroundStyle(.red) }
            } else {
                TextField("Host or IP address", text: $host)
                TextField("Port", value: $port, format: .number)
            }
            ViewThatFits(in: .horizontal) {
                HStack {
                    Spacer()
                    actionButtons
                }
                VStack(alignment: .trailing, spacing: RemiTheme.Spacing.s) {
                    actionButtons
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(24)
        .frame(
            minWidth: 360,
            idealWidth: dynamicTypeSize.isAccessibilitySize ? 560 : 420,
            maxWidth: 680
        )
    }

    @ViewBuilder private var actionButtons: some View {
        Button("Cancel", role: .cancel) { dismiss() }
        Button("Add") {
            do {
                let endpoint = relayMode ? try MachineEndpoint.pairingOverRelay(relayToken) :
                    MachineEndpoint(host: host.trimmingCharacters(in: .whitespacesAndNewlines), port: port)
                relayToken = ""
                onAdd(endpoint)
                dismiss()
            } catch {
                relayError = "The relay token is invalid or expired. Create a new token on the machine."
            }
        }
        .buttonStyle(.glassProminent)
        .disabled(relayMode ? relayToken.isEmpty :
            host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !(1...65535).contains(port))
    }
}

private struct MacLiveNewSessionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let machines: [MachineState]
    let recentRepositories: [String: [RecentRepository]]
    let onCreate: (MachineEndpoint, String, String, [String], WorkspaceRequest?) -> Void

    @State private var machineID: String?
    @State private var repository = ""
    @State private var harness = "claude"
    @State private var model = ""
    @State private var createsWorktree = false
    @State private var branch = ""
    @State private var base = ""

    init(
        machines: [MachineState],
        recentRepositories: [String: [RecentRepository]],
        onCreate: @escaping (MachineEndpoint, String, String, [String], WorkspaceRequest?) -> Void
    ) {
        self.machines = machines
        self.recentRepositories = recentRepositories
        self.onCreate = onCreate
        _machineID = State(initialValue: machines.first?.id)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.m) {
            Text("New session").font(.title2.weight(.semibold))

            Form {
                Picker("Machine", selection: $machineID) {
                    ForEach(machines) { machine in
                        Text(machine.displayName).tag(Optional(machine.id))
                    }
                }

                if !repositories.isEmpty {
                    Picker("Recent repository", selection: $repository) {
                        Text("Choose a repository").tag("")
                        ForEach(repositories) { item in
                            Text("\(item.name) — \(item.repository)").tag(item.repository)
                        }
                    }
                }

                TextField(workspaceCapable ? "Repository" : "Existing directory", text: $repository)

                if workspaceCapable {
                    Toggle("Create a new branch", isOn: $createsWorktree)
                    if createsWorktree {
                        TextField("Branch", text: $branch)
                        TextField("Base (optional)", text: $base)
                    }
                }

                Picker("Harness", selection: $harness) {
                    ForEach(harnesses, id: \.self) { value in
                        Text(harnessName(value)).tag(value)
                    }
                }
                TextField("Model (optional)", text: $model)
            }

            Text(helperText)
                .font(.footnote)
                .foregroundStyle(.secondary)

            ViewThatFits(in: .horizontal) {
                HStack {
                    Spacer()
                    actionButtons
                }
                VStack(alignment: .trailing, spacing: RemiTheme.Spacing.s) {
                    actionButtons
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(24)
        .frame(
            minWidth: 440,
            idealWidth: dynamicTypeSize.isAccessibilitySize ? 680 : 560,
            maxWidth: 760,
            minHeight: dynamicTypeSize.isAccessibilitySize ? 560 : 420,
            idealHeight: dynamicTypeSize.isAccessibilitySize ? 680 : 520,
            maxHeight: 760
        )
        .onAppear { selectDefaultsForMachine() }
        .onChange(of: machineID) { _, _ in selectDefaultsForMachine() }
    }

    @ViewBuilder private var actionButtons: some View {
        Button("Cancel", role: .cancel) { dismiss() }
        Button("Create") {
            guard let machine = machines.first(where: { $0.id == machineID }) else { return }
            let args = HarnessLaunchArguments.model(model)
            let workspace: WorkspaceRequest?
            if workspaceCapable {
                let worktree = createsWorktree
                    ? WorktreeRequest(
                        branch: trimmedBranch,
                        base: base.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                    )
                    : nil
                workspace = WorkspaceRequest(repository: trimmedRepository, worktree: worktree)
            } else {
                workspace = nil
            }
            onCreate(machine.endpoint, trimmedRepository, harness, args, workspace)
            dismiss()
        }
        .buttonStyle(.glassProminent)
        .disabled(!canCreate)
    }

    private var selectedMachine: MachineState? {
        machines.first { $0.id == machineID }
    }

    private var workspaceCapable: Bool {
        selectedMachine?.capabilities.contains("workspaces") == true
    }

    private var repositories: [RecentRepository] {
        guard let machineID else { return [] }
        return recentRepositories[machineID] ?? []
    }

    private var harnesses: [String] {
        let values = selectedMachine?.harnesses ?? ["claude"]
        return values.isEmpty ? ["claude"] : values
    }

    private var trimmedRepository: String {
        repository.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedBranch: String {
        branch.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canCreate: Bool {
        selectedMachine != nil && !trimmedRepository.isEmpty && (!createsWorktree || !trimmedBranch.isEmpty)
    }

    private var helperText: String {
        if !workspaceCapable {
            return "This machine does not support workspaces yet. Remi will start in the existing directory."
        }
        return createsWorktree
            ? "The machine creates a worktree next to the repository. Remi does not delete it when the session ends."
            : "The session starts in the repository’s main worktree."
    }

    private func selectDefaultsForMachine() {
        if !harnesses.contains(harness) { harness = harnesses[0] }
        if repository.isEmpty, let recent = repositories.first { repository = recent.repository }
        if !workspaceCapable { createsWorktree = false }
    }

    private func harnessName(_ value: String) -> String {
        switch value {
        case "claude": "Claude Code"
        case "codex": "Codex"
        default: value.capitalized
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

#if DEBUG
private var workspacePreviewMachine: MachineState {
    var machine = MachineState(
        endpoint: MachineEndpoint(host: "studio.local", port: 18765),
        displayName: "Studio"
    )
    machine.status = .connected
    machine.capabilities = ["workspaces"]
    machine.harnesses = ["claude", "codex"]
    return machine
}

#Preview("Workspace session") {
    MacLiveNewSessionSheet(
        machines: [workspacePreviewMachine],
        recentRepositories: [
            workspacePreviewMachine.id: [
                RecentRepository(
                    repository: "~/Documents/git/remi",
                    name: "remi",
                    lastUsedAt: "2026-10-07T12:00:00Z"
                ),
            ],
        ],
        onCreate: { _, _, _, _, _ in }
    )
}

#Preview("Workspace session · Accessibility") {
    MacLiveNewSessionSheet(
        machines: [workspacePreviewMachine],
        recentRepositories: [
            workspacePreviewMachine.id: [
                RecentRepository(
                    repository: "~/Documents/git/remi",
                    name: "remi",
                    lastUsedAt: "2026-10-07T12:00:00Z"
                ),
            ],
        ],
        onCreate: { _, _, _, _, _ in }
    )
    .environment(\.dynamicTypeSize, .accessibility5)
}

#Preview("Add machine · Accessibility") {
    MacAddMachineSheet(onAdd: { _ in })
        .environment(\.dynamicTypeSize, .accessibility5)
}
#endif
