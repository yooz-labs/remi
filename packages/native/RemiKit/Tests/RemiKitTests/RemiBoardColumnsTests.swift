import SwiftUI
import Testing
@testable import RemiUI

@Suite struct RemiBoardColumnsTests {
    @Test func designTableResolvesEveryPaneWidth() {
        let rows: [(device: String, paneWidth: CGFloat, columns: Int)] = [
            ("iPhone portrait", 393, 1),
            ("iPhone Duo outer portrait", 466, 1),
            ("iPhone Duo inner portrait", 669, 2),
            ("iPhone Duo inner landscape", 951, 2),
            ("iPad mini portrait", 744, 2),
            ("iPad mini landscape with sidebar", 793, 2),
            ("iPad mini landscape with sidebar hidden", 1_133, 3),
            ("iPad Air or Pro 11-inch portrait", 834, 2),
            ("iPad Pro 13-inch portrait with sidebar", 692, 2),
            ("iPad Pro 13-inch portrait with sidebar hidden", 1_032, 3),
            ("iPad Pro 11-inch landscape", 854, 2),
            ("iPad Pro 13-inch landscape with sidebar", 1_036, 3),
            ("iPad Pro 13-inch landscape with sidebar hidden", 1_376, 4),
        ]

        for row in rows {
            let columns = RemiBoardColumns.resolve(paneWidth: row.paneWidth)
            #expect(columns.columnCount == row.columns, "\(row.device), pane \(row.paneWidth) pt")
        }
    }

    @Test func columnBoundariesAndSixColumnCapAreInclusive() {
        let rows: [(paneWidth: CGFloat, columns: Int)] = [
            (643, 1),
            (644, 2),
            (955, 2),
            (956, 3),
            (1_267, 3),
            (1_268, 4),
            (1_891, 5),
            (1_892, 6),
            (10_000, 6),
        ]

        for row in rows {
            let columns = RemiBoardColumns.resolve(paneWidth: row.paneWidth)
            #expect(columns.columnCount == row.columns, "pane \(row.paneWidth) pt")
        }
    }

    @Test func sidebarThresholdIsInclusive() {
        #expect(!RemiBoardColumns.sidebarBeside(windowWidth: 999))
        #expect(RemiBoardColumns.sidebarBeside(windowWidth: 1_000))
    }

    @Test func hysteresisHoldsAtEveryOneColumnDropThreshold() {
        for previousColumnCount in 2...6 {
            let threshold = startWidth(for: previousColumnCount) - RemiBoardColumns.hysteresis
            let atThreshold = RemiBoardColumns.resolve(
                paneWidth: threshold,
                previousColumnCount: previousColumnCount
            )
            #expect(
                atThreshold.columnCount == previousColumnCount,
                "previous \(previousColumnCount), pane \(threshold) pt"
            )

            let belowThreshold = RemiBoardColumns.resolve(
                paneWidth: threshold - 1,
                previousColumnCount: previousColumnCount
            )
            #expect(
                belowThreshold.columnCount == previousColumnCount - 1,
                "previous \(previousColumnCount), pane \(threshold - 1) pt"
            )
        }
    }

    @Test func heldColumnsRespectThePerColumnDipAndPaneBounds() {
        let rows: [(paneWidth: CGFloat, previousColumns: Int, cardWidth: CGFloat)] = [
            (940, 3, 884 / 3),
            (932, 3, 292),
            (625, 2, 581 / 2),
            (620, 2, 288),
        ]

        for row in rows {
            let columns = RemiBoardColumns.resolve(
                paneWidth: row.paneWidth,
                previousColumnCount: row.previousColumns
            )
            let minimumHeldWidth = RemiBoardColumns.minimumCardWidth
                - RemiBoardColumns.hysteresis / CGFloat(row.previousColumns)
            #expect(columns.columnCount == row.previousColumns, "previous \(row.previousColumns), pane \(row.paneWidth) pt")
            #expect(columns.cardWidth >= minimumHeldWidth, "previous \(row.previousColumns), pane \(row.paneWidth) pt")
            #expect(abs(columns.cardWidth - row.cardWidth) < 0.01, "previous \(row.previousColumns), pane \(row.paneWidth) pt")
            #expect(
                columns.groupWidth + 2 * RemiBoardColumns.margin <= row.paneWidth,
                "previous \(row.previousColumns), pane \(row.paneWidth) pt"
            )
        }
    }

    @Test func hysteresisDoesNotHideMultiColumnDropsOrInvalidPreviousCounts() {
        for paneWidth: CGFloat in [643, 940] {
            let columns = RemiBoardColumns.resolve(paneWidth: paneWidth, previousColumnCount: 4)
            let rawCount = rawColumnCount(for: paneWidth)
            #expect(columns.columnCount == rawCount, "previous 4, pane \(paneWidth) pt")
        }

        for paneWidth: CGFloat in [643, 940, 955] {
            let rawCount = rawColumnCount(for: paneWidth)
            for previousColumnCount in [0, 1, 7, -3] {
                let columns = RemiBoardColumns.resolve(
                    paneWidth: paneWidth,
                    previousColumnCount: previousColumnCount
                )
                #expect(
                    columns.columnCount == rawCount,
                    "previous \(previousColumnCount), pane \(paneWidth) pt"
                )
            }
        }
    }

    @Test func invalidPanesHaveNoCardArea() {
        let widths: [CGFloat] = [0, -1, .nan, .infinity, 31, 32]

        for width in widths {
            let columns = RemiBoardColumns.resolve(paneWidth: width, previousColumnCount: 4)
            #expect(columns.columnCount == 1, "pane \(width) pt")
            #expect(columns.cardWidth == 0, "pane \(width) pt")
            #expect(columns.groupWidth == 0, "pane \(width) pt")
        }
    }

    @Test func panesJustWiderThanTheirMarginsUseRemainingWidth() {
        let rows: [(paneWidth: CGFloat, width: CGFloat)] = [(33, 1), (100, 68)]

        for row in rows {
            let columns = RemiBoardColumns.resolve(paneWidth: row.paneWidth)
            #expect(columns.columnCount == 1, "pane \(row.paneWidth) pt")
            #expect(columns.cardWidth == row.width, "pane \(row.paneWidth) pt")
            #expect(columns.groupWidth == row.width, "pane \(row.paneWidth) pt")
        }
    }

    @Test func finiteVeryWidePanesClampSafely() {
        for paneWidth in [CGFloat.greatestFiniteMagnitude, CGFloat(1e300)] {
            let columns = RemiBoardColumns.resolve(paneWidth: paneWidth)
            #expect(columns.columnCount == 6, "pane \(paneWidth) pt")
            #expect(columns.cardWidth == 720, "pane \(paneWidth) pt")
        }
    }

    @Test func cardWidthsFitTheirPaneAndStayReadable() {
        let duoOuter = RemiBoardColumns.resolve(paneWidth: 466)
        #expect(duoOuter.cardWidth == 434, "pane 466 pt")
        #expect(duoOuter.groupWidth == 434, "pane 466 pt")

        let oneColumnAtBoundary = RemiBoardColumns.resolve(paneWidth: 643)
        #expect(oneColumnAtBoundary.cardWidth == 611, "pane 643 pt")
        #expect(oneColumnAtBoundary.groupWidth == 611, "pane 643 pt")

        let sixColumns = RemiBoardColumns.resolve(paneWidth: 2_000)
        #expect(sixColumns.columnCount == 6, "pane 2000 pt")
        #expect(abs(sixColumns.cardWidth - 318) < 0.01, "pane 2000 pt")
        #expect(sixColumns.groupWidth + 32 <= 2_000, "pane 2000 pt")

        let capped = RemiBoardColumns.resolve(paneWidth: 5_000)
        #expect(capped.columnCount == 6, "pane 5000 pt")
        #expect(capped.cardWidth == 720, "pane 5000 pt")
        #expect(capped.groupWidth == CGFloat(6 * 720 + 5 * 12), "pane 5000 pt")
    }

    @Test func readableContentWidthIs720Points() {
        #expect(RemiTheme.Size.readableContentWidth == 720)
    }

    @Test func rawColumnCountMatchesBoardOrderAtDesignValues() {
        // The literals 32, 300 and 12 are design values on purpose so constant drift fails.
        #expect(RemiBoardColumns.margin == 16, "pane math uses the 16 pt margin")
        #expect(RemiBoardColumns.minimumCardWidth == 300, "pane math uses the 300 pt minimum")
        #expect(RemiBoardColumns.spacing == 12, "pane math uses 12 pt spacing")

        let sweep = stride(from: CGFloat.zero, through: 2_400, by: 0.5)
        let fractionalPanes: [CGFloat] = [643.5, 643.99, 955.99, 1_267.99]
        for paneWidth in Array(sweep) + fractionalPanes {
            let expected = rawColumnCount(for: paneWidth)
            let columns = RemiBoardColumns.resolve(paneWidth: paneWidth)
            #expect(columns.columnCount == expected, "pane \(paneWidth) pt")
        }
    }

    @Test func placePreservesSingleColumnOrderAndPartitionsDeterministically() {
        let items = ["a", "b", "c", "d", "e", "f", "g"]
        let oneColumn = RemiBoardColumns.place(items, columnCount: 1)
        let twoColumns = RemiBoardColumns.place(items, columnCount: 2)
        let threeColumns = RemiBoardColumns.place(items, columnCount: 3)

        #expect(oneColumn == [items])
        #expect(twoColumns == [["a", "c", "e", "g"], ["b", "d", "f"]])
        #expect(threeColumns == [["a", "d", "g"], ["b", "e"], ["c", "f"]])
        #expect(
            RemiBoardColumns.place(items, columnCount: 2) == twoColumns
        )

        let originalPositions = Dictionary(uniqueKeysWithValues: items.enumerated().map { ($1, $0) })
        for columns in [twoColumns, threeColumns] {
            #expect(columns.flatMap { $0 }.sorted() == items.sorted())
            for column in columns {
                let positions = column.compactMap { originalPositions[$0] }
                #expect(positions == positions.sorted())
            }
        }
    }

    @Test func placeSupportsEmptyAndMoreColumnsThanItems() {
        #expect(RemiBoardColumns.place([String](), columnCount: 3) == [[], [], []])
        #expect(RemiBoardColumns.place(["a", "b"], columnCount: 5) == [["a"], ["b"], [], [], []])
    }

    @Test func placeClampsNonpositiveColumnCountsToOne() {
        #expect(RemiBoardColumns.place(["a"], columnCount: 0) == [["a"]])
        #expect(RemiBoardColumns.place(["a"], columnCount: -1) == [["a"]])
        #expect(RemiBoardColumns.place([String](), columnCount: 0) == [[]])
        #expect(RemiBoardColumns.place([String](), columnCount: -1) == [[]])

        let items = ["a", "b", "c", "d", "e"]
        let heights: [CGFloat] = [440, 96, 96, 96, 96]
        #expect(RemiBoardColumns.place(items, columnCount: 0, heights: heights) == [items])
        #expect(RemiBoardColumns.place(items, columnCount: -1, heights: heights) == [items])
    }

    @Test func placeUsesLiteralRoundRobinTables() {
        let items = ["a", "b", "c", "d", "e"]
        #expect(RemiBoardColumns.place(items, columnCount: 2) == [["a", "c", "e"], ["b", "d"]])
        #expect(RemiBoardColumns.place(items, columnCount: 3) == [["a", "d"], ["b", "e"], ["c"]])
    }

    @Test func placeUsesLiteralUnequalHeightTables() {
        let items = ["a", "b", "c", "d", "e"]
        let heights: [CGFloat] = [440, 96, 96, 96, 96]
        let twoColumns = RemiBoardColumns.place(items, columnCount: 2, heights: heights)
        let threeColumns = RemiBoardColumns.place(items, columnCount: 3, heights: heights)

        #expect(twoColumns == [["a"], ["b", "c", "d", "e"]])
        #expect(threeColumns == [["a"], ["b", "d"], ["c", "e"]])

        let originalPositions = Dictionary(uniqueKeysWithValues: items.enumerated().map { ($1, $0) })
        for columns in [twoColumns, threeColumns] {
            #expect(columns.flatMap { $0 }.sorted() == items.sorted())
            for column in columns {
                let positions = column.compactMap { originalPositions[$0] }
                #expect(positions == positions.sorted())
            }
        }
    }

    @Test func placeDefaultsMissingHeightsAndIgnoresExtraHeights() {
        let items = ["a", "b", "c", "d", "e"]
        let regularFallbackHeights: [CGFloat] = [440, 240, 240, 240, 240]
        let expected = [["a", "d"], ["b", "c", "e"]]

        #expect(RemiBoardColumns.place(items, columnCount: 2, heights: regularFallbackHeights) == expected)
        #expect(RemiBoardColumns.place(items, columnCount: 2, heights: [440]) == expected)
        #expect(RemiBoardColumns.place(items, columnCount: 2, heights: regularFallbackHeights + [1]) == expected)
        #expect(RemiBoardColumns.place([String](), columnCount: 3, heights: [440]) == [[], [], []])
    }

    @Test func placeKeepsTheSameItemsAcrossColumnCounts() {
        let items = ["a", "b", "c", "d", "e"]
        let twoColumns = RemiBoardColumns.place(items, columnCount: 2)
        let threeColumns = RemiBoardColumns.place(items, columnCount: 3)

        #expect(Set(twoColumns.flatMap { $0 }) == Set(items))
        #expect(Set(threeColumns.flatMap { $0 }) == Set(items))
        #expect(twoColumns.flatMap { $0 }.count == items.count)
        #expect(threeColumns.flatMap { $0 }.count == items.count)
    }

    @Test func allSpanOnePlacementEntryPointsAgree() {
        let tables: [(columnCount: Int, heights: [CGFloat])] = [
            (2, [440, 96, 96, 96, 96]),
            (3, [40, 20, 72, 10, 10]),
            (4, [100, 20, 60, 100, 10, 10]),
        ]

        for table in tables {
            let spans = Array(repeating: 1, count: table.heights.count)
            let placements = RemiBoardColumns.placements(
                itemCount: table.heights.count,
                columnCount: table.columnCount,
                heights: table.heights,
                spans: spans
            )
            var groupedPlacements = Array(repeating: [Int](), count: table.columnCount)
            for placement in placements {
                groupedPlacements[placement.firstColumn].append(placement.itemIndex)
            }

            #expect(groupedPlacements == RemiBoardOrder.columns(
                heights: table.heights,
                count: table.columnCount,
                spacing: RemiBoardColumns.spacing
            ))
            #expect(RemiBoardColumns.place(
                Array(table.heights.indices),
                columnCount: table.columnCount,
                heights: table.heights
            ) == groupedPlacements)
        }
    }

    private func startWidth(for columnCount: Int) -> CGFloat {
        2 * RemiBoardColumns.margin
            + CGFloat(columnCount) * RemiBoardColumns.minimumCardWidth
            + CGFloat(columnCount - 1) * RemiBoardColumns.spacing
    }

    private func rawColumnCount(for paneWidth: CGFloat) -> Int {
        RemiBoardOrder.columnCount(
            width: paneWidth - 32,
            minimumTile: 300,
            spacing: 12
        )
    }
}
