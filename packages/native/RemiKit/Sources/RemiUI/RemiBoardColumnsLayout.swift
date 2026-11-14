import SwiftUI

/// Places one flat set of Board subviews without changing their view identity.
public struct RemiBoardColumnsLayout: Layout {
    public let placements: [RemiBoardColumnPlacement]
    public let columnCount: Int
    public let columnWidth: CGFloat
    public let spacing: CGFloat

    /// The width occupied by all columns and their horizontal gaps.
    public var groupWidth: CGFloat {
        guard columnCount > 0 else { return 0 }
        return CGFloat(columnCount) * columnWidth + CGFloat(columnCount - 1) * spacing
    }

    public init(
        placements: [RemiBoardColumnPlacement],
        columnCount: Int,
        columnWidth: CGFloat,
        spacing: CGFloat = RemiBoardColumns.spacing
    ) {
        self.placements = placements
        self.columnCount = columnCount
        self.columnWidth = columnWidth
        self.spacing = spacing
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let measuredFrames = Self.frames(
            placements: placements,
            columnCount: columnCount,
            heights: measuredHeights(of: subviews),
            columnWidth: columnWidth,
            spacing: spacing
        )
        let height = measuredFrames.map(\.maxY).max() ?? 0
        return CGSize(width: groupWidth, height: height)
    }

    public func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let frames = Self.frames(
            placements: placements,
            columnCount: columnCount,
            heights: measuredHeights(of: subviews),
            columnWidth: columnWidth,
            spacing: spacing
        )
        for (index, subview) in subviews.enumerated() {
            let frame = frames[index]
            subview.place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                anchor: .topLeading,
                proposal: ProposedViewSize(width: frame.width, height: frame.height)
            )
        }
    }

    /// Returns one frame per measured subview. Unassigned subviews keep a zero frame;
    /// invalid column placements and item indices are ignored.
    public static func frames(
        placements: [RemiBoardColumnPlacement],
        columnCount: Int,
        heights: [CGFloat],
        columnWidth: CGFloat,
        spacing: CGFloat
    ) -> [CGRect] {
        let count = max(columnCount, 1)
        var result = Array(repeating: CGRect.zero, count: heights.count)
        var columnHeights = [CGFloat](repeating: 0, count: count)

        for placement in placements where
            heights.indices.contains(placement.itemIndex)
                && placement.firstColumn >= 0
                && placement.span >= 1
                && placement.firstColumn + placement.span <= count
        {
            let coveredColumns = placement.firstColumn..<(placement.firstColumn + placement.span)
            let y = coveredColumns.map { columnHeights[$0] }.max() ?? 0
            let width = CGFloat(placement.span) * columnWidth + CGFloat(placement.span - 1) * spacing
            result[placement.itemIndex] = CGRect(
                x: CGFloat(placement.firstColumn) * (columnWidth + spacing),
                y: y,
                width: width,
                height: heights[placement.itemIndex]
            )
            let nextHeight = y + heights[placement.itemIndex] + spacing
            for column in coveredColumns {
                columnHeights[column] = nextHeight
            }
        }
        return result
    }

    private func measuredHeights(of subviews: Subviews) -> [CGFloat] {
        var widths = Array(repeating: columnWidth, count: subviews.count)
        let count = max(columnCount, 1)
        for placement in placements where
            widths.indices.contains(placement.itemIndex)
                && placement.firstColumn >= 0
                && placement.span >= 1
                && placement.firstColumn + placement.span <= count
        {
            widths[placement.itemIndex] = CGFloat(placement.span) * columnWidth
                + CGFloat(placement.span - 1) * spacing
        }
        return subviews.enumerated().map { index, subview in
            subview.sizeThatFits(ProposedViewSize(width: widths[index], height: nil)).height
        }
    }
}
