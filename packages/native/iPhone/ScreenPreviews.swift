#if DEBUG
import RemiKit
import RemiUI
import SwiftUI

private struct HomePreview: View {
    let questions: [RemiQuestionCardModel]
    let sessions: [RemiSessionSummary]
    let machines: [RemiMachineSummary]

    var body: some View {
        NavigationStack {
            HomeScreen(questions: questions, sessions: sessions, machines: machines)
        }
    }
}

private struct SessionPreview: View {
    var initialConversationID: String? = nil
    var initialQuestionID: String? = nil

    var body: some View {
        NavigationStack {
            SessionScreen(
                session: RemiPreviewData.primarySession,
                transcript: RemiPreviewData.transcript,
                questions: [RemiPreviewData.binaryQuestion],
                views: [
                    SessionViewMeta(agentId: "explore", agentType: "Explore", active: true),
                    SessionViewMeta(agentId: "review", agentType: "code-reviewer", active: false),
                ],
                initialConversationID: initialConversationID,
                initialQuestionID: initialQuestionID,
                transcriptForView: { _ in RemiPreviewData.transcript }
            )
        }
    }
}

private struct PairingPreview: View {
    var draft = AddMachineDraft()

    var body: some View {
        NavigationStack { PairingScreen(draft: draft) }
    }
}

private var rejectedRelayDraft: AddMachineDraft {
    struct Rejected: Error {}
    let draft = AddMachineDraft { _ in throw Rejected() }
    draft.mode = .relay
    draft.relayToken = "expired-token"
    _ = draft.makeEndpoint()
    return draft
}

private struct FirstRunPreview: View {
    var body: some View {
        NavigationStack { FirstRunScreen() }
    }
}

private struct EmptyHomePreview: View {
    var body: some View {
        HomePreview(questions: [], sessions: [], machines: RemiPreviewData.machines)
    }
}

#Preview("Home · Light") { HomePreview(questions: [RemiPreviewData.binaryQuestion], sessions: RemiPreviewData.sessions, machines: RemiPreviewData.machines).preferredColorScheme(.light) }
#Preview("Home · Dark") { HomePreview(questions: [RemiPreviewData.binaryQuestion], sessions: RemiPreviewData.sessions, machines: RemiPreviewData.machines).preferredColorScheme(.dark) }
#Preview("Home · Accessibility") { HomePreview(questions: [RemiPreviewData.binaryQuestion], sessions: RemiPreviewData.sessions, machines: RemiPreviewData.machines).environment(\.dynamicTypeSize, .accessibility5) }
#Preview("Home · Stored session") { HomePreview(questions: [], sessions: Array(RemiPreviewData.sessions.suffix(1)), machines: Array(RemiPreviewData.machines.prefix(1))).preferredColorScheme(.light) }

#Preview("Session · Light") { SessionPreview().preferredColorScheme(.light) }
#Preview("Session · Dark") { SessionPreview().preferredColorScheme(.dark) }
#Preview("Session · Accessibility") { SessionPreview().environment(\.dynamicTypeSize, .accessibility5) }
#Preview("Session · Notification focus") {
    SessionPreview(initialQuestionID: RemiPreviewData.binaryQuestion.questionID)
}
#Preview("Session · Subagent question focus") {
    SessionPreview(
        initialConversationID: "explore",
        initialQuestionID: RemiPreviewData.binaryQuestion.questionID
    )
}

#Preview("Pairing · Light") { PairingPreview().preferredColorScheme(.light) }
#Preview("Pairing · Dark") { PairingPreview().preferredColorScheme(.dark) }
#Preview("Pairing · Accessibility") { PairingPreview().environment(\.dynamicTypeSize, .accessibility5) }
#Preview("Pairing · Relay error") { PairingPreview(draft: rejectedRelayDraft) }

#Preview("First Run · Light") { FirstRunPreview().preferredColorScheme(.light) }
#Preview("First Run · Dark") { FirstRunPreview().preferredColorScheme(.dark) }
#Preview("First Run · Accessibility") { FirstRunPreview().environment(\.dynamicTypeSize, .accessibility5) }

#Preview("Empty · Light") { EmptyHomePreview().preferredColorScheme(.light) }
#Preview("Empty · Dark") { EmptyHomePreview().preferredColorScheme(.dark) }
#Preview("Empty · Accessibility") { EmptyHomePreview().environment(\.dynamicTypeSize, .accessibility5) }
#endif
