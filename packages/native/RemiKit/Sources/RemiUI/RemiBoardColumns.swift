import SwiftUI

/// Resolves a Board pane width into a responsive group of readable card columns.
public struct RemiBoardColumns: Equatable, Sendable {
    public let columnCount: Int
    public let cardWidth: CGFloat
    public let groupWidth: CGFloat

    public static let minimumCardWidth: CGFloat = 300
    public static let spacing: CGFloat = 12
    public static let margin: CGFloat = 16
    public static let hysteresis: CGFloat = 24
    public static let sidebarBesideMinimumWindowWidth: CGFloat = 1_000

    public static func resolve(
        paneWidth: CGFloat,
        previousColumnCount: Int? = nil
    ) -> RemiBoardColumns {
        let empty = Self(columnCount: 1, cardWidth: 0, groupWidth: 0)
        guard paneWidth.isFinite, paneWidth > 2 * margin else { return empty }

        let availableWidth = paneWidth - 2 * margin
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

        let cardWidth: CGFloat
        if columnCount == 1 {
            cardWidth = min(availableWidth, RemiTheme.Size.readableContentWidth)
        } else {
            let widthForEachCard = (availableWidth - spacing * CGFloat(columnCount - 1)) / CGFloat(columnCount)
            cardWidth = min(widthForEachCard, RemiTheme.Size.readableContentWidth)
        }
        let groupWidth = cardWidth * CGFloat(columnCount) + spacing * CGFloat(columnCount - 1)

        return Self(columnCount: columnCount, cardWidth: cardWidth, groupWidth: groupWidth)
    }

    public static func sidebarBeside(windowWidth: CGFloat) -> Bool {
        windowWidth >= sidebarBesideMinimumWindowWidth
    }

    private static func startWidth(for columnCount: Int) -> CGFloat {
        2 * margin + CGFloat(columnCount) * minimumCardWidth + CGFloat(columnCount - 1) * spacing
    }
}
