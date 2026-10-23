import Foundation
import Testing

@testable import RemiKit
@testable import RemiUI

struct RemiTerminalScreenPresentationTests {
    static func snapshot(_ lines: [String], columns: Int = 20, cursor: TerminalCursor? = nil) -> SessionTerminalSnapshot {
        SessionTerminalSnapshot(
            header: WireHeader(
                id: "00000000-0000-4000-8000-000000000001", timestamp: "2026-10-22T00:00:00.000Z",
                sessionId: "00000000-0000-4000-8000-000000000003"),
            requestId: "00000000-0000-4000-8000-000000000002", viewId: "AAECAwQFBgcICQoLDA0ODw", revision: 0,
            columns: columns, rows: lines.count, lines: lines, cursor: cursor)
    }

    @Test func goldenSnapshotPreviewIsTheGoldenFrame() throws {
        let golden = try TerminalViewMessage.decode(FixtureConformanceTests.fixture("session_terminal_snapshot"))
        #expect(golden == .snapshot(RemiPreviewData.fixtureTerminalSnapshot))
    }

    @Test func goldenFrameHasWideCharacterAndCursorOnIt() {
        let p = RemiTerminalScreenPresentation(RemiPreviewData.fixtureTerminalSnapshot)
        #expect(p.columns == 20)
        #expect(p.rows.count == 4)
        let wide = p.rows[1]
        #expect(wide.cells.map(\.width) == [2, 1])
        #expect(wide.isUniformWidth == false)
        #expect(wide.usedColumns == 3)
        #expect(wide.cursorColumn == 3)
        // Column 3 is past the 3 columns the text covers: the cursor sits after the text.
        #expect(p.cursorCellIndex(in: wide) == nil)
        #expect(p.rows[0].cursorColumn == nil)
        #expect(p.rows[0].isUniformWidth)
    }

    @Test func cursorOnAWideCellUsesItsFirstColumnAndItsSecond() {
        let snap = Self.snapshot(["界x"], cursor: TerminalCursor(row: 0, column: 1))
        let p = RemiTerminalScreenPresentation(snap)
        #expect(p.cursorCellIndex(in: p.rows[0]) == 0)
        let after = RemiTerminalScreenPresentation(Self.snapshot(["界x"], cursor: TerminalCursor(row: 0, column: 2)))
        #expect(after.cursorCellIndex(in: after.rows[0]) == 1)
    }

    @Test func combiningMarksStayInOneCell() {
        let p = RemiTerminalScreenPresentation(Self.snapshot(["e\u{301}x"]))
        #expect(p.rows[0].cells.count == 2)
        #expect(p.rows[0].cells[0].width == 1)
    }

    @Test func emojiAndFullwidthAreTwoColumns() {
        let p = RemiTerminalScreenPresentation(Self.snapshot(["\u{1F600}Ａ"]))
        #expect(p.rows[0].cells.map(\.width) == [2, 2])
    }

    @Test func unsafeTextIsEscapedAndNeverRaw() {
        // The wire refuses controls, but the view must not trust that: it escapes anyway.
        let p = RemiTerminalScreenPresentation(Self.snapshot(["a\u{202E}b\u{1B}c"]))
        let text = p.rows[0].text
        #expect(!text.unicodeScalars.contains { $0.value == 0x202E || $0.value == 0x1B })
        #expect(text.contains("\\u202E") || text.contains("\\u{202E}") || text.contains("202E"))
        #expect(p.plainText == text)
    }

    @Test func plainTextTrimsTrailingBlanksAndKeepsRows() {
        let p = RemiTerminalScreenPresentation(Self.snapshot(["ab   ", "", "c"]))
        #expect(p.plainText == "ab\n\nc")
    }

    @Test func summaryNamesReadOnlySizeCursorAndLastLine() {
        let p = RemiTerminalScreenPresentation(RemiPreviewData.wideTerminalSnapshot)
        let summary = p.accessibilitySummary
        #expect(summary.hasPrefix("Terminal screen, read only."))
        #expect(summary.contains("24 rows, 80 columns"))
        #expect(summary.contains("cursor on row 12, column 10"))
        #expect(summary.contains("last line: ~/remi $"))
    }

    @Test func blankScreenSaysSoAndHiddenCursorIsOmitted() {
        let p = RemiTerminalScreenPresentation(Self.snapshot(["", ""]))
        #expect(p.accessibilitySummary == "Terminal screen, read only. 2 rows, 20 columns. the screen is blank.")
    }

    @Test func longLastLineIsClippedInTheSummary() {
        let long = String(repeating: "x", count: 200)
        let p = RemiTerminalScreenPresentation(Self.snapshot([long], columns: 240))
        #expect(p.accessibilitySummary.contains(String(repeating: "x", count: 120) + "..."))
        #expect(!p.accessibilitySummary.contains(String(repeating: "x", count: 121)))
    }

    @Test func widePreviewIsAValidFullScreen() {
        let snap = RemiPreviewData.wideTerminalSnapshot
        #expect(snap.lines.count == 24 && snap.columns == 80)
    }
}
