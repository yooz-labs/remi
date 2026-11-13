import RemiKit
import Testing
@testable import RemiUI

@Suite struct PhoneShellStateTests {
    private func route(_ id: String = "s1", machine: String = "m1", conversation: String? = nil) -> PhoneSessionRoute {
        PhoneSessionRoute(machineKey: machine, sessionID: id, conversationID: conversation)
    }

    @Test func startsOnTheBoardWithClosedDrawer() {
        let state = PhoneShellState()
        #expect(state.destination == .board)
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

    @Test func vanishedRouteFallsBackToTheBoard() {
        var state = PhoneShellState(destination: .session(route("s1")))
        state.sessionVanished(route("s1"))
        #expect(state.destination == .board)
    }

    @Test func vanishedOtherRouteIsIgnored() {
        var state = PhoneShellState(destination: .session(route("s1", machine: "m1")))
        state.sessionVanished(route("s1", machine: "m2"))
        state.sessionVanished(route("s2", machine: "m1"))
        #expect(state.destination == .session(route("s1", machine: "m1")))
        var board = PhoneShellState()
        board.sessionVanished(route("s1"))
        #expect(board.destination == .board)
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

    // MARK: Pending resume

    private let resumeKey = ResumeSessionKey(machineID: "m1", sessionID: "old")

    @Test func resumeLandingOpensTheSessionAndClearsThePendingResume() {
        var state = PhoneShellState()
        state.beginResume(resumeKey)
        let landed = state.landResume(resumeKey, at: route("new"))
        #expect(landed)
        #expect(state.destination == .session(route("new")))
        #expect(state.pendingResume == nil)
    }

    @Test func aResumeForAnotherSessionDoesNotLand() {
        var state = PhoneShellState()
        state.beginResume(resumeKey)
        let landed = state.landResume(ResumeSessionKey(machineID: "m1", sessionID: "other"), at: route("new"))
        #expect(!landed)
        #expect(state.destination == .board)
        #expect(state.pendingResume == resumeKey)
    }

    @Test func everyExplicitNavigationClearsThePendingResume() {
        var inbox = PhoneShellState()
        inbox.beginResume(resumeKey)
        inbox.select(.inbox)
        #expect(inbox.pendingResume == nil)

        var session = PhoneShellState()
        session.beginResume(resumeKey)
        session.selectSession(machineKey: "m2", sessionID: "x")
        #expect(session.pendingResume == nil)

        var notification = PhoneShellState()
        notification.beginResume(resumeKey)
        notification.openFromNotification(route: route("n"), questionID: nil)
        #expect(notification.pendingResume == nil)
        let landed = notification.landResume(resumeKey, at: route("new"))
        #expect(!landed)
        #expect(notification.destination == .session(route("n")))
    }

    // MARK: Re-selecting the current session

    @Test func selectingTheCurrentSessionKeepsItsRouteAndClosesTheDrawer() {
        var state = PhoneShellState(destination: .session(route("s1", conversation: "agent")), isDrawerOpen: true)
        state.selectSession(machineKey: "m1", sessionID: "s1")
        #expect(state.destination == .session(route("s1", conversation: "agent")))
        #expect(!state.isDrawerOpen)
    }

    @Test func selectingAnotherSessionOrMachineChangesTheRoute() {
        var state = PhoneShellState(destination: .session(route("s1")), isDrawerOpen: true)
        state.selectSession(machineKey: "m1", sessionID: "s2")
        #expect(state.destination == .session(route("s2")))
        state.selectSession(machineKey: "m2", sessionID: "s2")
        #expect(state.destination == .session(route("s2", machine: "m2")))
    }

    @Test func selectingASessionFromTheInboxOpensIt() {
        var state = PhoneShellState(isDrawerOpen: true)
        state.selectSession(machineKey: "m1", sessionID: "s1")
        #expect(state.destination == .session(route("s1")))
        #expect(!state.isDrawerOpen)
    }

    @Test func aNotificationRouteForTheSameSessionWithAnotherConversationStillChangesIt() {
        var state = PhoneShellState(destination: .session(route("s1")))
        state.openFromNotification(route: route("s1", conversation: "agent"), questionID: nil)
        #expect(state.destination == .session(route("s1", conversation: "agent")))
    }

    @Test func theBoardAndTheInboxAreBothPlacesToGo() {
        var state = PhoneShellState()
        state.select(.inbox)
        #expect(state.destination == .inbox)
        state.openDrawer()
        state.select(.board)
        #expect(state.destination == .board)
        #expect(!state.isDrawerOpen)
    }
}
