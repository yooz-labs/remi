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
            pendingFocus: PhoneQuestionFocus(sessionID: "s1", questionID: "q1")
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
        #expect(state.consumeFocus(forSessionID: "s2") == nil)
        #expect(state.pendingFocus != nil)
        #expect(state.consumeFocus(forSessionID: "s1") == "q1")
        #expect(state.consumeFocus(forSessionID: "s1") == nil)
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
}
