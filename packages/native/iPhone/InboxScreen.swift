import RemiKit
import RemiUI
import SwiftUI

struct InboxScreen: View {
    let questions: [RemiQuestionCardModel]
    let sessions: [RemiSessionSummary]
    let machines: [RemiMachineSummary]
    let sessionMachines: [MachineState]
    let errorMessage: String?
    let noticeMessage: String?
    let onAnswer: (String, String, String) -> Void
    let onSubmit: (String, String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String, String) -> Void
    let onNewSession: () -> Void
    let onOpenQuestionSession: (RemiQuestionCardModel) -> Void
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
        onNewSession: @escaping () -> Void = {},
        onOpenQuestionSession: @escaping (RemiQuestionCardModel) -> Void = { _ in },
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
        self.onNewSession = onNewSession
        self.onOpenQuestionSession = onOpenQuestionSession
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

                inboxContent
            }
            .padding(RemiTheme.Spacing.m)
        }
        .navigationTitle("Remi")
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
                            onNewSession()
                        }
                    }
                }
            } else {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("New session", systemImage: "plus.rectangle.on.folder") {
                            onNewSession()
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

    private var inboxState: RemiInboxPresentation.State {
        RemiInboxPresentation.state(
            machineCount: machines.count,
            questions: questions,
            activeSessionCount: sessions.count(where: \.isLive)
        )
    }

    @ViewBuilder private var inboxContent: some View {
        switch inboxState {
        case .firstRun:
            FirstRunScreen(onAddMachine: { onPresentPairing() })
        case .waiting(let cards, let notes):
            waitingContent(cards: cards, notes: notes)
        case .quiet(let activeSessionCount, let notes):
            quietContent(activeSessionCount: activeSessionCount, notes: notes)
        }
    }

    @ViewBuilder
    private func waitingContent(
        cards: [RemiQuestionCardModel],
        notes: [RemiQuestionCardModel]
    ) -> some View {
        NeedsYouSection(
            questions: cards,
            canOpenConversation: canOpenConversation,
            onAnswer: onAnswer,
            onSubmit: onSubmit,
            onCancel: onCancel,
            onOpenConversation: onOpenQuestionSession
        )
        ResolvedNotesSection(notes: notes)
    }

    @ViewBuilder
    private func quietContent(
        activeSessionCount: Int,
        notes: [RemiQuestionCardModel]
    ) -> some View {
        PhoneQuietInboxState(
            activeSessionCount: activeSessionCount,
            canCreateSession: !availableSessionMachines.isEmpty,
            onNewSession: onNewSession
        )
        ResolvedNotesSection(notes: notes)
    }

    private func canOpenConversation(_ card: RemiQuestionCardModel) -> Bool {
        RemiInboxPresentation.openTarget(for: card, sessions: sessions) != nil
    }

    private var availableSessionMachines: [MachineState] {
        sessionMachines.filter { $0.status == .connected }
    }

}

private struct PhoneQuietInboxState: View {
    let activeSessionCount: Int
    let canCreateSession: Bool
    let onNewSession: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label {
                Text("Nothing needs you")
            } icon: {
                Image(systemName: "checkmark.circle").accessibilityHidden(true)
            }
        } description: {
            Text(detail)
        } actions: {
            if canCreateSession {
                Button("New session", systemImage: "plus.rectangle.on.folder", action: onNewSession)
                    .buttonStyle(.glassProminent)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, RemiTheme.Spacing.l)
    }

    private var detail: String {
        let count = switch activeSessionCount {
        case 0: "No active sessions."
        case 1: "1 active session."
        default: "\(activeSessionCount) active sessions."
        }
        return "\(count) Open the menu to pick a session."
    }
}

private struct ResolvedNotesSection: View {
    let notes: [RemiQuestionCardModel]

    var body: some View {
        if !notes.isEmpty {
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
                Text("Resolved").font(.title2.weight(.bold))
                ForEach(notes) { note in
                    RemiQuestionCard(model: note, onAnswer: { _ in }, onSubmit: { _ in }, onCancel: {})
                }
            }
        }
    }
}

private struct NeedsYouSection: View {
    let questions: [RemiQuestionCardModel]
    let canOpenConversation: (RemiQuestionCardModel) -> Bool
    let onAnswer: (String, String, String) -> Void
    let onSubmit: (String, String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String, String) -> Void
    let onOpenConversation: (RemiQuestionCardModel) -> Void
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
                if canOpenConversation(question) {
                    OpenConversationButton(card: question) { onOpenConversation(question) }
                }
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

private struct OpenConversationButton: View {
    let card: RemiQuestionCardModel
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label("Open conversation", systemImage: "bubble.left.and.text.bubble.right")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: RemiTheme.Size.minimumTapTarget, alignment: .leading)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel("Open conversation \(card.sessionName) on \(card.machineName)")
        .accessibilityHint("Opens the conversation. Does not answer the request.")
    }
}
