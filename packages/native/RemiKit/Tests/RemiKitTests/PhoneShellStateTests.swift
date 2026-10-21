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
        #expect(state.selectedSessionID == nil)
    }

    @Test func selectClosesDrawerAndClearsFocus() {
        var state = PhoneShellState(
            destination: .inbox,
            isDrawerOpen: true,
            pendingFocus: PhoneQuestionFocus(sessionID: "s1", questionID: "q1")
        )
        state.select(.session(route("s2")))
        #expect(state.destination == .session(route("s2")))
        #expect(state.selectedSessionID == "s2")
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

    @Test func replaceSessionCarriesRouteAndFocus() {
        var state = PhoneShellState()
        state.openFromNotification(route: route("old", machine: "m7", conversation: "c1"), questionID: "q1")
        state.replaceSession(from: "old", to: "new")
        #expect(state.destination == .session(PhoneSessionRoute(machineKey: "m7", sessionID: "new", conversationID: "c1", pane: .chat)))
        #expect(state.consumeFocus(forSessionID: "old") == nil)
        #expect(state.consumeFocus(forSessionID: "new") == "q1")
    }

    @Test func replaceSessionWithOtherIDIsNoOp() {
        var state = PhoneShellState()
        state.openFromNotification(route: route("s1"), questionID: "q1")
        let before = state
        state.replaceSession(from: "other", to: "new")
        #expect(state == before)
        var inbox = PhoneShellState()
        inbox.replaceSession(from: "s1", to: "s2")
        #expect(inbox == PhoneShellState())
    }

    @Test func vanishedSessionFallsBackOnlyAfterGrace() {
        var state = PhoneShellState(destination: .session(route("s1")))
        state.sessionVanished(sessionID: "s1", graceElapsed: false)
        #expect(state.destination == .session(route("s1")))
        state.sessionVanished(sessionID: "other", graceElapsed: true)
        #expect(state.destination == .session(route("s1")))
        state.sessionVanished(sessionID: "s1", graceElapsed: true)
        #expect(state.destination == .inbox)
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
