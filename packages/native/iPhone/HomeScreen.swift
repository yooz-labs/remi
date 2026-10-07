import RemiKit
import RemiUI
import SwiftUI

struct HomeScreen: View {
    @State private var showingPairing = false
    let questions: [RemiQuestionCardModel]
    let sessions: [RemiSessionSummary]
    let machines: [RemiMachineSummary]
    let transcriptForSession: (String) -> [RemiTranscriptEntry]
    let questionsForSession: (String) -> [RemiQuestionCardModel]
    let onAnswer: (String, String, String) -> Void
    let onSubmit: (String, String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String, String) -> Void
    let onOpenSession: (String) -> Void
    let onSend: (String, String) -> Void
    let onAddMachine: (MachineEndpoint) -> Void

    init(
        questions: [RemiQuestionCardModel],
        sessions: [RemiSessionSummary],
        machines: [RemiMachineSummary],
        transcriptForSession: @escaping (String) -> [RemiTranscriptEntry] = { _ in RemiPreviewData.transcript },
        questionsForSession: @escaping (String) -> [RemiQuestionCardModel] = { _ in [] },
        onAnswer: @escaping (String, String, String) -> Void = { _, _, _ in },
        onSubmit: @escaping (String, String, [RemiQuestionStepSelection]) -> Void = { _, _, _ in },
        onCancel: @escaping (String, String) -> Void = { _, _ in },
        onOpenSession: @escaping (String) -> Void = { _ in },
        onSend: @escaping (String, String) -> Void = { _, _ in },
        onAddMachine: @escaping (MachineEndpoint) -> Void = { _ in }
    ) {
        self.questions = questions
        self.sessions = sessions
        self.machines = machines
        self.transcriptForSession = transcriptForSession
        self.questionsForSession = questionsForSession
        self.onAnswer = onAnswer
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        self.onOpenSession = onOpenSession
        self.onSend = onSend
        self.onAddMachine = onAddMachine
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: RemiTheme.Spacing.l) {
                if !questions.isEmpty {
                    NeedsYouSection(questions: questions)
                }

                if sessions.isEmpty {
                    PhoneEmptyState(
                        systemImage: "rectangle.stack",
                        title: "No sessions",
                        message: "Sessions from your connected machines will appear here."
                    )
                } else {
                    SessionsSection(
                        sessions: sessions,
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
        .navigationTitle("Remi")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingPairing = true
                } label: {
                    Label("Add machine", systemImage: "plus")
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
            ForEach(sessions) { session in
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

                if session.id != sessions.last?.id { Divider() }
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
