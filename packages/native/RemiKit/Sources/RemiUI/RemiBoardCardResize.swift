import Foundation

/// Maps a vertical drag on a phone Board card to its nearest phone density.
public enum RemiBoardCardResize {
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
}
