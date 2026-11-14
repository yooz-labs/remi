import SwiftUI
import Testing
@testable import RemiUI

@Suite struct RemiBoardCardSizeTests {
    @Test func explicitSizeIsOptionalAndCanBeCleared() {
        var state = RemiBoardState()
        #expect(state.explicitSize(for: "first") == nil)
        #expect(state.size(for: "first") == .regular)

        state.setSize(.large, for: "first")
        state.setSize(.row, for: "second")
        #expect(state.explicitSize(for: "first") == .large)
        #expect(state.explicitSize(for: "second") == .row)

        state.clearSize(for: "first")
        #expect(state.explicitSize(for: "first") == nil)
        #expect(state.size(for: "first") == .regular)

        state.clearSizes()
        #expect(state.explicitSize(for: "second") == nil)
    }

    @Test func oldStoredBoardKeepsItsPinsAndSizesAndDefaultsUnspecifiedSize() {
        let stored = #"{"pinnedSlots":{"saved":2},"sizes":{"saved":"large"}}"#
        let state = RemiBoardState(storage: stored)

        #expect(state.slot(of: "saved") == 2)
        #expect(state.explicitSize(for: "saved") == .large)
        #expect(state.size(for: "saved") == .large)
        #expect(state.explicitSize(for: "unset") == nil)
        #expect(state.size(for: "unset") == .regular)
    }

    @Test func phoneCardHeightsArePinnedToTheirDesignValues() {
        let rows: [(size: RemiTileSize, height: CGFloat)] = [
            (.row, 96),
            (.regular, 240),
            (.large, 440),
        ]

        for row in rows {
            #expect(row.size.phoneCardHeight == row.height)
        }
    }

    @Test func effectivePhoneSizeUsesToolbarAtOneColumnAndExplicitSizeInColumns() {
        let rows: [(
            columnCount: Int,
            toolbar: RemiTileSize,
            explicit: RemiTileSize?,
            expected: RemiTileSize,
            expectedComposer: Bool
        )] = [
            (1, .regular, .large, .regular, true),
            (1, .row, .regular, .row, false),
            (0, .regular, .large, .regular, true),
            (-1, .large, .row, .large, true),
            (2, .regular, .large, .large, true),
            (2, .large, .row, .row, false),
            (2, .regular, .compact, .regular, true),
            (3, .large, nil, .large, true),
        ]

        for row in rows {
            let size = RemiTileSize.effectivePhoneSize(
                toolbarDensity: row.toolbar,
                explicitSize: row.explicit,
                columnCount: row.columnCount
            )
            #expect(size == row.expected)
            #expect(size.showsComposer == (size != .row))
        }
    }

    @Test func tileExtrasDoNotGrowToContentByDefault() {
        #expect(RemiBoardTileExtras().growsToContent == false)
    }
}
