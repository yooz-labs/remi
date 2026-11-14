import SwiftUI
import Testing
@testable import RemiUI

@Suite struct RemiBoardColumnsLayoutTests {
    @Test func framesTwoColumnsWithUnequalHeightsAndTwelvePointGaps() {
        let frames = RemiBoardColumnsLayout.frames(
            columns: [[0, 2], [1, 3]],
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
            columns: [[0, 3], [1, 4], [2, 5]],
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
            columns: [[0, 1, 2]],
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
            columns: [[], [], [0]],
            heights: [20],
            columnWidth: 80,
            spacing: 12
        )

        #expect(frames == [CGRect(x: 184, y: 0, width: 80, height: 20)])
        #expect(RemiBoardColumnsLayout.frames(
            columns: [[], []], heights: [], columnWidth: 80, spacing: 12
        ).isEmpty)
    }

    @Test func unassignedSubviewsGetZeroSizeFrames() {
        let frames = RemiBoardColumnsLayout.frames(
            columns: [[1]],
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
            columns: [[0, 3], [9]],
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
                columns: Array(repeating: [], count: resolved.columnCount),
                columnWidth: resolved.cardWidth,
                spacing: RemiBoardColumns.spacing
            )

            #expect(layout.groupWidth == resolved.groupWidth, "pane \(paneWidth) pt")
        }
    }
}
