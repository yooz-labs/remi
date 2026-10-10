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
        self.onEnableRelayNotifications = onEnableRelayNotifications
        self.enablingRelayNotifications = enablingRelayNotifications
        self.onDismissError = onDismissError
        self.onDismissNotice = onDismissNotice
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: RemiTheme.Spacing.l) {
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
                    NeedsYouSection(questions: visibleQuestions)
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
            Text(message)
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Dismiss", systemImage: "xmark", action: onDismiss)
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
        }
        .padding(RemiTheme.Spacing.m)
        .background(.orange.opacity(0.1), in: .rect(cornerRadius: RemiTheme.Radius.control))
        .accessibilityElement(children: .combine)
    }
}

private struct NoticeBanner: View {
    let message: String
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: RemiTheme.Spacing.s) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(.blue)
            Text(message)
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Dismiss", systemImage: "xmark", action: onDismiss)
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
        }
        .padding(RemiTheme.Spacing.m)
        .background(.blue.opacity(0.1), in: .rect(cornerRadius: RemiTheme.Radius.control))
        .accessibilityElement(children: .combine)
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
                        subtitle: "\(machines.count) machines",
                        systemImage: "square.grid.2x2",
                        selected: selectedMachineID.isEmpty
                    ) { selectedMachineID = "" }

                    ForEach(machines) { machine in
                        ScopeButton(
                            title: machine.name,
                            subtitle: "\(machine.sessionCount) sessions",
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
            .frame(minWidth: 132, alignment: .leading)
            .padding(.horizontal, RemiTheme.Spacing.s)
            .padding(.vertical, RemiTheme.Spacing.s)
            .contentShape(.rect)
        }
        .buttonStyle(.glass)
        .tint(selected ? RemiTheme.Color.attention : nil)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct NeedsYouSection: View {
    let questions: [RemiQuestionCardModel]

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            Text("Needs you").font(.title2.weight(.bold))
            ForEach(questions) { question in
                RemiQuestionCard(model: question)
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

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            Text("Sessions").font(.title2.weight(.bold))
            ForEach(machines) { machine in
                let machineSessions = sessions.filter { $0.machineID == machine.id }
                if !machineSessions.isEmpty {
                    Text(machine.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.top, RemiTheme.Spacing.xs)

                    ForEach(machineSessions) { session in
                        if session.canResume {
                            HStack(alignment: .center, spacing: RemiTheme.Spacing.s) {
                                RemiSessionRow(session: session)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Button {
                                    onResumeSession(session.machineID, session.id)
                                } label: {
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
                        } else {
                            NavigationLink {
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
                            } label: {
                                RemiSessionRow(session: session)
                            }
                            .buttonStyle(.plain)
                        }

                        if session.id != machineSessions.last?.id { Divider() }
                    }
                }
            }
        }
    }
}

private struct MachinesSection: View {
    let machines: [RemiMachineSummary]
    let states: [MachineState]
    let publicIdentity: PublicClientIdentity?
    let onRemove: (String) -> Void
    let onRetryApproval: (MachineEndpoint) -> Void
    let onEnableRelayNotifications: (MachineEndpoint) -> Void
    let enablingRelayNotifications: Bool
    @State private var pendingRemoval: RemiMachineSummary?

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            Text("Machines").font(.title2.weight(.bold))
            ForEach(machines) { machine in
                HStack(spacing: RemiTheme.Spacing.s) {
                    RemiMachineRow(machine: machine)
                    Menu {
                        if let state = states.first(where: { $0.id == machine.id }), state.endpoint.relayPin != nil {
                            Button("Enable relay notifications", systemImage: "bell.badge") {
                                onEnableRelayNotifications(state.endpoint)
                            }
                            .disabled(enablingRelayNotifications || state.status != .connected)
                        }
                        Button("Remove machine", systemImage: "trash", role: .destructive) {
                            pendingRemoval = machine
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.title3)
                            .frame(
                                width: RemiTheme.Size.minimumTapTarget,
                                height: RemiTheme.Size.minimumTapTarget
                            )
                            .contentShape(.rect)
                    }
                    .accessibilityLabel("Machine actions")
                }
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
                    Text("Compare \(fingerprint) in the machine's terminal before approving.")
                        .font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
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
