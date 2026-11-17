import SwiftUI
import Testing
@testable import RemiUI

@Suite struct RemiBoardColumnsLayoutTests {
    @Test func framesTwoColumnsWithUnequalHeightsAndTwelvePointGaps() {
        let frames = RemiBoardColumnsLayout.frames(
            placements: [
                RemiBoardColumnPlacement(itemIndex: 0, firstColumn: 0, span: 1),
                RemiBoardColumnPlacement(itemIndex: 1, firstColumn: 1, span: 1),
                RemiBoardColumnPlacement(itemIndex: 2, firstColumn: 0, span: 1),
                RemiBoardColumnPlacement(itemIndex: 3, firstColumn: 1, span: 1),
            ],
            columnCount: 2,
            heights: [40, 20, 30, 50],
            columnWidth: 100,
            spacing: 12
        )

        #expect(frames == [
            CGRect(x: 0, y: 0, width: 100, height: 40),
            CGRect(x: 112, y: 0, width: 100, height: 20),
            CGRect(x: 0, y: 52, width: 100, height: 30),
            CGRect(x: 112, y: 32, width: 100, height: 50),
        ])
    }

    @Test func framesThreeColumnsWithUnequalHeightsAndTwelvePointGaps() {
        let frames = RemiBoardColumnsLayout.frames(
            placements: [
                RemiBoardColumnPlacement(itemIndex: 0, firstColumn: 0, span: 1),
                RemiBoardColumnPlacement(itemIndex: 1, firstColumn: 1, span: 1),
                RemiBoardColumnPlacement(itemIndex: 2, firstColumn: 2, span: 1),
                RemiBoardColumnPlacement(itemIndex: 3, firstColumn: 0, span: 1),
                RemiBoardColumnPlacement(itemIndex: 4, firstColumn: 1, span: 1),
                RemiBoardColumnPlacement(itemIndex: 5, firstColumn: 2, span: 1),
            ],
            columnCount: 3,
            heights: [40, 20, 30, 50, 60, 10],
            columnWidth: 100,
            spacing: 12
        )

        #expect(frames == [
            CGRect(x: 0, y: 0, width: 100, height: 40),
            CGRect(x: 112, y: 0, width: 100, height: 20),
            CGRect(x: 224, y: 0, width: 100, height: 30),
            CGRect(x: 0, y: 52, width: 100, height: 50),
            CGRect(x: 112, y: 32, width: 100, height: 60),
            CGRect(x: 224, y: 42, width: 100, height: 10),
        ])
    }

    @Test func framesOneColumnTopToBottom() {
        let frames = RemiBoardColumnsLayout.frames(
            placements: [
                RemiBoardColumnPlacement(itemIndex: 0, firstColumn: 0, span: 1),
                RemiBoardColumnPlacement(itemIndex: 1, firstColumn: 0, span: 1),
                RemiBoardColumnPlacement(itemIndex: 2, firstColumn: 0, span: 1),
            ],
            columnCount: 1,
            heights: [24, 36, 18],
            columnWidth: 80,
            spacing: 12
        )

        #expect(frames == [
            CGRect(x: 0, y: 0, width: 80, height: 24),
            CGRect(x: 0, y: 36, width: 80, height: 36),
            CGRect(x: 0, y: 84, width: 80, height: 18),
        ])
    }

    @Test func emptyColumnsKeepTheirHorizontalSlots() {
        let frames = RemiBoardColumnsLayout.frames(
            placements: [RemiBoardColumnPlacement(itemIndex: 0, firstColumn: 2, span: 1)],
            columnCount: 3,
            heights: [20],
            columnWidth: 80,
            spacing: 12
        )

        #expect(frames == [CGRect(x: 184, y: 0, width: 80, height: 20)])
        #expect(RemiBoardColumnsLayout.frames(
            placements: [], columnCount: 2, heights: [], columnWidth: 80, spacing: 12
        ).isEmpty)
    }

    @Test func unassignedSubviewsGetZeroSizeFrames() {
        let frames = RemiBoardColumnsLayout.frames(
            placements: [RemiBoardColumnPlacement(itemIndex: 1, firstColumn: 0, span: 1)],
            columnCount: 1,
            heights: [28, 40],
            columnWidth: 90,
            spacing: 12
        )

        #expect(frames == [
            .zero,
            CGRect(x: 0, y: 0, width: 90, height: 40),
        ])
    }

    @Test func outOfRangeSubviewIndicesAreIgnored() {
        let frames = RemiBoardColumnsLayout.frames(
            placements: [
                RemiBoardColumnPlacement(itemIndex: 0, firstColumn: 0, span: 1),
                RemiBoardColumnPlacement(itemIndex: 3, firstColumn: 0, span: 1),
                RemiBoardColumnPlacement(itemIndex: 9, firstColumn: 1, span: 1),
            ],
            columnCount: 2,
            heights: [20],
            columnWidth: 90,
            spacing: 12
        )

        #expect(frames == [CGRect(x: 0, y: 0, width: 90, height: 20)])
    }

    @Test func layoutGroupWidthMatchesResolvedBoardColumns() {
        for paneWidth: CGFloat in [1_032, 1_376] {
            let resolved = RemiBoardColumns.resolve(paneWidth: paneWidth)
            let layout = RemiBoardColumnsLayout(
                placements: [],
                columnCount: resolved.columnCount,
                columnWidth: resolved.cardWidth,
                spacing: RemiBoardColumns.spacing
            )

            #expect(layout.groupWidth == resolved.groupWidth, "pane \(paneWidth) pt")
        }
    }

    @Test func spanningFramesUseTheCoveredHeightAndCombinedColumnWidth() {
        let frames = RemiBoardColumnsLayout.frames(
            placements: [
                RemiBoardColumnPlacement(itemIndex: 0, firstColumn: 0, span: 2),
                RemiBoardColumnPlacement(itemIndex: 1, firstColumn: 2, span: 1),
                RemiBoardColumnPlacement(itemIndex: 2, firstColumn: 1, span: 2),
                RemiBoardColumnPlacement(itemIndex: 3, firstColumn: 0, span: 1),
            ],
            columnCount: 3,
            heights: [40, 30, 20, 10],
            columnWidth: 100,
            spacing: 12
        )

        #expect(frames == [
            CGRect(x: 0, y: 0, width: 212, height: 40),
            CGRect(x: 224, y: 0, width: 100, height: 30),
            CGRect(x: 112, y: 52, width: 212, height: 20),
            CGRect(x: 0, y: 52, width: 100, height: 10),
        ])
    }

    @Test func spansNeverExceedTheResolvedColumnGroupWidth() {
        let groupWidth = CGFloat(3 * 100 + 2 * 12)
        let frames = RemiBoardColumnsLayout.frames(
            placements: [
                RemiBoardColumnPlacement(itemIndex: 0, firstColumn: 0, span: 1),
                RemiBoardColumnPlacement(itemIndex: 1, firstColumn: 0, span: 2),
                RemiBoardColumnPlacement(itemIndex: 2, firstColumn: 0, span: 3),
            ],
            columnCount: 3,
            heights: [20, 20, 20],
            columnWidth: 100,
            spacing: 12
        )

        #expect(frames.map(\.width) == [100, 212, groupWidth])
        #expect(frames.allSatisfy { $0.width <= groupWidth })
    }

    @Test func spanningPlacementTableStacksTheSpanAndFollowerAtLiteralHeights() {
        let frames = RemiBoardColumnsLayout.frames(
            placements: [
                RemiBoardColumnPlacement(itemIndex: 0, firstColumn: 0, span: 1),
                RemiBoardColumnPlacement(itemIndex: 1, firstColumn: 1, span: 1),
                RemiBoardColumnPlacement(itemIndex: 2, firstColumn: 2, span: 1),
                RemiBoardColumnPlacement(itemIndex: 3, firstColumn: 0, span: 2),
                RemiBoardColumnPlacement(itemIndex: 4, firstColumn: 0, span: 1),
            ],
            columnCount: 3,
            heights: [40, 20, 72, 10, 10],
            columnWidth: 100,
            spacing: 12
        )

        #expect(frames == [
            CGRect(x: 0, y: 0, width: 100, height: 40),
            CGRect(x: 112, y: 0, width: 100, height: 20),
            CGRect(x: 224, y: 0, width: 100, height: 72),
            CGRect(x: 0, y: 52, width: 212, height: 10),
            CGRect(x: 0, y: 74, width: 100, height: 10),
        ])
    }

    @Test func middleWindowAndFullWidthSpansUseTheTallestCoveredColumn() {
        let middleWindow = RemiBoardColumnsLayout.frames(
            placements: [
                RemiBoardColumnPlacement(itemIndex: 0, firstColumn: 0, span: 1),
                RemiBoardColumnPlacement(itemIndex: 1, firstColumn: 1, span: 1),
                RemiBoardColumnPlacement(itemIndex: 2, firstColumn: 2, span: 1),
                RemiBoardColumnPlacement(itemIndex: 3, firstColumn: 3, span: 1),
                RemiBoardColumnPlacement(itemIndex: 4, firstColumn: 1, span: 2),
                RemiBoardColumnPlacement(itemIndex: 5, firstColumn: 1, span: 1),
            ],
            columnCount: 4,
            heights: [100, 20, 60, 100, 10, 10],
            columnWidth: 100,
            spacing: 12
        )
        #expect(middleWindow[4] == CGRect(x: 112, y: 72, width: 212, height: 10))
        #expect(middleWindow[5] == CGRect(x: 112, y: 94, width: 100, height: 10))

        let fullWidth = RemiBoardColumnsLayout.frames(
            placements: [
                RemiBoardColumnPlacement(itemIndex: 0, firstColumn: 0, span: 1),
                RemiBoardColumnPlacement(itemIndex: 1, firstColumn: 1, span: 1),
                RemiBoardColumnPlacement(itemIndex: 2, firstColumn: 2, span: 1),
                RemiBoardColumnPlacement(itemIndex: 3, firstColumn: 0, span: 3),
                RemiBoardColumnPlacement(itemIndex: 4, firstColumn: 0, span: 1),
            ],
            columnCount: 3,
            heights: [40, 20, 72, 10, 10],
            columnWidth: 100,
            spacing: 12
        )
        #expect(fullWidth[3] == CGRect(x: 0, y: 84, width: 324, height: 10))
        #expect(fullWidth[4] == CGRect(x: 0, y: 106, width: 100, height: 10))
    }
}
