import SwiftUI
import Testing
@testable import RemiUI

@Suite struct RemiBoardSpanTests {
    @Test func spanningCardsChooseTheLowestAdjacentWindowAndLeftmostTies() {
        #expect(
            RemiBoardColumns.placements(
                itemCount: 2,
                columnCount: 3,
                heights: [40, 20],
                spans: [1, 2]
            ) == [placement(0, 0, 1), placement(1, 1, 2)]
        )

        #expect(
            RemiBoardColumns.placements(
                itemCount: 4,
                columnCount: 3,
                heights: [40, 40, 40, 20],
                spans: [1, 1, 1, 2]
            ) == [
                placement(0, 0, 1), placement(1, 1, 1), placement(2, 2, 1), placement(3, 0, 2),
            ]
        )

        #expect(
            RemiBoardColumns.placements(
                itemCount: 2,
                columnCount: 3,
                heights: [40, 20],
                spans: [1, 3]
            ) == [placement(0, 0, 1), placement(1, 0, 3)]
        )

        #expect(
            RemiBoardColumns.placements(
                itemCount: 1,
                columnCount: 3,
                heights: [20],
                spans: [9]
            ) == [placement(0, 0, 3)]
        )
    }

    @Test func unitSpansMatchTheOriginalUnequalHeightPlacementTables() {
        let twoColumns = RemiBoardColumns.placements(
            itemCount: 5,
            columnCount: 2,
            heights: [440, 96, 96, 96, 96],
            spans: [1, 1, 1, 1, 1]
        )
        #expect(twoColumns == [
            placement(0, 0, 1), placement(1, 1, 1), placement(2, 1, 1),
            placement(3, 1, 1), placement(4, 1, 1),
        ])
        #expect(RemiBoardColumns.place(
            ["a", "b", "c", "d", "e"],
            columnCount: 2,
            heights: [440, 96, 96, 96, 96]
        ) == [["a"], ["b", "c", "d", "e"]])

        let threeColumns = RemiBoardColumns.placements(
            itemCount: 5,
            columnCount: 3,
            heights: [440, 96, 96, 96, 96],
            spans: [1, 1, 1, 1, 1]
        )
        #expect(threeColumns == [
            placement(0, 0, 1), placement(1, 1, 1), placement(2, 2, 1),
            placement(3, 1, 1), placement(4, 2, 1),
        ])
        #expect(RemiBoardColumns.place(
            ["a", "b", "c", "d", "e"],
            columnCount: 3,
            heights: [440, 96, 96, 96, 96]
        ) == [["a"], ["b", "d"], ["c", "e"]])
    }

    @Test func emptySpansDefaultToOneAndMissingHeightsUseRegularPhoneHeight() {
        #expect(RemiBoardColumns.placements(itemCount: 0, columnCount: 3, spans: []).isEmpty)
        #expect(
            RemiBoardColumns.placements(
                itemCount: 5,
                columnCount: 2,
                heights: [440],
                spans: []
            ) == [
                placement(0, 0, 1), placement(1, 1, 1), placement(2, 1, 1),
                placement(3, 0, 1), placement(4, 1, 1),
            ]
        )
    }

    @Test func storedSpansAreAdditiveClampedOnlyForDisplayAndClearable() {
        let legacy = RemiBoardState(storage: #"{"pinnedSlots":{"k":2},"sizes":{"k":"large"}}"#)
        #expect(legacy.slot(of: "k") == 2)
        #expect(legacy.size(for: "k") == .large)
        #expect(legacy.explicitSpan(for: "k") == nil)
        #expect(legacy.span(for: "k") == 1)

        var state = RemiBoardState()
        state.setSpan(4, for: "wide")
        #expect(state.span(for: "wide") == 4)
        #expect(state.explicitSpan(for: "wide") == 4)
        #expect(state.hasExplicitSpans)
        #expect(RemiBoardState(storage: state.storageValue) == state)
        #expect(RemiBoardCardResize.span(
            startingAt: state.span(for: "wide"),
            horizontalTranslation: 0,
            columnWidth: 100,
            spacing: 12,
            columnCount: 2
        ) == 2)
        #expect(state.explicitSpan(for: "wide") == 4)

        let damaged = RemiBoardState(storage: #"{"spans":{"zero":0,"negative":-2,"valid":2}}"#)
        #expect(damaged.explicitSpan(for: "zero") == nil)
        #expect(damaged.explicitSpan(for: "negative") == nil)
        #expect(damaged.span(for: "zero") == 1)
        #expect(damaged.explicitSpan(for: "valid") == 2)
        state.clearSpans()
        #expect(!state.hasExplicitSpans)
        #expect(state.explicitSpan(for: "wide") == nil)
        state.setSpan(0, for: "invalid")
        #expect(state.explicitSpan(for: "invalid") == nil)
    }

    @Test func horizontalDragUsesLiteralMidpointsForTwoThreeAndFourColumns() {
        let rows: [(columns: Int, start: Int, translation: CGFloat, expected: Int)] = [
            (2, 1, 55, 1), (2, 1, 56, 2), (2, 1, 57, 2),
            (2, 2, -57, 1), (2, 2, -56, 1), (2, 2, -55, 2),
            (3, 1, 55, 1), (3, 1, 56, 2), (3, 1, 57, 2),
            (3, 2, 55, 2), (3, 2, 56, 3), (3, 2, 57, 3),
            (3, 2, -57, 1), (3, 2, -56, 1), (3, 2, -55, 2),
            (3, 3, -57, 2), (3, 3, -56, 2), (3, 3, -55, 3),
            (4, 1, 55, 1), (4, 1, 56, 2), (4, 1, 57, 2),
            (4, 2, 55, 2), (4, 2, 56, 3), (4, 2, 57, 3),
            (4, 3, 55, 3), (4, 3, 56, 4), (4, 3, 57, 4),
            (4, 2, -57, 1), (4, 2, -56, 1), (4, 2, -55, 2),
            (4, 3, -57, 2), (4, 3, -56, 2), (4, 3, -55, 3),
            (4, 4, -57, 3), (4, 4, -56, 3), (4, 4, -55, 4),
        ]

        for row in rows {
            #expect(
                RemiBoardCardResize.span(
                    startingAt: row.start,
                    horizontalTranslation: row.translation,
                    columnWidth: 100,
                    spacing: 12,
                    columnCount: row.columns
                ) == row.expected,
                "columns \(row.columns), start \(row.start), translation \(row.translation)"
            )
        }
    }

    @Test func combinedDragNonfiniteValuesExtremesAndSpanStepsStayBounded() {
        let combined = RemiBoardCardResize.adjustment(
            startingAt: .regular,
            span: 1,
            translation: CGSize(width: 56, height: 100),
            topCorner: false,
            columnWidth: 100,
            spacing: 12,
            columnCount: 3
        )
        #expect(combined == RemiBoardCardResize.Adjustment(size: .large, span: 2))

        let nonfinite = RemiBoardCardResize.adjustment(
            startingAt: .regular,
            span: 2,
            translation: CGSize(width: CGFloat.nan, height: CGFloat.infinity),
            topCorner: false,
            columnWidth: 100,
            spacing: 12,
            columnCount: 4
        )
        #expect(nonfinite == RemiBoardCardResize.Adjustment(size: .regular, span: 2))
        #expect(RemiBoardCardResize.span(
            startingAt: 2,
            horizontalTranslation: -1_000_000,
            columnWidth: 100,
            spacing: 12,
            columnCount: 4
        ) == 1)
        #expect(RemiBoardCardResize.span(
            startingAt: 1,
            horizontalTranslation: 1_000_000,
            columnWidth: 100,
            spacing: 12,
            columnCount: 4
        ) == 4)
        #expect(RemiBoardCardResize.step(span: 1, direction: -1, columnCount: 4) == 1)
        #expect(RemiBoardCardResize.step(span: 2, direction: 1, columnCount: 4) == 3)
        #expect(RemiBoardCardResize.step(span: 4, direction: 1, columnCount: 4) == 4)
    }

    private func placement(_ itemIndex: Int, _ firstColumn: Int, _ span: Int) -> RemiBoardColumnPlacement {
        RemiBoardColumnPlacement(itemIndex: itemIndex, firstColumn: firstColumn, span: span)
    }
}
