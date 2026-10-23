import RemiKit
import SwiftUI

/// A read-only, monochrome view of a terminal screen (ADR 0046, #1639).
///
/// - A monospaced grid of exactly `columns` by `rows`. The grid scrolls sideways (and up and
///   down) when Dynamic Type makes it wider than the space it has; it never wraps a row.
/// - Text is escaped for display and selectable. A row with a wide character is drawn cell by
///   cell so the columns after it stay aligned; such a row is not selectable, so the Copy
///   action in the context menu always copies the whole screen.
/// - The cursor is a filled block, so it never depends on color. There are no colors and no
///   input: the screen cannot be typed into.
/// - VoiceOver reads a summary of the screen with a "read only" note; each row is reachable.
public struct RemiTerminalScreenView: View {
    let presentation: RemiTerminalScreenPresentation

    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 13

    public init(snapshot: SessionTerminalSnapshot) {
        presentation = RemiTerminalScreenPresentation(snapshot)
    }

    private var cellWidth: CGFloat { fontSize * 0.6 }
    private var rowHeight: CGFloat { (fontSize * 1.25).rounded(.up) }
    private var font: Font { .system(size: fontSize, design: .monospaced) }

    public var body: some View {
        ScrollView([.horizontal, .vertical]) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(presentation.rows) { row in
                    rowView(row)
                        .frame(height: rowHeight, alignment: .leading)
                        .accessibilityLabel(row.text.isEmpty ? "blank row" : row.text)
                }
            }
            .padding(RemiTheme.Spacing.s)
            .frame(minWidth: cellWidth * CGFloat(presentation.columns) + RemiTheme.Spacing.s * 2, alignment: .leading)
            .textSelection(.enabled)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(RemiTheme.Color.surface, in: RoundedRectangle(cornerRadius: RemiTheme.Radius.control))
        .overlay {
            RoundedRectangle(cornerRadius: RemiTheme.Radius.control).stroke(RemiTheme.Color.hairline)
        }
        .contextMenu {
            Button("Copy screen", systemImage: "doc.on.doc") { copy(presentation.plainText) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(presentation.accessibilitySummary)
    }

    @ViewBuilder
    private func rowView(_ row: RemiTerminalScreenPresentation.Row) -> some View {
        if row.isUniformWidth && row.cursorColumn == nil {
            Text(row.text.isEmpty ? " " : row.text)
                .font(font)
                .lineLimit(1)
                .fixedSize()
        } else {
            let cursorIndex = presentation.cursorCellIndex(in: row)
            HStack(spacing: 0) {
                ForEach(Array(row.cells.enumerated()), id: \.offset) { index, cell in
                    cellView(cell, isCursor: index == cursorIndex)
                }
                if row.cursorColumn != nil, cursorIndex == nil {
                    // The cursor can sit past the last character of a row.
                    cursorBlock(cell: nil)
                        .padding(.leading, cellWidth * CGFloat(max(0, (row.cursorColumn ?? 0) - row.usedColumns)))
                }
            }
        }
    }

    private func cellView(_ cell: RemiTerminalCell, isCursor: Bool) -> some View {
        Group {
            if isCursor {
                cursorBlock(cell: cell)
            } else {
                Text(cell.text).font(font).lineLimit(1).fixedSize()
            }
        }
        .frame(width: cellWidth * CGFloat(cell.width), alignment: .leading)
    }

    /// An inverted block: the cell's own text on a primary-colored fill.
    private func cursorBlock(cell: RemiTerminalCell?) -> some View {
        Text(cell?.text ?? " ")
            .font(font)
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(.background)
            .background(.primary)
            .frame(width: cellWidth * CGFloat(cell?.width ?? 1), alignment: .leading)
            .accessibilityLabel("cursor")
    }

    private func copy(_ text: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}

#if DEBUG
#Preview("Golden snapshot, wide and combining") {
    RemiTerminalScreenView(snapshot: RemiPreviewData.fixtureTerminalSnapshot)
        .frame(height: 140)
        .padding()
}

#Preview("80 by 24 screen") {
    RemiTerminalScreenView(snapshot: RemiPreviewData.wideTerminalSnapshot)
        .padding()
}

#Preview("80 by 24 at accessibility size") {
    RemiTerminalScreenView(snapshot: RemiPreviewData.wideTerminalSnapshot)
        .environment(\.dynamicTypeSize, .accessibility3)
        .padding()
}
#endif
