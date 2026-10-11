import RemiKit
import Testing
@testable import RemiUI

@Suite struct ConversationPresentationTests {
    private let views = [
        SessionViewMeta(agentId: "researcher", agentType: "Researcher", active: true),
        SessionViewMeta(agentId: "reviewer", agentType: "Reviewer", active: false),
    ]

    @Test func keepsAvailableSelectionAndFallsBackWhenConversationDisappears() {
        #expect(RemiConversationSelection.resolvedViewID(selectedViewID: "reviewer", views: views) == "reviewer")
        #expect(RemiConversationSelection.resolvedViewID(selectedViewID: "missing", views: views).isEmpty)
    }

    @Test func keyboardNavigationWrapsAcrossMainAndSubagents() {
        #expect(RemiConversationSelection.shiftedViewID(selectedViewID: "", views: views, offset: -1) == "reviewer")
        #expect(RemiConversationSelection.shiftedViewID(selectedViewID: "reviewer", views: views, offset: 1).isEmpty)
        #expect(RemiConversationSelection.shiftedViewID(selectedViewID: "researcher", views: views, offset: 1) == "reviewer")
    }

    @Test func interactionStatePrioritizesFinishedThenReadOnlySubagentThenPrompt() {
        #expect(RemiSessionInteractionState.resolve(
            sessionIsLive: false,
            selectedViewID: "reviewer",
            hasWaitingQuestions: true
        ) == .finished)
        #expect(RemiSessionInteractionState.resolve(
            sessionIsLive: true,
            selectedViewID: "reviewer",
            hasWaitingQuestions: true
        ) == .liveSubagent)
        #expect(RemiSessionInteractionState.resolve(
            sessionIsLive: true,
            selectedViewID: "",
            hasWaitingQuestions: true
        ) == .liveMain(promptWaiting: true))
        #expect(RemiSessionInteractionState.resolve(
            sessionIsLive: true,
            selectedViewID: "",
            hasWaitingQuestions: false
        ) == .liveMain(promptWaiting: false))
    }
}
