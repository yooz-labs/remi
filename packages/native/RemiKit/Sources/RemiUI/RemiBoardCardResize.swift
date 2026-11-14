import Foundation

/// Maps a vertical drag on a phone Board card to its nearest phone density.
public enum RemiBoardCardResize {
    /// Maps the drag from the card's size at gesture start. Dragging away from either corner
    /// follows the finger: down enlarges from the bottom corner, while up enlarges from the top.
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
}
