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
            (999.5, .detailOnly, false),
            (999.999, .detailOnly, false),
            (1_000, .all, true),
            (1_000.001, .all, true),
            (1_032, .all, true), // iPad Pro 13-inch portrait
            (1_133, .all, true), // iPad mini landscape
            (1_194, .all, true), // iPad Pro 11-inch landscape
            (1_376, .all, true), // iPad Pro 13-inch landscape
        ]

        for row in rows {
            let placement = RemiSidebarPlacement(windowWidth: row.width)
            #expect(placement.visibility == row.visibility)
            #expect(placement.isBeside == row.beside)
        }
    }

    @Test func defaultVisibilityAndBesidePlacementUseTheBoardThreshold() {
        for width in stride(from: CGFloat.zero, through: 2_000, by: 1) {
            let placement = RemiSidebarPlacement(windowWidth: width)
            let sidebarBeside = RemiBoardColumns.sidebarBeside(windowWidth: width)
            #expect(placement.visibility == (sidebarBeside ? .all : .detailOnly))
            #expect(placement.isBeside == sidebarBeside)
        }

        for width: CGFloat in [999.5, 999.999, 1_000.001] {
            let placement = RemiSidebarPlacement(windowWidth: width)
            let sidebarBeside = RemiBoardColumns.sidebarBeside(windowWidth: width)
            #expect(placement.visibility == (sidebarBeside ? .all : .detailOnly))
            #expect(placement.isBeside == sidebarBeside)
        }
    }

    @Test func explicitChoiceOverridesVisibilityButNotTheBesideThreshold() {
        let hiddenWide = RemiSidebarPlacement(windowWidth: 1_376, explicitChoice: .hidden)
        #expect(hiddenWide.visibility == .detailOnly)
        #expect(!hiddenWide.isBeside)

        let shownNarrow = RemiSidebarPlacement(windowWidth: 744, explicitChoice: .shown)
        #expect(shownNarrow.visibility == .all)
        #expect(!shownNarrow.isBeside)

        let shownAtThreshold = RemiSidebarPlacement(windowWidth: 1_000, explicitChoice: .shown)
        #expect(shownAtThreshold.visibility == .all)
        #expect(shownAtThreshold.isBeside)
    }

    @Test func explicitChoiceSurvivesWidthChangesInBothDirections() {
        let shownNarrow = RemiSidebarPlacement(windowWidth: 744, explicitChoice: .shown)
        let shownWide = RemiSidebarPlacement(windowWidth: 1_376, explicitChoice: .shown)
        #expect(shownNarrow.visibility == .all)
        #expect(!shownNarrow.isBeside)
        #expect(shownWide.visibility == .all)
        #expect(shownWide.isBeside)

        let hiddenNarrow = RemiSidebarPlacement(windowWidth: 744, explicitChoice: .hidden)
        let hiddenWide = RemiSidebarPlacement(windowWidth: 1_376, explicitChoice: .hidden)
        #expect(hiddenNarrow.visibility == .detailOnly)
        #expect(!hiddenNarrow.isBeside)
        #expect(hiddenWide.visibility == .detailOnly)
        #expect(!hiddenWide.isBeside)
    }

    @Test func unmeasuredInvalidAndNegativeWidthsUseTheNarrowDefaultUnlessShown() {
        let widths: [CGFloat?] = [nil, .nan, .infinity, -.infinity, -1]
        for width in widths {
            let placement = RemiSidebarPlacement(windowWidth: width)
            #expect(placement.visibility == .detailOnly)
            #expect(!placement.isBeside)

            let shown = RemiSidebarPlacement(windowWidth: width, explicitChoice: .shown)
            #expect(shown.visibility == .all)
            #expect(!shown.isBeside)

            let hidden = RemiSidebarPlacement(windowWidth: width, explicitChoice: .hidden)
            #expect(hidden.visibility == .detailOnly)
            #expect(!hidden.isBeside)
        }
    }

    @Test func explicitChoiceStorageUsesExactStableStrings() {
        #expect(RemiSidebarPlacement.ExplicitChoice.shown.storageValue == "shown")
        #expect(RemiSidebarPlacement.ExplicitChoice.hidden.storageValue == "hidden")
        #expect(RemiSidebarPlacement.ExplicitChoice(storageValue: "shown") == .shown)
        #expect(RemiSidebarPlacement.ExplicitChoice(storageValue: "hidden") == .hidden)
        #expect(RemiSidebarPlacement.ExplicitChoice(storageValue: "") == nil)
        #expect(RemiSidebarPlacement.ExplicitChoice(storageValue: "Shown") == nil)
        #expect(RemiSidebarPlacement.ExplicitChoice(storageValue: " shown") == nil)
        #expect(RemiSidebarPlacement.ExplicitChoice(storageValue: "shown,hidden") == nil)
        #expect(RemiSidebarPlacement.ExplicitChoice(storageValue: "all") == nil)
    }

    @Test func choiceRecordingTracksOnlyChangesInEffectiveVisibility() {
        #expect(RemiSidebarPlacement.choiceToRecord(requestedVisibility: .detailOnly, currentVisibility: .all) == .hidden)
        #expect(RemiSidebarPlacement.choiceToRecord(requestedVisibility: .all, currentVisibility: .detailOnly) == .shown)

        for requested in [NavigationSplitViewVisibility.all, .doubleColumn, .automatic] {
            #expect(RemiSidebarPlacement.choiceToRecord(requestedVisibility: requested, currentVisibility: .detailOnly) == .shown)
        }

        for visibility in [NavigationSplitViewVisibility.detailOnly, .all, .doubleColumn, .automatic] {
            #expect(RemiSidebarPlacement.choiceToRecord(requestedVisibility: visibility, currentVisibility: visibility) == nil)
        }
        for current in [NavigationSplitViewVisibility.all, .doubleColumn, .automatic] {
            for requested in [NavigationSplitViewVisibility.all, .doubleColumn, .automatic] {
                #expect(RemiSidebarPlacement.choiceToRecord(requestedVisibility: requested, currentVisibility: current) == nil)
            }
        }

        let defaultAt744 = RemiSidebarPlacement(windowWidth: 744)
        #expect(defaultAt744.visibility == .detailOnly)
        #expect(RemiSidebarPlacement.choiceToRecord(requestedVisibility: .all, currentVisibility: defaultAt744.visibility) == .shown)
    }
}
