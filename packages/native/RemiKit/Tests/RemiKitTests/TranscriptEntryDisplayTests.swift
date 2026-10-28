import Testing
@testable import RemiUI

@Suite struct TranscriptEntryDisplayTests {
    private let hostile = "run\u{202E}evil\u{0007}\nnext\tline"
    private let escaped = "run\\u202Eevil\\u0007\nnext\tline"

    @Test func everyTextFieldIsEscapedButNewlinesAndTabsStay() {
        #expect(RemiTranscriptEntry.user(id: "1", text: hostile).escapedForDisplay == .user(id: "1", text: escaped))
        #expect(RemiTranscriptEntry.agent(id: "2", text: hostile).escapedForDisplay == .agent(id: "2", text: escaped))
        #expect(RemiTranscriptEntry.error(id: "3", text: hostile).escapedForDisplay == .error(id: "3", text: escaped))
        #expect(
            RemiTranscriptEntry.tool(id: "4", name: "Bash\u{202E}", summary: hostile).escapedForDisplay
                == .tool(id: "4", name: "Bash\\u202E", summary: escaped)
        )
    }

    @Test func plainTextIsUnchanged() {
        let entry = RemiTranscriptEntry.agent(id: "a", text: "All tests pass. Done")
        #expect(entry.escapedForDisplay == entry)
    }
}
