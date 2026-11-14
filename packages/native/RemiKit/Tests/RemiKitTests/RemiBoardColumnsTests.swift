import SwiftUI
import Testing
@testable import RemiUI

@Suite struct RemiBoardColumnsTests {
    @Test func designTableResolvesEveryPaneWidth() {
        let rows: [(paneWidth: CGFloat, columns: Int)] = [
            (466, 1),
            (669, 2),
            (951, 2),
            (744, 2),
            (793, 2),
            (834, 2),
            (692, 2),
            (1_032, 3),
            (854, 2),
            (1_036, 3),
            (1_376, 4),
        ]

        for row in rows {
            #expect(RemiBoardColumns.resolve(paneWidth: row.paneWidth).columnCount == row.columns)
        }
    }

    @Test func columnBoundariesAndSixColumnCapAreInclusive() {
        #expect(RemiBoardColumns.resolve(paneWidth: 643).columnCount == 1)
        #expect(RemiBoardColumns.resolve(paneWidth: 644).columnCount == 2)
        #expect(RemiBoardColumns.resolve(paneWidth: 955).columnCount == 2)
        #expect(RemiBoardColumns.resolve(paneWidth: 956).columnCount == 3)
        #expect(RemiBoardColumns.resolve(paneWidth: 1_267).columnCount == 3)
        #expect(RemiBoardColumns.resolve(paneWidth: 1_268).columnCount == 4)
        #expect(RemiBoardColumns.resolve(paneWidth: 1_891).columnCount == 5)
        #expect(RemiBoardColumns.resolve(paneWidth: 1_892).columnCount == 6)
        #expect(RemiBoardColumns.resolve(paneWidth: 10_000).columnCount == 6)
    }

    @Test func sidebarThresholdIsInclusive() {
        #expect(!RemiBoardColumns.sidebarBeside(windowWidth: 999))
        #expect(RemiBoardColumns.sidebarBeside(windowWidth: 1_000))
    }

    @Test func hysteresisDelaysOnlyOneColumnDrops() {
        #expect(RemiBoardColumns.resolve(paneWidth: 940, previousColumnCount: 3).columnCount == 3)
        #expect(RemiBoardColumns.resolve(paneWidth: 932, previousColumnCount: 3).columnCount == 3)
        #expect(RemiBoardColumns.resolve(paneWidth: 931, previousColumnCount: 3).columnCount == 2)
        #expect(RemiBoardColumns.resolve(paneWidth: 625, previousColumnCount: 2).columnCount == 2)
        #expect(RemiBoardColumns.resolve(paneWidth: 620, previousColumnCount: 2).columnCount == 2)
        #expect(RemiBoardColumns.resolve(paneWidth: 619, previousColumnCount: 2).columnCount == 1)

        #expect(RemiBoardColumns.resolve(paneWidth: 956, previousColumnCount: 2).columnCount == 3)
        #expect(RemiBoardColumns.resolve(paneWidth: 644, previousColumnCount: 1).columnCount == 2)
        #expect(RemiBoardColumns.resolve(paneWidth: 643, previousColumnCount: 3).columnCount == 1)
    }

    @Test func invalidAndTooNarrowWidthsHaveNoCardArea() {
        let widths: [CGFloat] = [0, -1, .nan, .infinity, 31, 32]

        for width in widths {
            let columns = RemiBoardColumns.resolve(paneWidth: width, previousColumnCount: 4)
            #expect(columns.columnCount == 1)
            #expect(columns.cardWidth == 0)
            #expect(columns.groupWidth == 0)
        }
    }

    @Test func cardWidthsFitTheirPaneAndStayReadable() {
        let threeColumns = RemiBoardColumns.resolve(paneWidth: 1_032)
        #expect(threeColumns.columnCount == 3)
        #expect(threeColumns.cardWidth >= RemiBoardColumns.minimumCardWidth)
        #expect(threeColumns.groupWidth + 2 * RemiBoardColumns.margin <= 1_032)

        let sixColumns = RemiBoardColumns.resolve(paneWidth: 2_000)
        #expect(sixColumns.columnCount == 6)
        #expect(sixColumns.cardWidth <= RemiTheme.Size.readableContentWidth)

        let capped = RemiBoardColumns.resolve(paneWidth: 5_000)
        #expect(capped.columnCount == 6)
        #expect(capped.cardWidth == RemiTheme.Size.readableContentWidth)
        #expect(capped.groupWidth == 6 * RemiTheme.Size.readableContentWidth + 5 * RemiBoardColumns.spacing)
    }

    @Test func rawColumnCountDelegatesToBoardOrder() {
        for paneWidth in stride(from: 0, through: 2_400, by: 1) {
            let expected = RemiBoardOrder.columnCount(
                width: CGFloat(paneWidth) - 2 * RemiBoardColumns.margin,
                minimumTile: RemiBoardColumns.minimumCardWidth,
                spacing: RemiBoardColumns.spacing
            )
            #expect(RemiBoardColumns.resolve(paneWidth: CGFloat(paneWidth)).columnCount == expected)
        }
    }
}
