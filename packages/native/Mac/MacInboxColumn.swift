import RemiKit
import RemiUI
import SwiftUI

/// The cross-machine Inbox: every card waiting for the person, on every machine, with the
/// same answer rules as the session conversation. Opening a card's conversation only
/// navigates; it never answers.
struct MacInboxColumn: View {
    let questions: [RemiQuestionCardModel]
    let sessions: [RemiSessionSummary]
    let machines: [RemiMachineSummary]
    let canCreateSession: Bool
    let onAnswer: (String, String, String, String) -> Void
    let onSubmit: (String, String, String, [RemiQuestionStepSelection]) -> Void
    let onCancel: (String, String, String) -> Void
    let onOpen: (RemiInboxPresentation.OpenTarget, String) -> Void
    let onNewSession: () -> Void

    var body: some View {
        Group {
            switch state {
            case .firstRun:
                ContentUnavailableView("No machines", systemImage: "desktopcomputer")
            case .waiting(let cards, let notes):
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: RemiTheme.Spacing.m) {
                        Text("Needs you")
                            .font(.title2.weight(.bold))
                            .accessibilityAddTraits(.isHeader)
                        ForEach(cards) { card in
                            cardView(card)
                        }
                        notesView(notes)
                    }
                    .padding(RemiTheme.Spacing.m)
                }
            case .quiet(let activeSessionCount, let hasConnectedMachine, let notes):
                let copy = RemiInboxPresentation.quietCopy(
                    activeSessionCount: activeSessionCount,
                    hasConnectedMachine: hasConnectedMachine,
                    unconnectedMachineCount: machines.count { $0.reachability != .connected }
                )
                ScrollView {
                    VStack(spacing: RemiTheme.Spacing.m) {
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
                                Button("New session", systemImage: "plus", action: onNewSession)
                                    .buttonStyle(.glassProminent)
                            }
                        }
                        notesView(notes)
                    }
                    .padding(RemiTheme.Spacing.m)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Inbox")
    }

    private var state: RemiInboxPresentation.State {
        RemiInboxPresentation.state(
            machineCount: machines.count,
            connectedMachineCount: machines.count { $0.reachability == .connected },
            questions: questions,
            activeSessionCount: RemiInboxPresentation.activeSessionCount(
                sessions: sessions,
                machines: machines
            )
        )
    }

    private func cardView(_ card: RemiQuestionCardModel) -> some View {
        VStack(alignment: .leading, spacing: RemiTheme.Spacing.xs) {
            RemiQuestionCard(
                model: card,
                onAnswer: { onAnswer(card.machineID, card.sessionID, card.questionID, $0) },
                onSubmit: { onSubmit(card.machineID, card.sessionID, card.questionID, $0) },
                onCancel: { onCancel(card.machineID, card.sessionID, card.questionID) }
            )
            if let target = RemiInboxPresentation.openTarget(for: card, sessions: sessions) {
                Button {
                    onOpen(target, card.questionID)
                } label: {
                    Label("Open conversation", systemImage: "bubble.left.and.text.bubble.right")
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Open conversation \(card.sessionName) on \(card.machineName)")
                .accessibilityHint("Opens the conversation. Does not answer the request.")
            }
        }
    }

    @ViewBuilder
    private func notesView(_ notes: [RemiQuestionCardModel]) -> some View {
        if !notes.isEmpty {
            VStack(alignment: .leading, spacing: RemiTheme.Spacing.s) {
                Text("Resolved")
                    .font(.title2.weight(.bold))
                    .accessibilityAddTraits(.isHeader)
                ForEach(notes) { note in
                    RemiQuestionCard(model: note, onAnswer: { _ in }, onSubmit: { _ in }, onCancel: {})
                }
            }
        }
    }
}
