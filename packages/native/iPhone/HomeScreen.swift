import RemiKit
import RemiUI
import SwiftUI

struct HomeScreen: View {
    @State private var showingPairing = false
    let questions: [RemiQuestionCardModel]
    let sessions: [RemiSessionSummary]
    let machines: [RemiMachineSummary]
    @Binding var selectedMachineID: String
    let errorMessage: String?
    let transcriptForSession: (String) -> [RemiTranscriptEntry]
    let questionsForSession: (String) -> [RemiQuestionCardModel]
    let onAnswer: (String, String, String) -> Void
    let onSubmit: (String, String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String, String) -> Void
    let onOpenSession: (String) -> Void
    let onSend: (String, String) -> Void
    let onAddMachine: (MachineEndpoint) -> Void
    let onDismissError: () -> Void

    init(
        questions: [RemiQuestionCardModel],
        sessions: [RemiSessionSummary],
        machines: [RemiMachineSummary],
        selectedMachineID: Binding<String> = .constant(""),
        errorMessage: String? = nil,
        transcriptForSession: @escaping (String) -> [RemiTranscriptEntry] = { _ in RemiPreviewData.transcript },
        questionsForSession: @escaping (String) -> [RemiQuestionCardModel] = { _ in [] },
        onAnswer: @escaping (String, String, String) -> Void = { _, _, _ in },
        onSubmit: @escaping (String, String, [RemiQuestionStepSelection]) -> Void = { _, _, _ in },
        onCancel: @escaping (String, String) -> Void = { _, _ in },
        onOpenSession: @escaping (String) -> Void = { _ in },
        onSend: @escaping (String, String) -> Void = { _, _ in },
        onAddMachine: @escaping (MachineEndpoint) -> Void = { _ in },
        onDismissError: @escaping () -> Void = {}
    ) {
        self.questions = questions
        self.sessions = sessions
        self.machines = machines
        _selectedMachineID = selectedMachineID
        self.errorMessage = errorMessage
        self.transcriptForSession = transcriptForSession
        self.questionsForSession = questionsForSession
        self.onAnswer = onAnswer
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        self.onOpenSession = onOpenSession
        self.onSend = onSend
        self.onAddMachine = onAddMachine
        self.onDismissError = onDismissError
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: RemiTheme.Spacing.l) {
                if let errorMessage {
                    ErrorBanner(message: errorMessage, onDismiss: onDismissError)
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
                    PhoneEmptyState(
                        systemImage: "rectangle.stack",
                        title: "No sessions",
                        message: emptySessionsMessage
                    )
                } else {
                    SessionsSection(
                        sessions: visibleSessions,
                        machines: visibleMachines,
                        transcriptForSession: transcriptForSession,
                        questionsForSession: questionsForSession,
                        onAnswer: onAnswer,
                        onSubmit: onSubmit,
                        onCancel: onCancel,
                        onOpenSession: onOpenSession,
                        onSend: onSend
                    )
                }

                if !machines.isEmpty {
                    MachinesSection(machines: machines)
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
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingPairing = true
                } label: {
                    Label("Add machine", systemImage: "plus")
                        .frame(minWidth: RemiTheme.Size.minimumTapTarget, minHeight: RemiTheme.Size.minimumTapTarget)
                        .contentShape(.rect)
                }
            }
        }
        .sheet(isPresented: $showingPairing) {
            NavigationStack {
                PairingScreen(onAddMachine: onAddMachine)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { showingPairing = false }
                        }
                    }
            }
        }
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
                    .lineLimit(1)
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
    let onAnswer: (String, String, String) -> Void
    let onSubmit: (String, String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String, String) -> Void
    let onOpenSession: (String) -> Void
    let onSend: (String, String) -> Void

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
                        NavigationLink {
                            SessionScreen(
                                session: session,
                                transcript: transcriptForSession(session.id),
                                questions: questionsForSession(session.id),
                                onAnswer: { onAnswer(session.id, $0, $1) },
                                onSubmit: { onSubmit(session.id, $0, $1) },
                                onCancel: { onCancel(session.id, $0) },
                                onSend: { onSend(session.id, $0) }
                            )
                            .onAppear { onOpenSession(session.id) }
                        } label: {
                            RemiSessionRow(session: session)
                        }
                        .buttonStyle(.plain)

                        if session.id != machineSessions.last?.id { Divider() }
                    }
                }
            }
        }
    }
}

private struct MachinesSection: View {
    let machines: [RemiMachineSummary]

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            Text("Machines").font(.title2.weight(.bold))
            ForEach(machines) { machine in
                RemiMachineRow(machine: machine)
                if machine.id != machines.last?.id { Divider() }
            }
        }
    }
}
