import Foundation

/// Maps a vertical drag on a phone Board card to its nearest phone density.
public enum RemiBoardCardResize {
    public struct Adjustment: Equatable, Sendable {
        public let size: RemiTileSize
        public let span: Int

        public init(size: RemiTileSize, span: Int) {
            self.size = size
            self.span = span
        }
    }

    /// Extra trailing space that combines with tile and control padding to clear the 44 pt handle square.
    static let trailingControlInset =
        RemiTheme.Size.minimumTapTarget - (RemiTheme.Spacing.s + RemiTheme.Spacing.xs)

    /// Maps from the size at gesture start to the nearest density, clamping at Compact and Long.
    /// Non-phone starts use Medium, nonfinite translations keep that normalized start, and exact
    /// midpoint ties follow the drag direction. Down enlarges from the bottom corner; up from top.
    public static func size(
        startingAt startingSize: RemiTileSize,
        verticalTranslation: CGFloat,
        topCorner: Bool
    ) -> RemiTileSize {
        let densities = RemiTileSize.phoneDensities
        let compact = densities[0]
        let medium = densities[1]
        let long = densities[2]
        let start = densities.contains(startingSize) ? startingSize : medium
        guard verticalTranslation.isFinite else { return start }

        let translation = topCorner ? -verticalTranslation : verticalTranslation
        let compactBoundary = (compact.phoneCardHeight + medium.phoneCardHeight) / 2
        let longBoundary = (medium.phoneCardHeight + long.phoneCardHeight) / 2
        let proposedHeight = start.phoneCardHeight + translation
        let height = min(max(proposedHeight, compact.phoneCardHeight), long.phoneCardHeight)

        // At an exact midpoint, follow the drag direction so the handle changes size at the boundary.
        if height < compactBoundary || (height == compactBoundary && translation < 0) {
            return compact
        }
        if height > longBoundary || (height == longBoundary && translation > 0) {
            return long
        }
        return medium
    }

    /// Steps one phone density; direction is +1 for taller and -1 for shorter.
    public static func step(from size: RemiTileSize, direction: Int) -> RemiTileSize {
        let densities = RemiTileSize.phoneDensities
        let currentIndex = densities.firstIndex(of: size) ?? 1
        let step = direction > 0 ? 1 : direction < 0 ? -1 : 0
        let nextIndex = min(max(currentIndex + step, 0), densities.count - 1)
        return densities[nextIndex]
    }

    /// Maps a horizontal drag to its nearest column span. Midpoint ties follow the drag
    /// direction, and spans outside the current board are clamped without changing storage.
    public static func span(
        startingAt startingSpan: Int,
        horizontalTranslation: CGFloat,
        columnWidth: CGFloat,
        spacing: CGFloat,
        columnCount: Int
    ) -> Int {
        let columns = max(columnCount, 1)
        let start = min(max(startingSpan, 1), columns)
        guard horizontalTranslation.isFinite,
              columnWidth.isFinite, columnWidth > 0,
              spacing.isFinite, spacing >= 0
        else { return start }

        let proposedWidth = cardWidth(for: start, columnWidth: columnWidth, spacing: spacing)
            + horizontalTranslation
        var nearestSpan = start
        var nearestDistance = CGFloat.infinity
        for candidate in 1...columns {
            let candidateWidth = cardWidth(for: candidate, columnWidth: columnWidth, spacing: spacing)
            let distance = abs(candidateWidth - proposedWidth)
            if distance < nearestDistance {
                nearestSpan = candidate
                nearestDistance = distance
            } else if distance == nearestDistance,
                      (horizontalTranslation > 0 && candidate > nearestSpan
                       || horizontalTranslation < 0 && candidate < nearestSpan) {
                nearestSpan = candidate
            }
        }
        return nearestSpan
    }

    /// Steps one displayed span; direction is +1 for wider and -1 for narrower.
    public static func step(span: Int, direction: Int, columnCount: Int) -> Int {
        let columns = max(columnCount, 1)
        let current = min(max(span, 1), columns)
        let step = direction > 0 ? 1 : direction < 0 ? -1 : 0
        return min(max(current + step, 1), columns)
    }

    /// Maps both axes from one drag origin, so height and width can change together.
    public static func adjustment(
        startingAt startingSize: RemiTileSize,
        span startingSpan: Int,
        translation: CGSize,
        topCorner: Bool,
        columnWidth: CGFloat,
        spacing: CGFloat,
        columnCount: Int
    ) -> Adjustment {
        Adjustment(
            size: size(
                startingAt: startingSize,
                verticalTranslation: translation.height,
                topCorner: topCorner
            ),
            span: span(
                startingAt: startingSpan,
                horizontalTranslation: translation.width,
                columnWidth: columnWidth,
                spacing: spacing,
                columnCount: columnCount
            )
        )
    }

    private static func cardWidth(for span: Int, columnWidth: CGFloat, spacing: CGFloat) -> CGFloat {
        CGFloat(span) * columnWidth + CGFloat(span - 1) * spacing
    }
}
