import RemiKit

/// One cell of the terminal grid as it is drawn: the text of a grapheme cluster and how many
/// grid columns it covers (ADR 0046/0047: basic wide and combining characters are preserved).
public struct RemiTerminalCell: Sendable, Equatable {
    public let text: String
    /// 1, or 2 for a wide (East Asian full-width or emoji) character.
    public let width: Int
}

/// The snapshot of a read-only terminal view prepared for drawing and for VoiceOver (#1639).
///
/// Pure: it escapes every cell for display (`RemiDisplayText`), measures wide characters so the
/// grid stays aligned, places the cursor in a cell, and writes the accessibility summary. There
/// is no color: the screen is monochrome (ADR 0046).
public struct RemiTerminalScreenPresentation: Sendable, Equatable {
    public struct Row: Sendable, Equatable, Identifiable {
        public let id: Int
        public let cells: [RemiTerminalCell]
        /// The grid column the cursor is on in this row, nil when the cursor is hidden or elsewhere.
        public let cursorColumn: Int?

        /// True when every cell is one column wide, so the row can be drawn as a single run of text.
        public var isUniformWidth: Bool { cells.allSatisfy { $0.width == 1 } }
        /// What VoiceOver reads for the row: its text (or "blank row") and, on the cursor's row, where
        /// the cursor is, so the cursor is reachable even though it is drawn as a block.
        public var accessibilityLabel: String {
            var label = text.isEmpty ? "blank row" : text
            if let cursorColumn { label += ", cursor at column \(cursorColumn + 1)" }
            return label
        }
        /// The row's text, escaped, as it would be copied.
        public var text: String { cells.map(\.text).joined() }
        /// The columns the row uses.
        public var usedColumns: Int { cells.reduce(0) { $0 + $1.width } }
    }

    public let columns: Int
    public let rows: [Row]
    public let revision: Int
    public let cursor: TerminalCursor?

    public init(_ snapshot: SessionTerminalSnapshot) {
        columns = snapshot.columns
        revision = snapshot.revision
        cursor = snapshot.cursor
        rows = snapshot.lines.enumerated().map { index, line in
            Row(
                id: index, cells: Self.cells(of: line),
                cursorColumn: snapshot.cursor?.row == index ? snapshot.cursor?.column : nil)
        }
    }

    /// The whole screen as text, one row per line with trailing blanks trimmed, for Copy.
    public var plainText: String {
        rows.map { row in
            var text = row.text
            while text.last == " " { text.removeLast() }
            return text
        }.joined(separator: "\n")
    }

    /// What VoiceOver says for the whole screen; the text itself is reachable by row.
    public var accessibilitySummary: String {
        let shown = rows.map { row -> String in
            var text = row.text
            while text.last == " " { text.removeLast() }
            return text
        }
        let used = shown.filter { !$0.isEmpty }
        var parts = ["Terminal screen, read only", "\(rows.count) rows, \(columns) columns"]
        if let cursor { parts.append("cursor on row \(cursor.row + 1), column \(cursor.column + 1)") }
        if let last = used.last {
            parts.append("last line: \(Self.clip(last))")
        } else {
            parts.append("the screen is blank")
        }
        return parts.joined(separator: ". ") + "."
    }

    /// The text of the cell the cursor is on, if any: the cursor can sit past the row's text.
    public func cursorCellIndex(in row: Row) -> Int? {
        guard let column = row.cursorColumn else { return nil }
        var start = 0
        for (index, cell) in row.cells.enumerated() {
            if column < start + cell.width { return index }
            start += cell.width
        }
        return nil
    }

    private static let clipLength = 120

    private static func clip(_ text: String) -> String {
        text.count > clipLength ? String(text.prefix(clipLength)) + "..." : text
    }

    private static func cells(of line: String) -> [RemiTerminalCell] {
        line.map { character in
            let raw = String(character)
            let shown = RemiDisplayText.escape(raw)
            // An escaped character is drawn as its visible escape, one column per mark.
            return RemiTerminalCell(text: shown, width: shown == raw ? width(of: character) : shown.count)
        }
    }

    /// Columns a grapheme cluster covers. Basic East Asian wide, full-width and emoji blocks are 2;
    /// anything else is 1. ADR 0046 and 0047 promise only that "basic wide/combining characters"
    /// are preserved by a Unicode 6 buffer and publish no width table, so this table is the app's
    /// own and is not extended on a guess. A host that counts differently misaligns the columns
    /// after such a character; it never loses or reorders text.
    static func width(of character: Character) -> Int {
        guard let first = character.unicodeScalars.first else { return 1 }
        switch first.value {
        case 0x1100...0x115F, 0x2E80...0x303E, 0x3041...0x33FF, 0x3400...0x4DBF, 0x4E00...0x9FFF,
            0xA000...0xA4CF, 0xAC00...0xD7A3, 0xF900...0xFAFF, 0xFE30...0xFE6F, 0xFF00...0xFF60,
            0xFFE0...0xFFE6, 0x1F300...0x1F64F, 0x1F900...0x1F9FF, 0x20000...0x3FFFD:
            return 2
        default:
            return 1
        }
    }
}
