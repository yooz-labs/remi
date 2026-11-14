import RemiUI
import SwiftUI
import Testing

struct RemiSidebarPlacementTests {
    @Test func defaultsFollowTheDesignWidths() {
        let rows: [(width: CGFloat, visibility: NavigationSplitViewVisibility, beside: Bool)] = [
            (466, .detailOnly, false), // iPhone Duo outer
            (669, .detailOnly, false), // iPhone Duo inner portrait
            (744, .detailOnly, false), // iPad mini portrait
            (834, .detailOnly, false), // iPad Air or Pro 11-inch portrait
            (951, .detailOnly, false), // iPhone Duo inner landscape
            (999, .detailOnly, false),
            (1_000, .all, true),
            (1_032, .all, true), // iPad Pro 13-inch portrait
            (1_133, .all, true), // iPad mini landscape
            (1_194, .all, true), // iPad Pro 11-inch landscape
            (1_376, .all, true), // iPad Pro 13-inch landscape
        ]

        for row in rows {
            let placement = RemiSidebarPlacement(windowWidth: row.width)
            #expect(placement.visibility == row.visibility)
            #expect(placement.isBeside == row.beside)
            #expect(placement.usesProminentDetail == !row.beside)
        }
    }

    @Test func defaultBesideUsesTheBoardThreshold() {
        for width in stride(from: CGFloat.zero, through: 2_000, by: 1) {
            let placement = RemiSidebarPlacement(windowWidth: width)
            #expect(placement.isBeside == RemiBoardColumns.sidebarBeside(windowWidth: width))
        }
    }

    @Test func explicitChoiceOverridesTheDefaultButDoesNotChangePlacementThreshold() {
        let hidden = RemiSidebarPlacement(windowWidth: 1_376, explicitChoice: .hidden)
        #expect(hidden.visibility == .detailOnly)
        #expect(!hidden.isBeside)
        #expect(!hidden.usesProminentDetail)

        for width: CGFloat in [744, 999, 1_000] {
            let shown = RemiSidebarPlacement(windowWidth: width, explicitChoice: .shown)
            #expect(shown.visibility == .all)
            #expect(shown.isBeside == RemiBoardColumns.sidebarBeside(windowWidth: width))
        }

        let shownBelowThreshold = RemiSidebarPlacement(windowWidth: 744, explicitChoice: .shown)
        #expect(!shownBelowThreshold.isBeside)
        #expect(shownBelowThreshold.usesProminentDetail)
    }

    @Test func explicitChoiceSurvivesWidthChangesInBothDirections() {
        for choice in [RemiSidebarPlacement.ExplicitChoice.shown, .hidden] {
            let narrow = RemiSidebarPlacement(windowWidth: 744, explicitChoice: choice)
            let wide = RemiSidebarPlacement(windowWidth: 1_376, explicitChoice: choice)
            let expectedVisibility: NavigationSplitViewVisibility = choice == .shown ? .all : .detailOnly

            #expect(narrow.visibility == expectedVisibility)
            #expect(wide.visibility == expectedVisibility)
            #expect(narrow.isBeside == (choice == .shown && RemiBoardColumns.sidebarBeside(windowWidth: 744)))
            #expect(wide.isBeside == (choice == .shown && RemiBoardColumns.sidebarBeside(windowWidth: 1_376)))
        }
    }

    @Test func invalidWidthsUseTheNarrowWindowDefault() {
        for width in [CGFloat.nan, .infinity, -.infinity, -1, -1_000] {
            let placement = RemiSidebarPlacement(windowWidth: width)
            #expect(placement.visibility == .detailOnly)
            #expect(!placement.isBeside)
            #expect(placement.usesProminentDetail)
        }
    }

    @Test func explicitChoiceStorageRoundTripsAndRejectsEmptyOrMalformedValues() {
        for choice in [RemiSidebarPlacement.ExplicitChoice.shown, .hidden] {
            #expect(RemiSidebarPlacement.ExplicitChoice(storageValue: choice.storageValue) == choice)
        }

        #expect(RemiSidebarPlacement.ExplicitChoice(storageValue: "") == nil)
        #expect(RemiSidebarPlacement.ExplicitChoice(storageValue: "visible") == nil)
    }
}
