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

    @Test func deepLinkWaitsForAuthoritativeConversationMetadata() {
        #expect(RemiConversationSelection.reconciledViewID(
            selectedViewID: "reviewer",
            views: [],
            viewsLoaded: false
        ) == "reviewer")
        #expect(RemiConversationSelection.reconciledViewID(
            selectedViewID: "reviewer",
            views: views,
            viewsLoaded: true
        ) == "reviewer")
        #expect(RemiConversationSelection.reconciledViewID(
            selectedViewID: "missing",
            views: views,
            viewsLoaded: true
        ).isEmpty)
    }

    @Test func keyboardNavigationWrapsAcrossMainAndSubagents() {
        #expect(RemiConversationSelection.shiftedViewID(selectedViewID: "", views: views, offset: -1) == "reviewer")
        #expect(RemiConversationSelection.shiftedViewID(selectedViewID: "reviewer", views: views, offset: 1).isEmpty)
        #expect(RemiConversationSelection.shiftedViewID(selectedViewID: "researcher", views: views, offset: 1) == "reviewer")
        #expect(RemiConversationSelection.shiftedViewID(selectedViewID: "", views: views, offset: -4) == "reviewer")
    }

    @Test func duplicateAgentTypesReceiveCompactStableLabels() {
        let duplicateViews = [
            SessionViewMeta(agentId: "agent-123456", agentType: " Explore ", active: true),
            SessionViewMeta(agentId: "agent-abcdef", agentType: "explore", active: false),
            SessionViewMeta(agentId: "agent-review", agentType: "Reviewer", active: true),
        ]

        #expect(RemiConversationSelection.title(for: duplicateViews[0], among: duplicateViews) == "Explore · 123456")
        #expect(RemiConversationSelection.title(for: duplicateViews[1], among: duplicateViews) == "explore · abcdef")
        #expect(RemiConversationSelection.title(for: duplicateViews[2], among: duplicateViews) == "Reviewer")
    }

    @Test func subagentSelectionShowsItsQuestionsAndAnExplicitDeepLinkFocus() {
        let main = question(id: "main", agentID: nil)
        let reviewer = question(id: "review", agentID: "reviewer")
        let researcher = question(id: "research", agentID: "researcher")

        #expect(RemiConversationSelection.visibleQuestions(
            [main, reviewer, researcher],
            selectedViewID: "",
            focusedQuestionID: nil
        ).map(\.questionID) == ["main", "review", "research"])
        #expect(RemiConversationSelection.visibleQuestions(
            [main, reviewer, researcher],
            selectedViewID: "reviewer",
            focusedQuestionID: nil
        ).map(\.questionID) == ["review"])
        #expect(RemiConversationSelection.visibleQuestions(
            [main, reviewer, researcher],
            selectedViewID: "reviewer",
            focusedQuestionID: "research"
        ).map(\.questionID) == ["review", "research"])
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

    private func question(id: String, agentID: String?) -> RemiQuestionCardModel {
        RemiQuestionCardModel(
            id: id,
            kind: .permission,
            text: "Question",
            machineName: "Studio",
            sessionID: "session",
            sessionName: "Session",
            agentID: agentID
        )
    }
}
