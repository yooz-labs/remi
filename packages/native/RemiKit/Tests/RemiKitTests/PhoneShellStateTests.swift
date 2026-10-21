import Testing
@testable import RemiUI

@Suite struct PhoneShellStateTests {
    private func route(_ id: String = "s1", machine: String = "m1", conversation: String? = nil) -> PhoneSessionRoute {
        PhoneSessionRoute(machineKey: machine, sessionID: id, conversationID: conversation)
    }

    @Test func startsOnInboxWithClosedDrawer() {
        let state = PhoneShellState()
        #expect(state.destination == .inbox)
        #expect(!state.isDrawerOpen)
        #expect(state.pendingFocus == nil)
        #expect(state.selectedRoute == nil)
    }

    @Test func selectClosesDrawerAndClearsFocus() {
        var state = PhoneShellState(
            destination: .inbox,
            isDrawerOpen: true,
            pendingFocus: PhoneQuestionFocus(machineKey: "m1", sessionID: "s1", questionID: "q1")
        )
        state.select(.session(route("s2")))
        #expect(state.destination == .session(route("s2")))
        #expect(state.selectedRoute == route("s2"))
        #expect(!state.isDrawerOpen)
        #expect(state.pendingFocus == nil)
    }

    @Test func notificationReplacesSelectionAndFocusIsConsumedOnce() {
        var state = PhoneShellState(destination: .session(route("s9")), isDrawerOpen: true)
        state.openFromNotification(route: route("s1"), questionID: "q1")
        #expect(state.destination == .session(route("s1")))
        #expect(!state.isDrawerOpen)
        #expect(state.consumeFocus(for: route("s2")) == nil)
        #expect(state.pendingFocus != nil)
        #expect(state.consumeFocus(for: route("s1")) == "q1")
        #expect(state.consumeFocus(for: route("s1")) == nil)
    }

    @Test func notificationWithoutQuestionSetsNoFocus() {
        var state = PhoneShellState()
        state.openFromNotification(route: route("s1"), questionID: nil)
        #expect(state.pendingFocus == nil)
    }

    @Test func vanishedRouteFallsBackToInbox() {
        var state = PhoneShellState(destination: .session(route("s1")))
        state.sessionVanished(route("s1"))
        #expect(state.destination == .inbox)
    }

    @Test func vanishedOtherRouteIsIgnored() {
        var state = PhoneShellState(destination: .session(route("s1", machine: "m1")))
        state.sessionVanished(route("s1", machine: "m2"))
        state.sessionVanished(route("s2", machine: "m1"))
        #expect(state.destination == .session(route("s1", machine: "m1")))
        var inbox = PhoneShellState()
        inbox.sessionVanished(route("s1"))
        #expect(inbox.destination == .inbox)
    }

    @Test func drawerToggles() {
        var state = PhoneShellState()
        state.openDrawer()
        #expect(state.isDrawerOpen)
        state.closeDrawer()
        #expect(!state.isDrawerOpen)
        state.toggleDrawer()
        #expect(state.isDrawerOpen)
        state.toggleDrawer()
        #expect(!state.isDrawerOpen)
    }

    @Test func selectedKeyComparesMachineAndSession() {
        let state = PhoneShellState(destination: .session(route("s1", machine: "m1")))
        #expect(state.selectedSessionKey == RemiSessionKey(machineID: "m1", sessionID: "s1"))
        #expect(state.selectedSessionKey != RemiSessionKey(machineID: "m2", sessionID: "s1"))
        #expect(PhoneShellState().selectedSessionKey == nil)
    }

    @Test func notificationForTheOpenSessionSetsFocusWithoutMovingAnywhere() {
        var state = PhoneShellState(destination: .session(route("s1", conversation: "agent")), isDrawerOpen: true)
        state.openFromNotification(route: route("s1", conversation: "agent"), questionID: "q2")
        #expect(state.destination == .session(route("s1", conversation: "agent")))
        #expect(!state.isDrawerOpen)
        #expect(state.pendingFocus == PhoneQuestionFocus(machineKey: "m1", sessionID: "s1", questionID: "q2"))
        #expect(state.consumeFocus(for: route("s1")) == "q2")
        #expect(state.consumeFocus(for: route("s1")) == nil)
        #expect(state.destination == .session(route("s1", conversation: "agent")))
    }

    @Test func focusForOneMachineIsNotConsumedByTheSameSessionIDOnAnother() {
        var state = PhoneShellState()
        state.openFromNotification(route: route("s1", machine: "m1"), questionID: "q1")
        #expect(state.consumeFocus(for: route("s1", machine: "m2")) == nil)
        #expect(state.pendingFocus?.machineKey == "m1")
        #expect(state.focusQuestionID(for: route("s1", machine: "m2")) == nil)
        #expect(state.focusQuestionID(for: route("s1", machine: "m1")) == "q1")
        #expect(state.consumeFocus(for: route("s1", machine: "m1")) == "q1")
    }

    @Test func filterStartsOnAllAndSelectingNarrowsToOneMachine() {
        var state = PhoneShellState()
        #expect(state.drawerFilter == .all)
        #expect(state.filteredMachineKey == nil)
        state.selectMachineFilter("m1")
        #expect(state.drawerFilter == .machine("m1"))
        #expect(state.filteredMachineKey == "m1")
        state.selectMachineFilter("m2")
        #expect(state.filteredMachineKey == "m2")
    }

    @Test func selectingTheActiveMachineReturnsToAll() {
        var state = PhoneShellState(drawerFilter: .machine("m1"))
        state.selectMachineFilter("m1")
        #expect(state.drawerFilter == .all)
    }

    @Test func clearFilterReturnsToAll() {
        var state = PhoneShellState(drawerFilter: .machine("m1"))
        state.clearFilter()
        #expect(state.drawerFilter == .all)
        state.clearFilter()
        #expect(state.drawerFilter == .all)
    }

    @Test func removedMachineResetsTheFilter() {
        var state = PhoneShellState(drawerFilter: .machine("m1"))
        state.machinesChanged(ids: ["m1", "m2"])
        #expect(state.filteredMachineKey == "m1")
        state.machinesChanged(ids: ["m2"])
        #expect(state.drawerFilter == .all)
        state.machinesChanged(ids: [])
        #expect(state.drawerFilter == .all)
    }

    @Test func notificationClearsTheFilter() {
        var state = PhoneShellState(drawerFilter: .machine("m2"))
        state.openFromNotification(route: route("s1", machine: "m1"), questionID: "q1")
        #expect(state.drawerFilter == .all)
    }

    @Test func selectingADestinationKeepsTheFilter() {
        var state = PhoneShellState(isDrawerOpen: true, drawerFilter: .machine("m1"))
        state.select(.session(route("s1", machine: "m1")))
        #expect(state.filteredMachineKey == "m1")
        state.select(.inbox)
        #expect(state.filteredMachineKey == "m1")
    }
}
