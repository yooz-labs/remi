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

    @Test func twoOfOneTypeAreNumberedByPositionAmongAll() {
        let views = [view("a", active: false), view("b", active: true), view("c", "Explore", active: true)]
        let tabs = RemiConversationTabs(views: views, selectedViewID: "")
        #expect(tabs.title(for: views[0]) == "general-purpose 1")
        // Numbered among all, so the number does not change when the first one leaves the tabs.
        #expect(tabs.title(for: views[1]) == "general-purpose 2")
        #expect(tabs.title(for: views[2]) == "Explore")
    }

    @Test func aLoneAgentOfATypeIsNotNumbered() {
        let only = view("a", "code-reviewer", active: true)
        #expect(RemiConversationTabs(views: [only], selectedViewID: "").title(for: only) == "code-reviewer")
    }
}
