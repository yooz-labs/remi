import Testing
import RemiUI

struct ConversationLoadingTests {
    @Test func aLoadingConversationWithNothingYetShowsLoadingNotEmpty() {
        #expect(RemiConversationPlaceholder.resolve(isLoading: true, hasEntries: false) == .loading)
    }

    @Test func entriesStreamingInKeepTheLoadingHint() {
        #expect(RemiConversationPlaceholder.resolve(isLoading: true, hasEntries: true) == .loadingMore)
    }

    @Test func anIdleConversationIsEmptyOrShowsNothing() {
        #expect(RemiConversationPlaceholder.resolve(isLoading: false, hasEntries: false) == .empty)
        #expect(RemiConversationPlaceholder.resolve(isLoading: false, hasEntries: true) == .none)
    }
}

struct MessageCollapseTests {
    @Test func shortMessagesAreNeverCollapsed() {
        let collapse = RemiMessageCollapse(text: "Short and sweet.")
        #expect(!collapse.isCollapsible)
        #expect(collapse.preview == "Short and sweet.")
    }

    @Test func aMessageJustOverTheLimitIsNotWorthCollapsing() {
        let text = String(repeating: "a", count: RemiMessageCollapse.characterLimit + 100)
        #expect(!RemiMessageCollapse(text: text).isCollapsible)
    }

    @Test func aLongMessageCollapsesToAPreviewAtANaturalBreak() {
        let paragraph = String(repeating: "word ", count: 120) + "\n"
        let text = String(repeating: paragraph, count: 40)
        let collapse = RemiMessageCollapse(text: text)
        #expect(collapse.isCollapsible)
        #expect(collapse.preview.count <= RemiMessageCollapse.characterLimit)
        #expect(collapse.preview.count > RemiMessageCollapse.characterLimit / 2)
        #expect(text.hasPrefix(collapse.preview))
        #expect(!collapse.preview.hasSuffix(" "))
        #expect(collapse.hiddenCharacterCount == text.count - collapse.preview.count)
    }

    @Test func aHugeMessageWithoutBreaksIsCutAtTheLimit() {
        let text = String(repeating: "x", count: 50_000)
        let collapse = RemiMessageCollapse(text: text)
        #expect(collapse.isCollapsible)
        #expect(collapse.preview.count == RemiMessageCollapse.characterLimit)
    }
}
