import RemiKit
import Testing
@testable import RemiUI

@Suite struct ConversationTabsTests {
    private func view(_ id: String, _ type: String = "general-purpose", active: Bool) -> SessionViewMeta {
        SessionViewMeta(agentId: id, agentType: type, active: active)
    }

    @Test func runningConversationsAreTabsAndFinishedOnesAreEarlier() {
        let tabs = RemiConversationTabs(
            views: [view("a", active: false), view("b", active: true), view("c", active: false)],
            selectedViewID: "")
        #expect(tabs.tabs.map(\.agentId) == ["b"])
        #expect(tabs.earlier.map(\.agentId) == ["a", "c"])
    }

    @Test func manyFinishedConversationsDoNotPushARunningOneOutOfSight() {
        // The session in the report: 51 finished subagents, then one running.
        let finished = (0..<51).map { view("old\($0)", active: false) }
        let tabs = RemiConversationTabs(views: finished + [view("now", "pr-review-toolkit", active: true)],
            selectedViewID: "")
        #expect(tabs.tabs.map(\.agentId) == ["now"])
        #expect(tabs.earlier.count == 51)
    }

    @Test func theOpenConversationStaysATabAfterItFinishes() {
        let tabs = RemiConversationTabs(
            views: [view("a", active: false), view("b", active: false)], selectedViewID: "b")
        #expect(tabs.tabs.map(\.agentId) == ["b"])
        #expect(tabs.earlier.map(\.agentId) == ["a"])
    }

    @Test func mainSelectedKeepsNoFinishedTab() {
        let tabs = RemiConversationTabs(views: [view("a", active: false)], selectedViewID: "")
        #expect(tabs.tabs.isEmpty)
        #expect(tabs.earlier.map(\.agentId) == ["a"])
    }

    @Test func noConversationsMakeNoTabsAndNoMenu() {
        let tabs = RemiConversationTabs(views: [], selectedViewID: "")
        #expect(tabs.tabs.isEmpty)
        #expect(tabs.earlier.isEmpty)
    }

    @Test func twoOfOneTypeAreNumberedByTheirIds() {
        let views = [view("a1", active: false), view("b2", active: true), view("c3", "Explore", active: true)]
        let tabs = RemiConversationTabs(views: views, selectedViewID: "")
        #expect(tabs.title(for: views[0]) == "general-purpose 1")
        #expect(tabs.title(for: views[1]) == "general-purpose 2")
        #expect(tabs.title(for: views[2]) == "Explore")
    }

    @Test func aTitleDoesNotChangeWhenTheDaemonReordersTheList() {
        // The daemon lists running agents first. When A finishes, the list becomes [B, A].
        let a = view("a1", active: true), b = view("b2", active: true)
        let before = RemiConversationTabs(views: [a, b], selectedViewID: "")
        let finished = view("a1", active: false)
        let after = RemiConversationTabs(views: [b, finished], selectedViewID: "")
        #expect(before.title(for: a) == after.title(for: finished))
        #expect(before.title(for: b) == after.title(for: b))
    }

    @Test func typesAreNumberedTogetherWhateverTheirCase() {
        let views = [view("a1", "Explore", active: true), view("b2", "explore", active: true)]
        let tabs = RemiConversationTabs(views: views, selectedViewID: "")
        #expect(tabs.title(for: views[0]) == "Explore 1")
        #expect(tabs.title(for: views[1]) == "explore 2")
    }

    @Test func aRepeatedAgentIdIsOneConversation() {
        let tabs = RemiConversationTabs(
            views: [view("a", active: true), view("a", active: true), view("b", active: false)],
            selectedViewID: "")
        #expect(tabs.tabs.map(\.agentId) == ["a"])
        #expect(tabs.earlier.map(\.agentId) == ["b"])
    }

    @Test func aRunningOpenConversationThatFinishesStaysATab() {
        let running = RemiConversationTabs(views: [view("a", active: true)], selectedViewID: "a")
        let finished = RemiConversationTabs(views: [view("a", active: false)], selectedViewID: "a")
        #expect(running.tabs.map(\.agentId) == ["a"])
        #expect(finished.tabs.map(\.agentId) == ["a"])
        #expect(finished.earlier.isEmpty)
    }

    @Test func aSelectionThatIsNotInTheListMakesNoExtraTab() {
        let tabs = RemiConversationTabs(views: [view("a", active: false)], selectedViewID: "gone")
        #expect(tabs.tabs.isEmpty)
        #expect(tabs.earlier.map(\.agentId) == ["a"])
    }

    @Test func aLoneAgentOfATypeIsNotNumbered() {
        let only = view("a", "code-reviewer", active: true)
        #expect(RemiConversationTabs(views: [only], selectedViewID: "").title(for: only) == "code-reviewer")
    }
}
