import SwiftUI

/// The phone card options that follow the Board's resolved column count.
public struct RemiBoardCardPresentation: Equatable, Sendable {
    public let columnCount: Int

    public init(columnCount: Int) {
        self.columnCount = columnCount
    }

    public var isMultiColumn: Bool { columnCount >= 2 }
    public var sizeChoices: [RemiTileSize] { isMultiColumn ? RemiTileSize.phoneDensities : [] }
    public var growsToContent: Bool { isMultiColumn }
}

/// The placement of one input item in the flat Board tile tree.
/// `itemIndex` is a zero-based index into the caller's input; `firstColumn` is a zero-based
/// column index; `span` is a count of adjacent columns.
public struct RemiBoardColumnPlacement: Equatable, Sendable {
    public let itemIndex: Int
    public let firstColumn: Int
    public let span: Int

    public init(itemIndex: Int, firstColumn: Int, span: Int) {
        self.itemIndex = itemIndex
        self.firstColumn = firstColumn
        self.span = span
    }

    /// Whether this placement covers valid columns in a Board with the given count.
    public func isValid(columnCount: Int) -> Bool {
        let columns = max(columnCount, 1)
        return firstColumn >= 0
            && firstColumn <= columns
            && span >= 1
            && span <= columns - firstColumn
    }

    /// The card's width in points, including the gaps between its columns.
    public func width(columnWidth: CGFloat, spacing: CGFloat) -> CGFloat {
        CGFloat(span) * columnWidth + CGFloat(span - 1) * spacing
    }
}

/// Resolves a Board pane width into a responsive group of readable card columns.
///
/// While a column is held during a one-column drop, `cardWidth` can be up to
/// `hysteresis / columnCount` points narrower than `minimumCardWidth`.
public struct RemiBoardColumns: Equatable, Sendable {
    public let columnCount: Int
    public let cardWidth: CGFloat

    /// The full width occupied by the columns and their spacing, which the caller centers.
    public let groupWidth: CGFloat

    /// The 300 pt card minimum from design rule 2 in
    /// `packages/native/handoff/ipad-board.md`, "The rule".
    /// A held column may fall below it by up to `hysteresis / columnCount` points.
    public static let minimumCardWidth: CGFloat = 300

    /// The 12 pt spacing from design rule 2 in
    /// `packages/native/handoff/ipad-board.md`, "The rule".
    public static let spacing: CGFloat = 12

    /// The 16 pt outer margin from design rule 2 in
    /// `packages/native/handoff/ipad-board.md`, "The rule".
    public static let margin: CGFloat = 16

    /// The 24 pt drop allowance from design rule 2 in
    /// `packages/native/handoff/ipad-board.md`, "The rule".
    public static let hysteresis: CGFloat = 24

    /// The 1000 pt sidebar threshold from design rule 1 in
    /// `packages/native/handoff/ipad-board.md`, "The rule".
    public static let sidebarBesideMinimumWindowWidth: CGFloat = 1_000

    /// Resolves the columns and card width for the pane's width, in points.
    ///
    /// Pass the count this function returned for the previous layout of the same pane as
    /// `previousColumnCount`. `nil`, 1 and values outside 2 through 6 disable holding a
    /// column through a one-column drop. A nonfinite pane or one not wider than the combined
    /// margins (`2 * margin`) returns one column with zero widths. A pane just wider than
    /// the combined margins returns one column with its remaining width unchanged, even
    /// below `minimumCardWidth`.
    public static func resolve(
        paneWidth: CGFloat,
        previousColumnCount: Int? = nil
    ) -> RemiBoardColumns {
        let empty = Self(columnCount: 1, cardWidth: 0, groupWidth: 0)
        guard paneWidth.isFinite, paneWidth > 2 * margin else { return empty }

        // Keep the delegated arithmetic finite and comfortably within Int's range.
        let availableWidth = min(paneWidth - 2 * margin, 1_000_000)
        let rawColumnCount = RemiBoardOrder.columnCount(
            width: availableWidth,
            minimumTile: minimumCardWidth,
            spacing: spacing
        )
        let columnCount: Int
        if let previousColumnCount,
           (2...RemiBoardOrder.maximumColumns).contains(previousColumnCount),
           rawColumnCount == previousColumnCount - 1,
           paneWidth >= Self.startWidth(for: previousColumnCount) - hysteresis {
            columnCount = previousColumnCount
        } else {
            columnCount = rawColumnCount
        }

        let widthForEachCard = (availableWidth - spacing * CGFloat(columnCount - 1)) / CGFloat(columnCount)
        let cardWidth = min(widthForEachCard, RemiTheme.Size.readableContentWidth)
        let groupWidth = cardWidth * CGFloat(columnCount) + spacing * CGFloat(columnCount - 1)

        return Self(columnCount: columnCount, cardWidth: cardWidth, groupWidth: groupWidth)
    }

    /// Screen-facing placement engine used by PhoneBoardScreen. It places items in reading order
    /// into the adjacent window whose tallest column is shortest; ties choose the leftmost window.
    /// `itemCount` and `columnCount` are counts; heights and spacing are points, and spans are
    /// column counts. Missing heights use the regular phone card height, missing spans use one,
    /// and spans clamp to the available columns. Extra heights and spans are ignored.
    public static func placements(
        itemCount: Int,
        columnCount: Int,
        heights: [CGFloat] = [],
        spans: [Int] = [],
        spacing: CGFloat = RemiBoardColumns.spacing
    ) -> [RemiBoardColumnPlacement] {
        let columns = max(columnCount, 1)
        let itemHeights = (0..<max(itemCount, 0)).map { index in
            heights.indices.contains(index) ? heights[index] : RemiTileSize.regular.phoneCardHeight
        }
        var filled = [CGFloat](repeating: 0, count: columns)
        var result: [RemiBoardColumnPlacement] = []

        for (index, height) in itemHeights.enumerated() {
            let span = min(max(spans.indices.contains(index) ? spans[index] : 1, 1), columns)
            var firstColumn = 0
            var startHeight = CGFloat.greatestFiniteMagnitude
            for candidate in 0...(columns - span) {
                let windowHeight = filled[candidate..<(candidate + span)].max() ?? 0
                if windowHeight < startHeight {
                    firstColumn = candidate
                    startHeight = windowHeight
                }
            }

            result.append(RemiBoardColumnPlacement(itemIndex: index, firstColumn: firstColumn, span: span))
            let nextHeight = startHeight + height + spacing
            for column in firstColumn..<(firstColumn + span) {
                filled[column] = nextHeight
            }
        }
        return result
    }

    /// Compatibility wrapper for span-one items, mapped back into columns. The screen uses
    /// ``placements(itemCount:columnCount:heights:spans:spacing:)`` to keep each tile in one flat layout.
    public static func place<Item>(
        _ items: [Item],
        columnCount: Int,
        heights: [CGFloat] = []
    ) -> [[Item]] {
        var result = [[Item]](repeating: [], count: max(columnCount, 1))
        for placement in placements(
            itemCount: items.count,
            columnCount: columnCount,
            heights: heights
        ) {
            result[placement.firstColumn].append(items[placement.itemIndex])
        }
        return result
    }

    /// Applies design rule 1 from `packages/native/handoff/ipad-board.md`, "The rule".
    /// This shell-level rule stays beside the pane thresholds; slice 2 uses it from the shell.
    public static func sidebarBeside(windowWidth: CGFloat) -> Bool {
        windowWidth >= sidebarBesideMinimumWindowWidth
    }

    private static func startWidth(for columnCount: Int) -> CGFloat {
        2 * margin + CGFloat(columnCount) * minimumCardWidth + CGFloat(columnCount - 1) * spacing
    }
}
