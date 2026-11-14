import SwiftUI

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

    /// Applies design rule 1 from `packages/native/handoff/ipad-board.md`, "The rule".
    /// This shell-level rule stays beside the pane thresholds; slice 2 uses it from the shell.
    public static func sidebarBeside(windowWidth: CGFloat) -> Bool {
        windowWidth >= sidebarBesideMinimumWindowWidth
    }

    private static func startWidth(for columnCount: Int) -> CGFloat {
        2 * margin + CGFloat(columnCount) * minimumCardWidth + CGFloat(columnCount - 1) * spacing
    }
}
