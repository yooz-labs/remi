import RemiKit
import RemiUI
import SwiftUI
import UIKit

struct HomeScreen: View {
    @State private var showingPairing = false
    @State private var showingNewSession = false
    @State private var showingPreferences = false
    @State private var searchText = ""
    @State private var activityScope = RemiCommandCenterScope.overview
    @State private var machinesExpanded = false
    @State private var newSessionMachineID: String?
    @State private var newSessionRepository: String?
    let questions: [RemiQuestionCardModel]
    let sessions: [RemiSessionSummary]
    let machines: [RemiMachineSummary]
    let sessionMachines: [MachineState]
    let recentRepositories: [String: [RecentRepository]]
    let publicIdentity: PublicClientIdentity?
    @Binding var selectedMachineID: String
    let errorMessage: String?
    let noticeMessage: String?
    let transcriptForSession: (String) -> [RemiTranscriptEntry]
    let questionsForSession: (String) -> [RemiQuestionCardModel]
    let viewsForSession: (String) -> [SessionViewMeta]
    let viewsLoadedForSession: (String) -> Bool
    let onAnswer: (String, String, String) -> Void
    let onSubmit: (String, String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String, String) -> Void
    let onOpenSession: (String) -> Void
    let onSend: (String, String) async -> Bool
    let onTerminateSession: (String) -> Void
    let onResumeSession: (String, String) -> Void
    let onCreateSession: (MachineEndpoint, String, String, [String], WorkspaceRequest?) -> Void
    let onAddMachine: (MachineEndpoint) -> Void
    let onRemoveMachine: (String) -> Void
    let onRetryApproval: (MachineEndpoint) -> Void
    let onRetryConnection: (MachineEndpoint) -> Void
    let onEnableRelayNotifications: (MachineEndpoint) -> Void
    let enablingRelayNotifications: Bool
    let onDismissError: () -> Void
    let onDismissNotice: () -> Void

    init(
        questions: [RemiQuestionCardModel],
        sessions: [RemiSessionSummary],
        machines: [RemiMachineSummary],
        sessionMachines: [MachineState] = [],
        recentRepositories: [String: [RecentRepository]] = [:],
        publicIdentity: PublicClientIdentity? = nil,
        selectedMachineID: Binding<String> = .constant(""),
        errorMessage: String? = nil,
        noticeMessage: String? = nil,
        transcriptForSession: @escaping (String) -> [RemiTranscriptEntry] = { _ in RemiPreviewData.transcript },
        questionsForSession: @escaping (String) -> [RemiQuestionCardModel] = { _ in [] },
        viewsForSession: @escaping (String) -> [SessionViewMeta] = { _ in [] },
        viewsLoadedForSession: @escaping (String) -> Bool = { _ in true },
        onAnswer: @escaping (String, String, String) -> Void = { _, _, _ in },
        onSubmit: @escaping (String, String, [RemiQuestionStepSelection]) -> Void = { _, _, _ in },
        onCancel: @escaping (String, String) -> Void = { _, _ in },
        onOpenSession: @escaping (String) -> Void = { _ in },
        onSend: @escaping (String, String) async -> Bool = { _, _ in true },
        onTerminateSession: @escaping (String) -> Void = { _ in },
        onResumeSession: @escaping (String, String) -> Void = { _, _ in },
        onCreateSession: @escaping (MachineEndpoint, String, String, [String], WorkspaceRequest?) -> Void = { _, _, _, _, _ in },
        onAddMachine: @escaping (MachineEndpoint) -> Void = { _ in },
        onRemoveMachine: @escaping (String) -> Void = { _ in },
        onRetryApproval: @escaping (MachineEndpoint) -> Void = { _ in },
        onRetryConnection: @escaping (MachineEndpoint) -> Void = { _ in },
        onEnableRelayNotifications: @escaping (MachineEndpoint) -> Void = { _ in },
        enablingRelayNotifications: Bool = false,
        onDismissError: @escaping () -> Void = {},
        onDismissNotice: @escaping () -> Void = {}
    ) {
        self.questions = questions
        self.sessions = sessions
        self.machines = machines
        self.sessionMachines = sessionMachines
        self.recentRepositories = recentRepositories
        self.publicIdentity = publicIdentity
        _selectedMachineID = selectedMachineID
        self.errorMessage = errorMessage
        self.noticeMessage = noticeMessage
        self.transcriptForSession = transcriptForSession
        self.questionsForSession = questionsForSession
        self.viewsForSession = viewsForSession
        self.viewsLoadedForSession = viewsLoadedForSession
        self.onAnswer = onAnswer
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        self.onOpenSession = onOpenSession
        self.onSend = onSend
        self.onTerminateSession = onTerminateSession
        self.onResumeSession = onResumeSession
        self.onCreateSession = onCreateSession
        self.onAddMachine = onAddMachine
        self.onRemoveMachine = onRemoveMachine
        self.onRetryApproval = onRetryApproval
        self.onRetryConnection = onRetryConnection
        self.onEnableRelayNotifications = onEnableRelayNotifications
        self.enablingRelayNotifications = enablingRelayNotifications
        self.onDismissError = onDismissError
        self.onDismissNotice = onDismissNotice
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: RemiTheme.Spacing.m) {
                if let errorMessage {
                    RemiFeedbackBanner(message: errorMessage, tone: .error, onDismiss: onDismissError)
                }

                if let noticeMessage {
                    RemiFeedbackBanner(message: noticeMessage, tone: .information, onDismiss: onDismissNotice)
                }

                if machines.count > 1 {
                    MachineScopePicker(
                        machines: machines,
                        selectedMachineID: $selectedMachineID
                    )
                }

                if !sessions.isEmpty || !questions.isEmpty {
                    CommandCenterScopePicker(
                        scope: $activityScope,
                        counts: snapshot.scopeCounts
                    )
                }

                if !snapshot.sessions.isEmpty || !snapshot.questions.isEmpty {
                    CommandCenterSummary(snapshot: snapshot)
                }

                if !snapshot.questions.isEmpty {
                    NeedsYouSection(
                        questions: snapshot.questions,
                        onAnswer: onAnswer,
                        onSubmit: onSubmit,
                        onCancel: onCancel
                    )
                }

                if lifecycleState == .firstRun {
                    FirstRunScreen(onAddMachine: { showingPairing = true })
                } else if snapshot.sessions.isEmpty {
                    PhoneNoSessionsState(
                        message: emptySessionsMessage,
                        canCreateSession: !availableSessionMachines.isEmpty,
                        onNewSession: { presentNewSession() },
                        onReset: hasActiveFilters ? resetFilters : nil
                    )
                } else {
                    SessionsSection(
                        sessions: snapshot.sessions,
                        scope: activityScope,
                        query: searchText,
                        transcriptForSession: transcriptForSession,
                        questionsForSession: questionsForSession,
                        viewsForSession: viewsForSession,
                        viewsLoadedForSession: viewsLoadedForSession,
                        onAnswer: onAnswer,
                        onSubmit: onSubmit,
                        onCancel: onCancel,
                        onOpenSession: onOpenSession,
                        onSend: onSend,
                        onTerminateSession: onTerminateSession,
                        onResumeSession: onResumeSession,
                        onNewSessionHere: { machineID, repository in
                            presentNewSession(machineID: machineID, repository: repository)
                        }
                    )
                }

                if !machines.isEmpty {
                    machineManagementSection
                }
            }
            .padding(RemiTheme.Spacing.m)
        }
        .onChange(of: machines.map(\.id), initial: true) { _, machineIDs in
            if !selectedMachineID.isEmpty, !machineIDs.contains(selectedMachineID) {
                selectedMachineID = ""
            }
        }
        .navigationTitle("Remi")
        .searchable(text: $searchText, prompt: "Search Remi activity")
        .toolbar {
            if #available(iOS 27.0, *) {
                ToolbarOverflowMenu {
                    if !availableSessionMachines.isEmpty {
                        Button("Add machine", systemImage: "desktopcomputer.and.arrow.down") {
                            showingPairing = true
                        }
                    }
                    Button("Preferences", systemImage: "gearshape") {
                        showingPreferences = true
                    }
                }

                ToolbarItem(placement: .topBarPinnedTrailing) {
                    if availableSessionMachines.isEmpty {
                        Button("Add machine", systemImage: "desktopcomputer.and.arrow.down") {
                            showingPairing = true
                        }
                    } else {
                        Button("New session", systemImage: "plus.rectangle.on.folder") {
                            presentNewSession()
                        }
                    }
                }
            } else {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("New session", systemImage: "plus.rectangle.on.folder") {
                            presentNewSession()
                        }
                        .disabled(availableSessionMachines.isEmpty)

                        Button("Add machine", systemImage: "desktopcomputer.and.arrow.down") {
                            showingPairing = true
                        }

                        Divider()

                        Button("Preferences", systemImage: "gearshape") {
                            showingPreferences = true
                        }
                    } label: {
                        Label("Add", systemImage: "plus")
                            .frame(
                                minWidth: RemiTheme.Size.minimumTapTarget,
                                minHeight: RemiTheme.Size.minimumTapTarget
                            )
                            .contentShape(.rect)
                    }
                }
            }
        }
        .sheet(isPresented: $showingNewSession, onDismiss: clearNewSessionContext) {
            PhoneNewSessionSheet(
                machines: availableSessionMachines,
                recentRepositories: recentRepositories,
                preferredMachineID: newSessionMachineID,
                preferredRepository: newSessionRepository,
                onCreate: onCreateSession
            )
        }
        .sheet(isPresented: $showingPairing) {
            NavigationStack {
                PairingScreen(
                    publicIdentity: publicIdentity,
                    machineStates: sessionMachines,
                    onAddMachine: onAddMachine
                )
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { showingPairing = false }
                        }
                    }
            }
        }
        .sheet(isPresented: $showingPreferences) {
            PhonePreferencesSheet(publicIdentity: publicIdentity)
        }
    }

    private var availableSessionMachines: [MachineState] {
        sessionMachines.filter { $0.status == .connected }
    }

    private var snapshot: RemiCommandCenterSnapshot {
        RemiCommandCenterSnapshot(
            sessions: sessions,
            questions: questions,
            selectedMachineID: selectedMachineID,
            query: searchText,
            scope: activityScope
        )
    }

    private var emptySessionsMessage: LocalizedStringKey {
        if activityScope != .overview {
            return "No activity matches this scope."
        }
        switch lifecycleState {
        case .noSearchResults:
            return hasActiveFilters ? "No activity matches these filters." : "No sessions match this search."
        case .noSessionsForMachine:
            return "This machine has no available sessions yet."
        default:
            return "Sessions from your connected machines will appear here."
        }
    }

    private var lifecycleState: RemiHomeLifecycleState {
        RemiHomeLifecycleState.resolve(
            machineCount: machines.count,
            visibleSessionCount: snapshot.sessions.count,
            query: searchText,
            hasSelectedMachine: !selectedMachineID.isEmpty
        )
    }

    private var hasActiveFilters: Bool {
        !selectedMachineID.isEmpty
            || activityScope != .overview
            || !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var hasMachineRecoveryWork: Bool {
        sessionMachines.contains { $0.status != .connected }
    }

    private var showsMachineManagement: Bool {
        RemiCommandCenterDisclosure.showsMachineManagement(
            hasRecoveryWork: hasMachineRecoveryWork,
            manuallyExpanded: machinesExpanded
        )
    }

    @ViewBuilder private var machineManagementSection: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            Button {
                if !hasMachineRecoveryWork {
                    machinesExpanded.toggle()
                }
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
                        Text("Machines").font(.title2.weight(.bold))
                        Text(machineSummary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: showsMachineManagement ? "chevron.up" : "chevron.down")
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: RemiTheme.Size.minimumTapTarget)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint(machineManagementHint)

            if showsMachineManagement {
                MachinesSection(
                    machines: machines,
                    states: sessionMachines,
                    publicIdentity: publicIdentity,
                    onRemove: onRemoveMachine,
                    onRetryApproval: onRetryApproval,
                    onRetryConnection: onRetryConnection,
                    onPairAgain: { showingPairing = true },
                    onEnableRelayNotifications: onEnableRelayNotifications,
                    enablingRelayNotifications: enablingRelayNotifications,
                    showsTitle: false
                )
            }
        }
    }

    private var machineSummary: LocalizedStringResource {
        let connected = machines.count { $0.reachability == .connected }
        return hasMachineRecoveryWork
            ? "\(connected) of \(machines.count) connected · Action may be needed"
            : "\(connected) connected"
    }

    private var machineManagementHint: LocalizedStringResource {
        if hasMachineRecoveryWork {
            return "Machine actions remain visible while attention is needed"
        }
        return showsMachineManagement ? "Hides machine management" : "Shows machine management"
    }

    private func presentNewSession(machineID: String? = nil, repository: String? = nil) {
        newSessionMachineID = machineID ?? (selectedMachineID.isEmpty ? nil : selectedMachineID)
        newSessionRepository = repository
        showingNewSession = true
    }

    private func clearNewSessionContext() {
        newSessionMachineID = nil
        newSessionRepository = nil
    }

    private func resetFilters() {
        selectedMachineID = ""
        searchText = ""
        activityScope = .overview
    }
}

private struct CommandCenterSummary: View {
    let snapshot: RemiCommandCenterSnapshot

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: RemiTheme.Spacing.m) { metrics }
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) { metrics }
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var metrics: some View {
        Label(count(snapshot.activeSessionCount, singular: "active session"), systemImage: "bolt.fill")
        Label(count(snapshot.workspaceCount, singular: "workspace"), systemImage: "folder")
        if snapshot.waitingQuestionCount > 0 {
            Label(
                count(snapshot.waitingQuestionCount, singular: "request"),
                systemImage: "questionmark.bubble.fill"
            )
            .foregroundStyle(RemiTheme.Color.attentionInk)
        }
    }

    private func count(_ value: Int, singular: String) -> String {
        value == 1 ? "1 \(singular)" : "\(value) \(singular)s"
    }
}

private struct PhoneNoSessionsState: View {
    let message: LocalizedStringKey
    let canCreateSession: Bool
    let onNewSession: () -> Void
    let onReset: (() -> Void)?

    var body: some View {
        ContentUnavailableView {
            Label("No sessions", systemImage: "rectangle.stack")
        } description: {
            Text(message)
        } actions: {
            if canCreateSession {
                Button("New session", systemImage: "plus.rectangle.on.folder", action: onNewSession)
                    .buttonStyle(.glassProminent)
            }
            if let onReset {
                Button("Show all activity", action: onReset)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, RemiTheme.Spacing.l)
    }
}

private struct CommandCenterScopePicker: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Binding var scope: RemiCommandCenterScope
    let counts: RemiCommandCenterScopeCounts

    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            Picker("Activity scope", selection: $scope) {
                scopeOptions
            }
            .pickerStyle(.menu)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            ScrollView(.horizontal) {
                HStack(spacing: RemiTheme.Spacing.xs) {
                    ForEach(RemiCommandCenterScope.allCases, id: \.self) { option in
                        Button {
                            scope = option
                        } label: {
                            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxxs) {
                                Text(title(option))
                                    .font(.subheadline.weight(.semibold))
                                Text(sessionCount(counts[option]))
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                            .frame(minWidth: 70, minHeight: RemiTheme.Size.minimumTapTarget, alignment: .leading)
                            .padding(.horizontal, RemiTheme.Spacing.s)
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .background(
                            option == scope ? Color.primary.opacity(0.1) : Color.primary.opacity(0.045),
                            in: Capsule()
                        )
                        .overlay {
                            Capsule()
                                .stroke(
                                    option == scope ? Color.primary.opacity(0.34) : RemiTheme.Color.hairline,
                                    lineWidth: 1
                                )
                                .allowsHitTesting(false)
                        }
                        .accessibilityAddTraits(option == scope ? .isSelected : [])
                        .accessibilityLabel(label(option))
                        .accessibilityHint("Filters the command center")
                    }
                }
                .padding(.vertical, 2)
            }
            .scrollIndicators(.hidden)
        }
    }

    @ViewBuilder private var scopeOptions: some View {
        ForEach(RemiCommandCenterScope.allCases, id: \.self) { option in
            Text(label(option)).tag(option)
        }
    }

    private func title(_ scope: RemiCommandCenterScope) -> LocalizedStringResource {
        switch scope {
        case .overview: "Overview"
        case .needsYou: "Needs You"
        case .active: "Active"
        case .recent: "Recent"
        }
    }

    private func label(_ scope: RemiCommandCenterScope) -> LocalizedStringResource {
        let count = counts[scope]
        switch (scope, count == 1) {
        case (.overview, true): return "Overview, 1 session"
        case (.overview, false): return "Overview, \(count) sessions"
        case (.needsYou, true): return "Needs You, 1 session"
        case (.needsYou, false): return "Needs You, \(count) sessions"
        case (.active, true): return "Active, 1 session"
        case (.active, false): return "Active, \(count) sessions"
        case (.recent, true): return "Recent, 1 session"
        case (.recent, false): return "Recent, \(count) sessions"
        }
    }

    private func sessionCount(_ count: Int) -> LocalizedStringResource {
        count == 1 ? "1 session" : "\(count) sessions"
    }
}

private struct MachineScopePicker: View {
    let machines: [RemiMachineSummary]
    @Binding var selectedMachineID: String

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            Text("Machine scope")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            ScrollView(.horizontal) {
                HStack(spacing: RemiTheme.Spacing.xs) {
                    ScopeButton(
                        title: "All",
                        subtitle: countLabel(machines.count, singular: "machine"),
                        systemImage: "square.grid.2x2",
                        selected: selectedMachineID.isEmpty
                    ) { selectedMachineID = "" }

                    ForEach(machines) { machine in
                        ScopeButton(
                            title: machine.name,
                            subtitle: countLabel(machine.sessionCount, singular: "session"),
                            systemImage: machine.reachability == .connected
                                ? "desktopcomputer" : "desktopcomputer.trianglebadge.exclamationmark",
                            selected: selectedMachineID == machine.id
                        ) { selectedMachineID = machine.id }
                    }
                }
                .padding(.vertical, 2)
            }
            .scrollIndicators(.hidden)
        }
    }

    private func countLabel(_ count: Int, singular: String) -> String {
        count == 1 ? "1 \(singular)" : "\(count) \(singular)s"
    }
}

private struct ScopeButton: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: RemiTheme.Spacing.xs) {
                Image(systemName: systemImage)
                    .foregroundStyle(selected ? Color.primary : .secondary)
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .frame(minHeight: RemiTheme.Size.minimumTapTarget, alignment: .leading)
            .padding(.horizontal, RemiTheme.Spacing.s)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .background(
            selected ? Color.primary.opacity(0.09) : Color.primary.opacity(0.045),
            in: RoundedRectangle(cornerRadius: RemiTheme.Radius.control)
        )
        .overlay {
            RoundedRectangle(cornerRadius: RemiTheme.Radius.control)
                .stroke(selected ? Color.primary.opacity(0.38) : RemiTheme.Color.hairline, lineWidth: 1)
                .allowsHitTesting(false)
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityLabel("\(title), \(subtitle)")
        .accessibilityHint(selected ? "Selected session scope" : "Filter sessions to this scope")
    }
}

private struct NeedsYouSection: View {
    let questions: [RemiQuestionCardModel]
    let onAnswer: (String, String, String) -> Void
    let onSubmit: (String, String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String, String) -> Void
    @State private var showsAllQuestions = false

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            Text("Needs you").font(.title2.weight(.bold))
            ForEach(displayedQuestions) { question in
                RemiQuestionCard(
                    model: question,
                    onAnswer: { onAnswer(question.sessionID, question.questionID, $0) },
                    onSubmit: { onSubmit(question.sessionID, question.questionID, $0) },
                    onCancel: { onCancel(question.sessionID, question.questionID) }
                )
            }

            if questions.count > displayedQuestions.count {
                Button("Show \(questions.count - displayedQuestions.count) more", systemImage: "chevron.down") {
                    showsAllQuestions = true
                }
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: RemiTheme.Size.minimumTapTarget)
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            } else if questions.count > 2 {
                Button("Show fewer", systemImage: "chevron.up") {
                    showsAllQuestions = false
                }
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: RemiTheme.Size.minimumTapTarget)
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
        }
        .onChange(of: questions.map(\.id)) { _, _ in
            showsAllQuestions = false
        }
    }

    private var displayedQuestions: ArraySlice<RemiQuestionCardModel> {
        questions.prefix(showsAllQuestions ? questions.count : 2)
    }
}

private struct SessionsSection: View {
    let sessions: [RemiSessionSummary]
    let scope: RemiCommandCenterScope
    let query: String
    let transcriptForSession: (String) -> [RemiTranscriptEntry]
    let questionsForSession: (String) -> [RemiQuestionCardModel]
    let viewsForSession: (String) -> [SessionViewMeta]
    let viewsLoadedForSession: (String) -> Bool
    let onAnswer: (String, String, String) -> Void
    let onSubmit: (String, String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String, String) -> Void
    let onOpenSession: (String) -> Void
    let onSend: (String, String) async -> Bool
    let onTerminateSession: (String) -> Void
    let onResumeSession: (String, String) -> Void
    let onNewSessionHere: (String, String) -> Void
    @State private var focusedWorkspace: PhoneWorkspaceFocus?
    @State private var showsRecent = false

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            Text("Workspaces").font(.title2.weight(.bold))
            ForEach(activeWorkspaces) { workspace in
                workspaceEntry(workspace)
                if workspace.id != activeWorkspaces.last?.id { Divider() }
            }

            if !recentWorkspaces.isEmpty, automaticallyShowsRecent {
                Label(recentWorkspaceLabel(recentWorkspaces.count), systemImage: "clock")
                    .font(.subheadline.weight(.semibold))
                    .padding(.top, RemiTheme.Spacing.xs)
                ForEach(recentWorkspaces) { workspace in
                    workspaceEntry(workspace)
                    if workspace.id != recentWorkspaces.last?.id { Divider() }
                }
            } else if !recentWorkspaces.isEmpty {
                DisclosureGroup(isExpanded: $showsRecent) {
                    ForEach(recentWorkspaces) { workspace in
                        workspaceEntry(workspace)
                        if workspace.id != recentWorkspaces.last?.id { Divider() }
                    }
                } label: {
                    Label(recentWorkspaceLabel(recentWorkspaces.count), systemImage: "clock")
                        .font(.subheadline.weight(.semibold))
                }
                .padding(.vertical, RemiTheme.Spacing.xs)
                .accessibilityLabel(recentWorkspaceLabel(recentWorkspaces.count))
                .accessibilityHint(showsRecent ? "Hides finished workspaces" : "Shows finished workspaces")
            }
        }
        .sheet(item: $focusedWorkspace) { focus in
            if let workspace = workspaces.first(where: { $0.id == focus.id }) {
                PhoneWorkspaceSessionsSheet(
                    workspace: workspace,
                    transcriptForSession: transcriptForSession,
                    questionsForSession: questionsForSession,
                    viewsForSession: viewsForSession,
                    viewsLoadedForSession: viewsLoadedForSession,
                    onAnswer: onAnswer,
                    onSubmit: onSubmit,
                    onCancel: onCancel,
                    onOpenSession: onOpenSession,
                    onSend: onSend,
                    onTerminateSession: onTerminateSession,
                    onResumeSession: onResumeSession,
                    onNewSessionHere: onNewSessionHere
                )
            }
        }
    }

    private var workspaces: [PhoneSessionWorkspace] {
        Dictionary(grouping: sessions) { session in
            "\(session.machineID)|\(session.projectPath)"
        }
        .values
        .compactMap(PhoneSessionWorkspace.init(sessions:))
        .sorted { RemiWorkspaceOrdering.sortsBefore($0.sessions, $1.sessions) }
    }

    private var activeWorkspaces: [PhoneSessionWorkspace] {
        workspaces.filter { $0.activeCount > 0 }
    }

    private var recentWorkspaces: [PhoneSessionWorkspace] {
        workspaces.filter { $0.activeCount == 0 }
    }

    private var automaticallyShowsRecent: Bool {
        RemiCommandCenterDisclosure.showsRecent(
            scope: scope,
            query: query,
            manuallyExpanded: false
        )
    }

    private func workspaceEntry(_ workspace: PhoneSessionWorkspace) -> some View {
        Button {
            focusedWorkspace = PhoneWorkspaceFocus(id: workspace.id)
        } label: {
            PhoneWorkspaceRow(workspace: workspace)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(showSessionsLabel(workspace.sessions.count), systemImage: "rectangle.stack") {
                focusedWorkspace = PhoneWorkspaceFocus(id: workspace.id)
            }
            Button("Copy directory", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = workspace.projectPath
            }
            Button("New session here", systemImage: "plus.rectangle.on.folder") {
                onNewSessionHere(workspace.machineID, workspace.projectPath)
            }
            if let resumable = workspace.sessions.first(where: { $0.canResume }) {
                Button("Resume latest", systemImage: "play.fill") {
                    onResumeSession(resumable.machineID, resumable.id)
                }
                .disabled(resumable.isResuming)
            }
        }
    }

    private func showSessionsLabel(_ count: Int) -> String {
        count == 1 ? "Show 1 session" : "Show \(count) sessions"
    }

    private func recentWorkspaceLabel(_ count: Int) -> String {
        count == 1 ? "1 recent workspace" : "\(count) recent workspaces"
    }
}

private struct PhoneWorkspaceFocus: Identifiable {
    let id: String
}

private struct PhoneSessionWorkspace: Identifiable {
    let id: String
    let machineID: String
    let machineName: String
    let project: String
    let projectPath: String
    let sessions: [RemiSessionSummary]

    init?(sessions: [RemiSessionSummary]) {
        guard let first = sessions.first else { return nil }
        id = "\(first.machineID)|\(first.projectPath)"
        machineID = first.machineID
        machineName = first.machineName
        project = first.project
        projectPath = first.projectPath
        self.sessions = sessions.sorted {
            if $0.displayPriority != $1.displayPriority {
                return $0.displayPriority < $1.displayPriority
            }
            return ($0.lastActivity ?? "") > ($1.lastActivity ?? "")
        }
    }

    var status: RemiSessionStatus { sessions.first?.status ?? .offline }
    var questionCount: Int { sessions.reduce(0) { $0 + $1.openQuestionCount } }
    var activeCount: Int { sessions.count { $0.isLive } }
    var storedCount: Int { sessions.count { !$0.isLive } }
}

private extension RemiSessionSummary {
    var lastActivityDate: Date? {
        guard let lastActivity else { return nil }
        return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(lastActivity))
            ?? (try? Date.ISO8601FormatStyle().parse(lastActivity))
    }

    var displayPriority: Int {
        switch status {
        case .needsYou: 0
        case .working: 1
        case .connecting: 2
        case .idle: 3
        case .offline: 4
        }
    }
}

private struct PhoneWorkspaceRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let workspace: PhoneSessionWorkspace

    var body: some View {
        HStack(alignment: .top, spacing: RemiTheme.Spacing.s) {
            Image(systemName: "folder")
                .font(.title3)
                .foregroundStyle(.secondary)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxs) {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
                        Text(workspace.project)
                            .font(.headline)
                        RemiStatusBadge(status: workspace.status)
                    }
                } else {
                    HStack(alignment: .firstTextBaseline) {
                        Text(workspace.project)
                            .font(.headline)
                        Spacer(minLength: RemiTheme.Spacing.xs)
                        RemiStatusBadge(status: workspace.status)
                    }
                }

                Text(workspace.projectPath)
                    .font(RemiTheme.Typography.code)
                    .foregroundStyle(.secondary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                    .truncationMode(.middle)

                Label(workspace.machineName, systemImage: "desktopcomputer")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                let metadataLayout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: RemiTheme.Spacing.xxs))
                    : AnyLayout(HStackLayout(alignment: .center, spacing: RemiTheme.Spacing.s))

                metadataLayout {
                    Label(sessionCountLabel, systemImage: "rectangle.stack")
                    if workspace.activeCount > 0 {
                        Text("\(workspace.activeCount) active")
                    }
                    if workspace.storedCount > 0 {
                        Text("\(workspace.storedCount) stored")
                    }
                    if workspace.questionCount > 0 {
                        Label("\(workspace.questionCount)", systemImage: "questionmark.bubble.fill")
                            .foregroundStyle(RemiTheme.Color.attentionInk)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)

                if let activity = workspace.sessions.compactMap(\.lastActivityDate).max() {
                    Text("Updated \(activity, style: .relative)")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .padding(.top, RemiTheme.Spacing.xs)
                .accessibilityHidden(true)
        }
        .padding(.vertical, RemiTheme.Spacing.xs)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint("Shows sessions in this workspace")
    }

    private var sessionCountLabel: String {
        workspace.sessions.count == 1 ? "1 session" : "\(workspace.sessions.count) sessions"
    }

    private var accessibilityLabel: String {
        var parts = [workspace.project, workspace.projectPath, sessionCountLabel]
        if workspace.activeCount > 0 { parts.append("\(workspace.activeCount) active") }
        if workspace.storedCount > 0 { parts.append("\(workspace.storedCount) finished") }
        if workspace.questionCount > 0 {
            parts.append(workspace.questionCount == 1 ? "1 question needs attention" : "\(workspace.questionCount) questions need attention")
        }
        return parts.joined(separator: ", ")
    }
}

private struct PhoneWorkspaceSessionsSheet: View {
    let workspace: PhoneSessionWorkspace
    let transcriptForSession: (String) -> [RemiTranscriptEntry]
    let questionsForSession: (String) -> [RemiQuestionCardModel]
    let viewsForSession: (String) -> [SessionViewMeta]
    let viewsLoadedForSession: (String) -> Bool
    let onAnswer: (String, String, String) -> Void
    let onSubmit: (String, String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String, String) -> Void
    let onOpenSession: (String) -> Void
    let onSend: (String, String) async -> Bool
    let onTerminateSession: (String) -> Void
    let onResumeSession: (String, String) -> Void
    let onNewSessionHere: (String, String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    PhoneWorkspaceDetailHeader(workspace: workspace)
                }

                if !activeSessions.isEmpty {
                    Section("Active") {
                        ForEach(activeSessions) { session in
                            sessionEntry(session)
                        }
                    }
                }

                if !finishedSessions.isEmpty {
                    Section("Finished") {
                        ForEach(finishedSessions) { session in
                            sessionEntry(session)
                        }
                    }
                }

                if activeSessions.isEmpty && finishedSessions.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                }
            }
            .navigationTitle(workspace.project)
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $searchText, prompt: "Search sessions")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("New session here", systemImage: "plus.rectangle.on.folder") {
                        dismiss()
                        onNewSessionHere(workspace.machineID, workspace.projectPath)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var filteredSessions: [RemiSessionSummary] {
        guard !searchText.isEmpty else { return workspace.sessions }
        return workspace.sessions.filter { session in
            session.name.localizedCaseInsensitiveContains(searchText) ||
                session.harness.localizedCaseInsensitiveContains(searchText) ||
                (session.lastMessage?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }

    private var activeSessions: [RemiSessionSummary] {
        filteredSessions.filter(\.isLive)
    }

    private var finishedSessions: [RemiSessionSummary] {
        filteredSessions.filter { !$0.isLive }
    }

    @ViewBuilder
    private func sessionEntry(_ session: RemiSessionSummary) -> some View {
        if session.canResume {
            PhoneStoredSessionRow(session: session, onResume: {
                onResumeSession(session.machineID, session.id)
            }) {
                sessionDestination(session)
            }
            .contextMenu { copySessionIDButton(session.id) }
        } else {
            NavigationLink {
                sessionDestination(session)
            } label: {
                RemiSessionRow(session: session)
            }
            .contextMenu { copySessionIDButton(session.id) }
        }
    }

    private func copySessionIDButton(_ sessionID: String) -> some View {
        Button("Copy session ID", systemImage: "doc.on.doc") {
            UIPasteboard.general.string = sessionID
        }
    }

    private func sessionDestination(_ session: RemiSessionSummary) -> some View {
        SessionScreen(
            session: session,
            transcript: transcriptForSession(session.id),
            questions: questionsForSession(session.id),
            views: viewsForSession(session.id),
            viewsLoaded: viewsLoadedForSession(session.id),
            transcriptForView: transcriptForSession,
            onSelectView: onOpenSession,
            onAnswer: { onAnswer(session.id, $0, $1) },
            onSubmit: { onSubmit(session.id, $0, $1) },
            onCancel: { onCancel(session.id, $0) },
            onSend: { await onSend(session.id, $0) },
            onTerminate: { onTerminateSession(session.id) }
        )
        .onAppear { onOpenSession(session.id) }
    }
}

private struct PhoneWorkspaceDetailHeader: View {
    let workspace: PhoneSessionWorkspace

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            Label(workspace.machineName, systemImage: "desktopcomputer")
                .font(.subheadline.weight(.semibold))

            Text(workspace.projectPath)
                .font(RemiTheme.Typography.code)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)

            HStack(spacing: RemiTheme.Spacing.m) {
                Label("\(workspace.activeCount) active", systemImage: "bolt")
                Label("\(workspace.storedCount) finished", systemImage: "checkmark.circle")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, RemiTheme.Spacing.xs)
        .accessibilityElement(children: .combine)
    }
}

private struct PhoneStoredSessionRow<Destination: View>: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let session: RemiSessionSummary
    let onResume: () -> Void
    @ViewBuilder let destination: () -> Destination

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: RemiTheme.Spacing.s))
            : AnyLayout(HStackLayout(alignment: .center, spacing: RemiTheme.Spacing.s))

        layout {
            NavigationLink(destination: destination) {
                RemiSessionRow(session: session)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .layoutPriority(1)
            }
            .buttonStyle(.plain)

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

private struct MachinesSection: View {
    let machines: [RemiMachineSummary]
    let states: [MachineState]
    let publicIdentity: PublicClientIdentity?
    let onRemove: (String) -> Void
    let onRetryApproval: (MachineEndpoint) -> Void
    let onRetryConnection: (MachineEndpoint) -> Void
    let onPairAgain: () -> Void
    let onEnableRelayNotifications: (MachineEndpoint) -> Void
    let enablingRelayNotifications: Bool
    let showsTitle: Bool
    @State private var pendingRemoval: RemiMachineSummary?

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            if showsTitle {
                Text("Machines").font(.title2.weight(.bold))
            }
            ForEach(machines) { machine in
                let state = states.first { $0.id == machine.id }
                PhoneMachineManagementRow(
                    machine: machine,
                    state: state,
                    enablingRelayNotifications: enablingRelayNotifications,
                    onEnableRelayNotifications: onEnableRelayNotifications,
                    onRetryConnection: onRetryConnection,
                    onRemove: { pendingRemoval = machine }
                )
                if let state = states.first(where: { $0.id == machine.id }),
                   case .waitingForApproval(let fingerprint) = state.status {
                    ApprovalHelp(
                        machineName: machine.name,
                        fingerprint: fingerprint,
                        command: publicIdentity?.authorizeCommand(label: UIDevice.current.name),
                        onRetry: { onRetryApproval(state.endpoint) }
                    )
                }
                if let state = states.first(where: { $0.id == machine.id }),
                   case .waitingForRelayConfirmation(let fingerprint) = state.status {
                    RelayConfirmationHelp(machineName: machine.name, fingerprint: fingerprint)
                }
                if let state = states.first(where: { $0.id == machine.id }) {
                    PhoneMachineRecoveryHelp(
                        machineName: machine.name,
                        state: RemiMachineRecoveryState.resolve(
                            status: state.status,
                            isRelay: state.endpoint.relayPin != nil
                        ),
                        onRetry: { onRetryConnection(state.endpoint) },
                        onPairAgain: onPairAgain
                    )
                }
                if machine.id != machines.last?.id { Divider() }
            }
        }
        .alert(
            "Remove machine?",
            isPresented: Binding(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            presenting: pendingRemoval
        ) { machine in
            Button("Remove", role: .destructive) {
                onRemove(machine.id)
                pendingRemoval = nil
            }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        } message: { machine in
            Text("Remi will forget \(machine.name) and its cached conversations on this device. Sessions on the machine keep running.")
        }
    }
}

private struct PhoneMachineRecoveryHelp: View {
    let machineName: String
    let state: RemiMachineRecoveryState
    let onRetry: () -> Void
    let onPairAgain: () -> Void

    var body: some View {
        switch state {
        case .retryableOffline:
            recoveryCard(
                title: "Machine offline",
                detail: "Remi is not connected to \(machineName).",
                actionTitle: "Retry connection",
                systemImage: "arrow.clockwise",
                action: onRetry
            )
        case .retryableUnavailable(let reason):
            recoveryCard(
                title: "Machine unavailable",
                detail: reason ?? "Remi could not connect to \(machineName).",
                actionTitle: "Retry connection",
                systemImage: "arrow.clockwise",
                action: onRetry
            )
        case .relayOffline:
            recoveryCard(
                title: "Relay machine offline",
                detail: "Remi will reconnect through the relay when \(machineName) becomes available."
            )
        case .relayNeedsFreshPairing(let reason):
            recoveryCard(
                title: "Relay pairing unavailable",
                detail: relayPairingDetail(reason),
                actionTitle: "Pair again",
                systemImage: "arrow.trianglehead.2.clockwise.rotate.90",
                action: onPairAgain
            )
        case .none, .waitingForDirectApproval, .waitingForRelayConfirmation:
            EmptyView()
        }
    }

    private func recoveryCard(
        title: LocalizedStringKey,
        detail: String,
        actionTitle: LocalizedStringKey? = nil,
        systemImage: String = "network.slash",
        action: (() -> Void)? = nil
    ) -> some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            Label(title, systemImage: "desktopcomputer.trianglebadge.exclamationmark")
                .font(.headline)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let actionTitle, let action {
                Button(actionTitle, systemImage: systemImage, action: action)
                    .frame(minHeight: RemiTheme.Size.minimumTapTarget)
                    .contentShape(.rect)
            }
        }
        .padding(RemiTheme.Spacing.m)
        .background(.quaternary.opacity(0.45), in: .rect(cornerRadius: RemiTheme.Radius.control))
    }

    private func relayPairingDetail(_ reason: String?) -> String {
        let instruction = "Create a fresh relay pairing token on \(machineName)."
        guard let reason, !reason.isEmpty else { return instruction }
        return "\(reason) \(instruction)"
    }
}

private struct RelayConfirmationHelp: View {
    let machineName: String
    let fingerprint: String

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            Label("Terminal confirmation needed", systemImage: "checkmark.shield")
                .font(.headline)

            Text("On \(machineName), compare this fingerprint before approving the relay connection.")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            Text(fingerprint)
                .font(.system(.body, design: .monospaced, weight: .semibold))
                .textSelection(.enabled)

            Text("The pairing token does not authorize this phone by itself.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(RemiTheme.Spacing.m)
        .background(.quaternary.opacity(0.45), in: .rect(cornerRadius: RemiTheme.Radius.control))
    }
}

private struct PhoneMachineManagementRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let machine: RemiMachineSummary
    let state: MachineState?
    let enablingRelayNotifications: Bool
    let onEnableRelayNotifications: (MachineEndpoint) -> Void
    let onRetryConnection: (MachineEndpoint) -> Void
    let onRemove: () -> Void

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: RemiTheme.Spacing.s))
            : AnyLayout(HStackLayout(alignment: .center, spacing: RemiTheme.Spacing.s))

        layout {
            RemiMachineRow(machine: machine)
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)

            Menu {
                if let state, canRetryConnection(state) {
                    Button("Retry connection", systemImage: "arrow.clockwise") {
                        onRetryConnection(state.endpoint)
                    }
                }
                if let state, state.endpoint.relayPin != nil {
                    Button("Enable relay notifications", systemImage: "bell.badge") {
                        onEnableRelayNotifications(state.endpoint)
                    }
                    .disabled(enablingRelayNotifications || state.status != .connected)
                }
                Button("Remove machine", systemImage: "trash", role: .destructive) {
                    onRemove()
                }
            } label: {
                if dynamicTypeSize.isAccessibilitySize {
                    Label("Machine actions", systemImage: "ellipsis.circle")
                } else {
                    Label("Machine actions", systemImage: "ellipsis.circle")
                        .labelStyle(.iconOnly)
                        .font(.title3)
                        .frame(
                            width: RemiTheme.Size.minimumTapTarget,
                            height: RemiTheme.Size.minimumTapTarget
                        )
                        .contentShape(.rect)
                }
            }
        }
    }

    private func canRetryConnection(_ state: MachineState) -> Bool {
        RemiMachineRecoveryState.resolve(
            status: state.status,
            isRelay: state.endpoint.relayPin != nil
        ).allowsConnectionRetry
    }
}

private struct ApprovalHelp: View {
    let machineName: String
    let fingerprint: String
    let command: String?
    let onRetry: () -> Void
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            Label("Approval needed", systemImage: "person.badge.key")
                .font(.headline)
            Text("On \(machineName), compare this fingerprint and authorize this iPhone.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(fingerprint)
                .font(.system(.body, design: .monospaced).weight(.semibold))
                .textSelection(.enabled)

            if let command {
                Text(command)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(RemiTheme.Spacing.s)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.background, in: .rect(cornerRadius: RemiTheme.Radius.control))

                Button(copied ? "Command copied" : "Copy authorization command", systemImage: copied ? "checkmark" : "doc.on.doc") {
                    UIPasteboard.general.string = command
                    copied = true
                }
                .frame(minHeight: RemiTheme.Size.minimumTapTarget)
                .contentShape(.rect)
            }
            Button("Retry connection", systemImage: "arrow.clockwise", action: onRetry)
                .buttonStyle(.glassProminent)
                .frame(minHeight: RemiTheme.Size.minimumTapTarget)
                .contentShape(.rect)
        }
        .padding(RemiTheme.Spacing.m)
        .background(.orange.opacity(0.08), in: .rect(cornerRadius: RemiTheme.Radius.control))
    }
}
