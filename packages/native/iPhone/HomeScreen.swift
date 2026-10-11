import RemiKit
import RemiUI
import SwiftUI
import UIKit

struct HomeScreen: View {
    @State private var showingPairing = false
    @State private var showingNewSession = false
    @State private var showingPreferences = false
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
    let onAnswer: (String, String, String) -> Void
    let onSubmit: (String, String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String, String) -> Void
    let onOpenSession: (String) -> Void
    let onSend: (String, String) -> Void
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
        onAnswer: @escaping (String, String, String) -> Void = { _, _, _ in },
        onSubmit: @escaping (String, String, [RemiQuestionStepSelection]) -> Void = { _, _, _ in },
        onCancel: @escaping (String, String) -> Void = { _, _ in },
        onOpenSession: @escaping (String) -> Void = { _ in },
        onSend: @escaping (String, String) -> Void = { _, _ in },
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
                    ErrorBanner(message: errorMessage, onDismiss: onDismissError)
                }

                if let noticeMessage {
                    NoticeBanner(message: noticeMessage, onDismiss: onDismissNotice)
                }

                if machines.count > 1 {
                    MachineScopePicker(
                        machines: machines,
                        selectedMachineID: $selectedMachineID
                    )
                }

                if !visibleQuestions.isEmpty {
                    NeedsYouSection(
                        questions: visibleQuestions,
                        onAnswer: onAnswer,
                        onSubmit: onSubmit,
                        onCancel: onCancel
                    )
                }

                if visibleSessions.isEmpty {
                    PhoneNoSessionsState(
                        message: emptySessionsMessage,
                        canCreateSession: !availableSessionMachines.isEmpty,
                        onNewSession: { showingNewSession = true }
                    )
                } else {
                    SessionsSection(
                        sessions: visibleSessions,
                        machines: visibleMachines,
                        transcriptForSession: transcriptForSession,
                        questionsForSession: questionsForSession,
                        viewsForSession: viewsForSession,
                        onAnswer: onAnswer,
                        onSubmit: onSubmit,
                        onCancel: onCancel,
                        onOpenSession: onOpenSession,
                        onSend: onSend,
                        onTerminateSession: onTerminateSession,
                        onResumeSession: onResumeSession
                    )
                }

                if !machines.isEmpty {
                    MachinesSection(
                        machines: machines,
                        states: sessionMachines,
                        publicIdentity: publicIdentity,
                        onRemove: onRemoveMachine,
                        onRetryApproval: onRetryApproval,
                        onRetryConnection: onRetryConnection,
                        onEnableRelayNotifications: onEnableRelayNotifications,
                        enablingRelayNotifications: enablingRelayNotifications
                    )
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
                            showingNewSession = true
                        }
                    }
                }
            } else {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("New session", systemImage: "plus.rectangle.on.folder") {
                            showingNewSession = true
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
        .sheet(isPresented: $showingNewSession) {
            PhoneNewSessionSheet(
                machines: availableSessionMachines,
                recentRepositories: recentRepositories,
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

    private var visibleMachines: [RemiMachineSummary] {
        selectedMachineID.isEmpty ? machines : machines.filter { $0.id == selectedMachineID }
    }

    private var visibleSessions: [RemiSessionSummary] {
        selectedMachineID.isEmpty ? sessions : sessions.filter { $0.machineID == selectedMachineID }
    }

    private var visibleQuestions: [RemiQuestionCardModel] {
        guard machines.contains(where: { $0.id == selectedMachineID }) else {
            return questions
        }
        return questions.filter { $0.machineID == selectedMachineID }
    }

    private var emptySessionsMessage: LocalizedStringKey {
        selectedMachineID.isEmpty
            ? "Sessions from your connected machines will appear here."
            : "This machine has no available sessions yet."
    }
}

private struct PhoneNoSessionsState: View {
    let message: LocalizedStringKey
    let canCreateSession: Bool
    let onNewSession: () -> Void

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
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, RemiTheme.Spacing.l)
    }
}

private struct ErrorBanner: View {
    let message: String
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: RemiTheme.Spacing.s) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .accessibilityHidden(true)
            Text(message)
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Dismiss", systemImage: "xmark", action: onDismiss)
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
        }
        .padding(RemiTheme.Spacing.m)
        .background(.orange.opacity(0.1), in: .rect(cornerRadius: RemiTheme.Radius.control))
    }
}

private struct NoticeBanner: View {
    let message: String
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: RemiTheme.Spacing.s) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(.blue)
                .accessibilityHidden(true)
            Text(message)
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Dismiss", systemImage: "xmark", action: onDismiss)
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
        }
        .padding(RemiTheme.Spacing.m)
        .background(.blue.opacity(0.1), in: .rect(cornerRadius: RemiTheme.Radius.control))
    }
}

private struct MachineScopePicker: View {
    let machines: [RemiMachineSummary]
    @Binding var selectedMachineID: String

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            Text("Machines").font(.title2.weight(.bold))
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
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.xxs) {
                Label(title, systemImage: systemImage)
                    .font(.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            .frame(minWidth: 116, minHeight: RemiTheme.Size.minimumTapTarget, alignment: .leading)
            .padding(.horizontal, RemiTheme.Spacing.s)
            .padding(.vertical, RemiTheme.Spacing.xs)
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

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            Text("Needs you").font(.title2.weight(.bold))
            ForEach(questions) { question in
                RemiQuestionCard(
                    model: question,
                    onAnswer: { onAnswer(question.sessionID, question.questionID, $0) },
                    onSubmit: { onSubmit(question.sessionID, question.questionID, $0) },
                    onCancel: { onCancel(question.sessionID, question.questionID) }
                )
            }
        }
    }
}

private struct SessionsSection: View {
    let sessions: [RemiSessionSummary]
    let machines: [RemiMachineSummary]
    let transcriptForSession: (String) -> [RemiTranscriptEntry]
    let questionsForSession: (String) -> [RemiQuestionCardModel]
    let viewsForSession: (String) -> [SessionViewMeta]
    let onAnswer: (String, String, String) -> Void
    let onSubmit: (String, String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String, String) -> Void
    let onOpenSession: (String) -> Void
    let onSend: (String, String) -> Void
    let onTerminateSession: (String) -> Void
    let onResumeSession: (String, String) -> Void
    @State private var focusedWorkspace: PhoneWorkspaceFocus?
    @State private var expandedRecentMachines: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            Text("Workspaces").font(.title2.weight(.bold))
            ForEach(machines) { machine in
                let machineWorkspaces = workspaces.filter { $0.machineID == machine.id }
                let activeWorkspaces = machineWorkspaces.filter { $0.activeCount > 0 }
                let recentWorkspaces = machineWorkspaces.filter { $0.activeCount == 0 }
                if !machineWorkspaces.isEmpty {
                    Text(machine.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.top, RemiTheme.Spacing.xs)

                    ForEach(activeWorkspaces) { workspace in
                        workspaceEntry(workspace)
                        if workspace.id != activeWorkspaces.last?.id { Divider() }
                    }

                    if !recentWorkspaces.isEmpty {
                        DisclosureGroup(
                            isExpanded: Binding(
                                get: { expandedRecentMachines.contains(machine.id) },
                                set: { expanded in
                                    if expanded {
                                        expandedRecentMachines.insert(machine.id)
                                    } else {
                                        expandedRecentMachines.remove(machine.id)
                                    }
                                }
                            )
                        ) {
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
                        .accessibilityHint(
                            expandedRecentMachines.contains(machine.id)
                                ? "Hides finished workspaces"
                                : "Shows finished workspaces"
                        )
                    }
                }
            }
        }
        .sheet(item: $focusedWorkspace) { focus in
            if let workspace = workspaces.first(where: { $0.id == focus.id }) {
                PhoneWorkspaceSessionsSheet(
                    workspace: workspace,
                    transcriptForSession: transcriptForSession,
                    questionsForSession: questionsForSession,
                    viewsForSession: viewsForSession,
                    onAnswer: onAnswer,
                    onSubmit: onSubmit,
                    onCancel: onCancel,
                    onOpenSession: onOpenSession,
                    onSend: onSend,
                    onTerminateSession: onTerminateSession,
                    onResumeSession: onResumeSession
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
        .sorted { lhs, rhs in
            if lhs.machineID != rhs.machineID { return lhs.machineID < rhs.machineID }
            if lhs.priority != rhs.priority { return lhs.priority < rhs.priority }
            return lhs.project.localizedCaseInsensitiveCompare(rhs.project) == .orderedAscending
        }
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

    var priority: Int { sessions.first?.displayPriority ?? .max }
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
    let onAnswer: (String, String, String) -> Void
    let onSubmit: (String, String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String, String) -> Void
    let onOpenSession: (String) -> Void
    let onSend: (String, String) -> Void
    let onTerminateSession: (String) -> Void
    let onResumeSession: (String, String) -> Void
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
            transcriptForView: transcriptForSession,
            onSelectView: onOpenSession,
            onAnswer: { onAnswer(session.id, $0, $1) },
            onSubmit: { onSubmit(session.id, $0, $1) },
            onCancel: { onCancel(session.id, $0) },
            onSend: { onSend(session.id, $0) },
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
    let onEnableRelayNotifications: (MachineEndpoint) -> Void
    let enablingRelayNotifications: Bool
    @State private var pendingRemoval: RemiMachineSummary?

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            Text("Machines").font(.title2.weight(.bold))
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
        guard state.endpoint.relayPin == nil else { return false }
        switch state.status {
        case .disconnected, .unavailable:
            true
        default:
            false
        }
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
