import Foundation
import Testing
@testable import RemiUI

@Suite struct TranscriptMarkupTests {
    @Test func preservesWhitespaceAndInlineEmphasis() {
        let value = RemiTranscriptMarkup.attributed("Keep  **this**\nline")

        #expect(String(value.characters) == "Keep  this\nline")
        #expect(value.runs.contains { run in
            run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
        })
    }

    @Test func keepsWebAndMailLinksButDropsUntrustedSchemes() {
        let value = RemiTranscriptMarkup.attributed(
            "[Web](https://example.com) [Mail](mailto:hello@example.com) [Run](javascript:alert(1))"
        )
        let links = value.runs.compactMap(\.link)

        #expect(links.map(\.scheme) == ["https", "mailto"])
        #expect(String(value.characters) == "Web Mail Run")
    }

    @Test func malformedMarkdownRemainsReadable() {
        let value = RemiTranscriptMarkup.attributed("Unclosed **emphasis and `code")
        #expect(!value.characters.isEmpty)
    }
}
