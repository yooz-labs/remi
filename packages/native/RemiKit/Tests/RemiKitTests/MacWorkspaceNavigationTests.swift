import SwiftUI
import Testing
@testable import RemiUI

@Suite struct MacWorkspaceNavigationTests {
    @Test func machineToggleMovesBetweenThreeAndTwoColumns() {
        let all = RemiMacColumnLayout(visibility: .all, expandedVisibility: .all)
        let twoColumns = all.togglingMachines()

        #expect(twoColumns.visibility == .doubleColumn)
        #expect(twoColumns.expandedVisibility == .doubleColumn)
        #expect(twoColumns.togglingMachines() == all)
    }

    @Test func navigationToggleRestoresTheLastExpandedLayout() {
        let expanded = RemiMacColumnLayout(
            visibility: .doubleColumn,
            expandedVisibility: .doubleColumn
        )
        let focused = expanded.togglingNavigation()

        #expect(focused.visibility == .detailOnly)
        #expect(focused.expandedVisibility == .doubleColumn)
        #expect(focused.togglingNavigation() == expanded)
    }

    @Test func machineToggleFromFocusedConversationRestoresAllColumns() {
        let focused = RemiMacColumnLayout(
            visibility: .detailOnly,
            expandedVisibility: .doubleColumn
        )

        #expect(focused.togglingMachines() == RemiMacColumnLayout(
            visibility: .all,
            expandedVisibility: .all
        ))
    }

    @Test func orderedSelectionWrapsAndHandlesMissingSelection() {
        let ids = ["one", "two", "three"]

        #expect(RemiOrderedSelection.shifted(selection: "one", orderedIDs: ids, offset: -1) == "three")
        #expect(RemiOrderedSelection.shifted(selection: "three", orderedIDs: ids, offset: 1) == "one")
        #expect(RemiOrderedSelection.shifted(selection: nil, orderedIDs: ids, offset: 1) == "one")
        #expect(RemiOrderedSelection.shifted(selection: "missing", orderedIDs: ids, offset: -1) == "three")
        #expect(RemiOrderedSelection.shifted(selection: "one", orderedIDs: ids, offset: -7) == "three")
        #expect(RemiOrderedSelection.shifted(selection: "two", orderedIDs: ids, offset: 0) == "two")
        #expect(RemiOrderedSelection.shifted(selection: nil, orderedIDs: ids, offset: 0) == "one")
    }

    @Test func orderedSelectionReturnsNilForAnEmptyCollection() {
        #expect(RemiOrderedSelection.shifted(
            selection: "missing",
            orderedIDs: [String](),
            offset: 1
        ) == nil)
    }

    @Test func compactDestinationFollowsTheDeepestValidSelection() {
        #expect(RemiMacCompactDestination.resolve(hasMachine: false, hasSession: false) == .machines)
        #expect(RemiMacCompactDestination.resolve(hasMachine: true, hasSession: false) == .sessions)
        #expect(RemiMacCompactDestination.resolve(hasMachine: true, hasSession: true) == .conversation)
        #expect(RemiMacCompactDestination.conversation.column == .detail)
    }
}
