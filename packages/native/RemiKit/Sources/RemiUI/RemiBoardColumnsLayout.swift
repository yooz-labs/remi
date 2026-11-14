import SwiftUI

/// Places one flat set of Board subviews into columns without changing their view identity.
public struct RemiBoardColumnsLayout: Layout {
    public let columns: [[Int]]
    public let columnWidth: CGFloat
    public let spacing: CGFloat

    /// The width occupied by all columns and their horizontal gaps.
    public var groupWidth: CGFloat {
        guard !columns.isEmpty else { return 0 }
        return CGFloat(columns.count) * columnWidth + CGFloat(columns.count - 1) * spacing
    }

    public init(columns: [[Int]], columnWidth: CGFloat, spacing: CGFloat = RemiBoardColumns.spacing) {
        self.columns = columns
        self.columnWidth = columnWidth
        self.spacing = spacing
    }

    public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let measuredFrames = Self.frames(
            columns: columns,
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
            columns: columns,
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

    /// Returns one frame per measured subview. Indices not assigned to a column keep a
    /// zero-size frame; indices outside `heights` are ignored.
    public static func frames(
        columns: [[Int]],
        heights: [CGFloat],
        columnWidth: CGFloat,
        spacing: CGFloat
    ) -> [CGRect] {
        var result = Array(repeating: CGRect.zero, count: heights.count)
        for (columnIndex, column) in columns.enumerated() {
            var y: CGFloat = 0
            for index in column where heights.indices.contains(index) {
                let height = heights[index]
                result[index] = CGRect(
                    x: CGFloat(columnIndex) * (columnWidth + spacing),
                    y: y,
                    width: columnWidth,
                    height: height
                )
                y += height + spacing
            }
        }
        return result
    }

    private func measuredHeights(of subviews: Subviews) -> [CGFloat] {
        subviews.map { subview in
            subview.sizeThatFits(ProposedViewSize(width: columnWidth, height: nil)).height
        }
    }
}
