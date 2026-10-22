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
    let onOpenQuestionSession: (RemiInboxPresentation.OpenTarget, String) -> Void
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
        onOpenQuestionSession: @escaping (RemiInboxPresentation.OpenTarget, String) -> Void = { _, _ in },
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
            connectedMachineCount: machines.count { $0.reachability == .connected },
            questions: questions,
            activeSessionCount: RemiInboxPresentation.activeSessionCount(sessions: sessions, machines: machines)
        )
    }

    @ViewBuilder private var inboxContent: some View {
        switch inboxState {
        case .firstRun:
            FirstRunScreen(onAddMachine: { onPresentPairing() })
        case .waiting(let cards, let notes):
            waitingContent(cards: cards, notes: notes)
        case .quiet(let activeSessionCount, let hasConnectedMachine, let notes):
            quietContent(
                activeSessionCount: activeSessionCount,
                hasConnectedMachine: hasConnectedMachine,
                notes: notes
            )
        }
    }

    @ViewBuilder
    private func waitingContent(
        cards: [RemiQuestionCardModel],
        notes: [RemiQuestionCardModel]
    ) -> some View {
        NeedsYouSection(
            questions: cards,
            openTarget: openTarget,
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
        hasConnectedMachine: Bool,
        notes: [RemiQuestionCardModel]
    ) -> some View {
        PhoneQuietInboxState(
            copy: RemiInboxPresentation.quietCopy(
                activeSessionCount: activeSessionCount,
                hasConnectedMachine: hasConnectedMachine,
                unconnectedMachineCount: machines.count { $0.reachability != .connected }
            ),
            canCreateSession: !availableSessionMachines.isEmpty,
            onNewSession: onNewSession
        )
        ResolvedNotesSection(notes: notes)
    }

    private func openTarget(_ card: RemiQuestionCardModel) -> RemiInboxPresentation.OpenTarget? {
        RemiInboxPresentation.openTarget(for: card, sessions: sessions)
    }

    private var availableSessionMachines: [MachineState] {
        sessionMachines.filter { $0.status == .connected }
    }

}

private struct PhoneQuietInboxState: View {
    let copy: RemiInboxPresentation.QuietCopy
    let canCreateSession: Bool
    let onNewSession: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label {
                Text(copy.title)
            } icon: {
                Image(systemName: copy.symbolName).accessibilityHidden(true)
            }
        } description: {
            Text(copy.detail)
        } actions: {
            if canCreateSession {
                Button("New session", systemImage: "plus.rectangle.on.folder", action: onNewSession)
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, RemiTheme.Spacing.l)
    }
}

private struct ResolvedNotesSection: View {
    let notes: [RemiQuestionCardModel]

    var body: some View {
        if !notes.isEmpty {
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
                Text("Resolved").font(.title2.weight(.bold))
                    .accessibilityAddTraits(.isHeader)
                ForEach(notes) { note in
                    RemiQuestionCard(model: note, onAnswer: { _ in }, onSubmit: { _ in }, onCancel: {})
                }
            }
        }
    }
}

private struct NeedsYouSection: View {
    let questions: [RemiQuestionCardModel]
    let openTarget: (RemiQuestionCardModel) -> RemiInboxPresentation.OpenTarget?
    let onAnswer: (String, String, String) -> Void
    let onSubmit: (String, String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String, String) -> Void
    let onOpenConversation: (RemiInboxPresentation.OpenTarget, String) -> Void
    @State private var showsAllQuestions = false

    var body: some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
            Text("Needs you").font(.title2.weight(.bold))
                .accessibilityAddTraits(.isHeader)
            ForEach(displayedQuestions) { question in
                // The link sits closer to its card than the cards sit to each other.
                VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
                    RemiQuestionCard(
                        model: question,
                        onAnswer: { onAnswer(question.sessionID, question.questionID, $0) },
                        onSubmit: { onSubmit(question.sessionID, question.questionID, $0) },
                        onCancel: { onCancel(question.sessionID, question.questionID) }
                    )
                    if let target = openTarget(question) {
                        OpenConversationButton(card: question) {
                            onOpenConversation(target, question.questionID)
                        }
                    }
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
        .onChange(of: questions.count) { _, count in
            showsAllQuestions = RemiInboxPresentation.keepsExpanded(
                wasExpanded: showsAllQuestions,
                cardCount: count
            )
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
