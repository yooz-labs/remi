import RemiKit
import RemiUI
import SwiftUI
import UIKit

struct InboxScreen: View {
    @State private var searchText = ""
    @State private var activityScope = RemiCommandCenterScope.overview
    let questions: [RemiQuestionCardModel]
    let sessions: [RemiSessionSummary]
    let machines: [RemiMachineSummary]
    let sessionMachines: [MachineState]
    let errorMessage: String?
    let noticeMessage: String?
    let onAnswer: (String, String, String) -> Void
    let onSubmit: (String, String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String, String) -> Void
    let onResumeSession: (String, String) -> Void
    let onOpenSessionRoute: (RemiSessionSummary) -> Void
    let onNewSession: (String?, String?) -> Void
    let onPresentPairing: () -> Void
    let onPresentPreferences: () -> Void
    let onManageMachines: () -> Void
    let onDismissError: () -> Void
    let onDismissNotice: () -> Void

    init(
        questions: [RemiQuestionCardModel],
        sessions: [RemiSessionSummary],
        machines: [RemiMachineSummary],
        sessionMachines: [MachineState] = [],
        errorMessage: String? = nil,
        noticeMessage: String? = nil,
        onAnswer: @escaping (String, String, String) -> Void = { _, _, _ in },
        onSubmit: @escaping (String, String, [RemiQuestionStepSelection]) -> Void = { _, _, _ in },
        onCancel: @escaping (String, String) -> Void = { _, _ in },
        onResumeSession: @escaping (String, String) -> Void = { _, _ in },
        onOpenSessionRoute: @escaping (RemiSessionSummary) -> Void = { _ in },
        onNewSession: @escaping (String?, String?) -> Void = { _, _ in },
        onPresentPairing: @escaping () -> Void = {},
        onPresentPreferences: @escaping () -> Void = {},
        onManageMachines: @escaping () -> Void = {},
        onDismissError: @escaping () -> Void = {},
        onDismissNotice: @escaping () -> Void = {}
    ) {
        self.questions = questions
        self.sessions = sessions
        self.machines = machines
        self.sessionMachines = sessionMachines
        self.errorMessage = errorMessage
        self.noticeMessage = noticeMessage
        self.onAnswer = onAnswer
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        self.onResumeSession = onResumeSession
        self.onOpenSessionRoute = onOpenSessionRoute
        self.onNewSession = onNewSession
        self.onPresentPairing = onPresentPairing
        self.onPresentPreferences = onPresentPreferences
        self.onManageMachines = onManageMachines
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

                PhoneMachineProblemRows(machines: machines, onManage: onManageMachines)

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
                    FirstRunScreen(onAddMachine: { onPresentPairing() })
                } else if snapshot.sessions.isEmpty {
                    PhoneNoSessionsState(
                        message: emptySessionsMessage,
                        canCreateSession: !availableSessionMachines.isEmpty,
                        onNewSession: { presentNewSession() },
                        onReset: hasActiveFilters ? { resetFilters() } : nil
                    )
                } else {
                    SessionsSection(
                        sessions: snapshot.sessions,
                        scope: activityScope,
                        query: searchText,
                        onOpenSessionRoute: onOpenSessionRoute,
                        onResumeSession: onResumeSession,
                        onNewSessionHere: { machineID, repository in
                            presentNewSession(machineID: machineID, repository: repository)
                        }
                    )
                }
            }
            .padding(RemiTheme.Spacing.m)
        }
        .navigationTitle("Remi")
        .searchable(text: $searchText, prompt: "Search Remi activity")
        .toolbar {
            if #available(iOS 27.0, *) {
                ToolbarOverflowMenu {
                    if !availableSessionMachines.isEmpty {
                        Button("Add machine", systemImage: "desktopcomputer.and.arrow.down") {
                            onPresentPairing()
                        }
                    }
                    Button("Preferences", systemImage: "gearshape") {
                        onPresentPreferences()
                    }
                }

                ToolbarItem(placement: .topBarPinnedTrailing) {
                    if availableSessionMachines.isEmpty {
                        Button("Add machine", systemImage: "desktopcomputer.and.arrow.down") {
                            onPresentPairing()
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
                            onPresentPairing()
                        }

                        Divider()

                        Button("Preferences", systemImage: "gearshape") {
                            onPresentPreferences()
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
    }

    private var availableSessionMachines: [MachineState] {
        sessionMachines.filter { $0.status == .connected }
    }

    private var snapshot: RemiCommandCenterSnapshot {
        RemiCommandCenterSnapshot(
            sessions: sessions,
            questions: questions,
            // The phone keeps no machine selection, so the Inbox spans every machine. The
            // Mac still uses this parameter.
            selectedMachineID: "",
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
            // No machine selection on the phone; the parameter stays for the Mac.
            hasSelectedMachine: false
        )
    }

    private var hasActiveFilters: Bool {
        activityScope != .overview
            || !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func presentNewSession(machineID: String? = nil, repository: String? = nil) {
        onNewSession(machineID, repository)
    }

    private func resetFilters() {
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
    let onOpenSessionRoute: (RemiSessionSummary) -> Void
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
                    onOpenSessionRoute: onOpenSessionRoute,
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
    let onOpenSessionRoute: (RemiSessionSummary) -> Void
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
            PhoneStoredSessionRow(
                session: session,
                onOpen: { open(session) },
                onResume: { onResumeSession(session.machineID, session.id) }
            )
            .contextMenu { copySessionIDButton(session.id) }
        } else {
            Button { open(session) } label: {
                RemiSessionRow(session: session)
            }
            .buttonStyle(.plain)
            .contextMenu { copySessionIDButton(session.id) }
        }
    }

    private func open(_ session: RemiSessionSummary) {
        onOpenSessionRoute(session)
        dismiss()
    }

    private func copySessionIDButton(_ sessionID: String) -> some View {
        Button("Copy session ID", systemImage: "doc.on.doc") {
            UIPasteboard.general.string = sessionID
        }
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

private struct PhoneStoredSessionRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let session: RemiSessionSummary
    let onOpen: () -> Void
    let onResume: () -> Void

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: RemiTheme.Spacing.s))
            : AnyLayout(HStackLayout(alignment: .center, spacing: RemiTheme.Spacing.s))

        layout {
            Button(action: onOpen) {
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
