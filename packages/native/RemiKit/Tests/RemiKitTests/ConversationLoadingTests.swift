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

    @Test func aCRLFLineEndingIsAParagraphBreak() {
        // No spaces, so only the line breaks offer a natural cut. "\r\n" is one Character.
        let paragraph = String(repeating: "x", count: 400) + "\r\n"
        let text = String(repeating: paragraph, count: 10)
        let collapse = RemiMessageCollapse(text: text)
        #expect(collapse.isCollapsible)
        #expect(collapse.preview.count == 1_202)
        #expect(collapse.preview.hasSuffix("x"))
        #expect(text.hasPrefix(collapse.preview))
    }

    @Test func theCutNeverSplitsAGraphemeCluster() {
        let unit = "e\u{301}" + "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"
        let text = String(repeating: unit, count: 1_200)
        let collapse = RemiMessageCollapse(text: text)
        #expect(collapse.isCollapsible)
        #expect(collapse.preview.count == RemiMessageCollapse.characterLimit)
        #expect(collapse.preview.last == "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}")
        #expect(text.hasPrefix(collapse.preview))
    }

    @Test func collapsesExactlyAtTheMinimumHidden() {
        let atMinimum = String(repeating: "x", count: RemiMessageCollapse.characterLimit + RemiMessageCollapse.minimumHidden)
        let collapsed = RemiMessageCollapse(text: atMinimum)
        #expect(collapsed.isCollapsible)
        #expect(collapsed.hiddenCharacterCount == RemiMessageCollapse.minimumHidden)
        let belowMinimum = String(atMinimum.dropLast())
        #expect(!RemiMessageCollapse(text: belowMinimum).isCollapsible)
    }
}
