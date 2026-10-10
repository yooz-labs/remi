import RemiUI
import Testing

struct TranscriptReviewTests {
    private let entries: [RemiTranscriptEntry] = [
        .user(id: "user", text: "Please inspect the cache"),
        .agent(id: "agent", text: "I found the CACHE issue"),
        .tool(id: "tool", name: "Read", summary: "Opened CacheStore.swift"),
        .error(id: "error", text: "Cache lookup failed"),
    ]

    @Test func searchesEveryTranscriptEntryKindCaseInsensitively() {
        var state = RemiTranscriptReviewState()

        state.update(query: "cache", entries: entries)

        #expect(state.matchingEntryIDs == ["user", "agent", "tool", "error"])
        #expect(state.selectedEntryID == "user")
        #expect(state.resultPosition == 1)
    }

    @Test func toolNameAndSummaryAreSearchableAndCopyable() {
        var state = RemiTranscriptReviewState()

        state.update(query: "read", entries: entries)
        #expect(state.matchingEntryIDs == ["tool"])

        state.update(query: "CacheStore", entries: entries)
        #expect(state.matchingEntryIDs == ["tool"])
        #expect(entries[2].copyText == "Read\nOpened CacheStore.swift")
    }

    @Test func navigationWrapsInBothDirections() {
        var state = RemiTranscriptReviewState()
        state.update(query: "cache", entries: entries)

        state.selectPrevious()
        #expect(state.selectedEntryID == "error")
        #expect(state.resultPosition == 4)

        state.selectNext()
        #expect(state.selectedEntryID == "user")
    }

    @Test func refreshPreservesSelectionWhenEntryStillMatches() {
        var state = RemiTranscriptReviewState()
        state.update(query: "cache", entries: entries)
        state.selectNext()

        state.refresh(entries: Array(entries.dropFirst()))

        #expect(state.selectedEntryID == "agent")
        #expect(state.resultPosition == 1)
    }

    @Test func whitespaceQueryAndResetClearReviewState() {
        var state = RemiTranscriptReviewState()
        state.update(query: "   \n", entries: entries)

        #expect(state.matchingEntryIDs.isEmpty)
        #expect(state.selectedEntryID == nil)

        state.update(query: "cache", entries: entries)
        state.reset()
        #expect(state == RemiTranscriptReviewState())
    }
}
