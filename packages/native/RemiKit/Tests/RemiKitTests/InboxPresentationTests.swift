import Testing
@testable import RemiUI

@Suite struct InboxPresentationTests {
    private func card(
        _ id: String,
        machine: String = "m1",
        session: String = "s1",
        agent: String? = nil,
        state: RemiQuestionState = .pending
    ) -> RemiQuestionCardModel {
        RemiQuestionCardModel(
            id: RemiQuestionCardModel.identity(machineID: machine, sessionID: session, questionID: id),
            questionID: id,
            kind: .generic,
            text: "Question \(id)",
            machineID: machine,
            machineName: machine,
            sessionID: session,
            sessionName: "Session \(session)",
            agentID: agent,
            state: state
        )
    }

    private func session(_ id: String, machine: String = "m1") -> RemiSessionSummary {
        RemiSessionSummary(
            id: id,
            machineID: machine,
            machineName: machine,
            name: "Session \(id)",
            harness: "claude",
            project: "remi",
            status: .idle
        )
    }

    @Test func noMachinesIsFirstRunEvenWithCards() {
        let state = RemiInboxPresentation.state(
            machineCount: 0, connectedMachineCount: 0, questions: [card("q1")], activeSessionCount: 0
        )
        #expect(state == .firstRun)
    }

    @Test func machinesWithNothingWaitingIsQuiet() {
        let state = RemiInboxPresentation.state(
            machineCount: 2, connectedMachineCount: 2, questions: [], activeSessionCount: 3
        )
        #expect(state == .quiet(activeSessionCount: 3, hasConnectedMachine: true, notes: []))
    }

    @Test func oneWaitingCardIsWaiting() {
        let q1 = card("q1")
        let state = RemiInboxPresentation.state(
            machineCount: 1, connectedMachineCount: 1, questions: [q1], activeSessionCount: 1
        )
        #expect(state == .waiting(cards: [q1], notes: []))
    }

    @Test func manyCardsKeepTheirOrderAndSendingStillWaits() {
        let cards = [card("q1"), card("q2", state: .sending), card("q3"), card("q4")]
        let state = RemiInboxPresentation.state(
            machineCount: 1, connectedMachineCount: 1, questions: cards, activeSessionCount: 4
        )
        #expect(state == .waiting(cards: cards, notes: []))
    }

    @Test func resolvedNotesAloneStayQuiet() {
        let note = card("q1", state: .resolvedElsewhere(nil))
        let state = RemiInboxPresentation.state(
            machineCount: 1, connectedMachineCount: 1, questions: [note], activeSessionCount: 0
        )
        #expect(state == .quiet(activeSessionCount: 0, hasConnectedMachine: true, notes: [note]))
    }

    @Test func notesAreSeparatedFromWaitingCards() {
        let waiting = card("q1")
        let note = card("q2", state: .resolvedElsewhere(nil))
        let finished = card("q3", state: .answered("yes"))
        let stale = card("q4", state: .stale)
        let state = RemiInboxPresentation.state(
            machineCount: 1,
            connectedMachineCount: 1,
            questions: [note, waiting, finished, stale],
            activeSessionCount: 1
        )
        #expect(state == .waiting(cards: [waiting], notes: [note, finished, stale]))
    }

    @Test func openTargetNamesTheCardsSessionAndMachine() {
        let target = RemiInboxPresentation.openTarget(
            for: card("q1"), sessions: [session("s1")]
        )
        #expect(target == .init(machineID: "m1", sessionID: "s1", conversationID: nil))
    }

    @Test func subagentCardCarriesItsConversationID() {
        let target = RemiInboxPresentation.openTarget(
            for: card("q1", agent: "agent-7"), sessions: [session("s1")]
        )
        #expect(target?.conversationID == "agent-7")
    }

    @Test func vanishedSessionHasNoTarget() {
        let target = RemiInboxPresentation.openTarget(
            for: card("q1", session: "gone"), sessions: [session("s1")]
        )
        #expect(target == nil)
    }

    @Test func sameSessionIDOnAnotherMachineDoesNotMatch() {
        let target = RemiInboxPresentation.openTarget(
            for: card("q1", machine: "m1"), sessions: [session("s1", machine: "m2")]
        )
        #expect(target == nil)
    }

    @Test func noConnectedMachineIsQuietButNotReassuring() {
        let state = RemiInboxPresentation.state(
            machineCount: 2, connectedMachineCount: 0, questions: [], activeSessionCount: 5
        )
        #expect(state == .quiet(activeSessionCount: 5, hasConnectedMachine: false, notes: []))
    }

    @Test func waitingCardsStillWaitWhenNoMachineIsConnected() {
        let q1 = card("q1")
        let state = RemiInboxPresentation.state(
            machineCount: 1, connectedMachineCount: 0, questions: [q1], activeSessionCount: 0
        )
        #expect(state == .waiting(cards: [q1], notes: []))
    }

    @Test func quietCopyWithActiveSessionsKeepsCountAndPickHint() {
        let copy = RemiInboxPresentation.quietCopy(activeSessionCount: 2, hasConnectedMachine: true)
        #expect(copy.title == "Nothing needs you")
        #expect(copy.detail == "2 active sessions. Open the menu to pick a session.")
        let one = RemiInboxPresentation.quietCopy(activeSessionCount: 1, hasConnectedMachine: true)
        #expect(one.detail == "1 active session. Open the menu to pick a session.")
    }

    @Test func quietCopyWithNoActiveSessionsPointsToRecentSessions() {
        let copy = RemiInboxPresentation.quietCopy(activeSessionCount: 0, hasConnectedMachine: true)
        #expect(copy.title == "Nothing needs you")
        #expect(copy.detail == "No active sessions. Open the menu to see recent sessions.")
    }

    @Test func quietCopyWithoutConnectedMachineSaysItCannotTell() {
        let copy = RemiInboxPresentation.quietCopy(activeSessionCount: 4, hasConnectedMachine: false)
        #expect(copy.title == "No machine is connected")
        #expect(copy.detail == "Remi cannot tell whether anything needs you. Check the machines above.")
        #expect(copy.symbolName != "checkmark.circle")
    }

    @Test func quietCopyNamesMachinesThatAreNotConnected() {
        let one = RemiInboxPresentation.quietCopy(activeSessionCount: 2, hasConnectedMachine: true, unconnectedMachineCount: 1)
        #expect(one.title == "Nothing needs you")
        #expect(one.detail == "2 active sessions. Open the menu to pick a session. 1\u{00A0}machine not connected: Remi cannot tell for them.")
        let many = RemiInboxPresentation.quietCopy(activeSessionCount: 0, hasConnectedMachine: true, unconnectedMachineCount: 4)
        #expect(many.detail == "No active sessions. Open the menu to see recent sessions. 4\u{00A0}machines not connected: Remi cannot tell for them.")
    }

    @Test func quietCopyIsUnchangedWithNoUnconnectedMachinesOrNoneConnected() {
        let none = RemiInboxPresentation.quietCopy(activeSessionCount: 1, hasConnectedMachine: true, unconnectedMachineCount: 0)
        #expect(none.detail == "1 active session. Open the menu to pick a session.")
        let nothingConnected = RemiInboxPresentation.quietCopy(activeSessionCount: 1, hasConnectedMachine: false, unconnectedMachineCount: 3)
        #expect(nothingConnected.title == "No machine is connected")
        #expect(nothingConnected.detail == "Remi cannot tell whether anything needs you. Check the machines above.")
    }

    @Test func reassuringMarkOnlyWhenAMachineIsConnected() {
        for count in [0, 1, 3] {
            let copy = RemiInboxPresentation.quietCopy(activeSessionCount: count, hasConnectedMachine: true)
            #expect(copy.symbolName == "checkmark.circle")
        }
    }

    @Test func expandedListCollapsesOnlyWhenTwoOrFewerRemain() {
        #expect(RemiInboxPresentation.keepsExpanded(wasExpanded: true, cardCount: 3))
        #expect(RemiInboxPresentation.keepsExpanded(wasExpanded: true, cardCount: 5))
        #expect(!RemiInboxPresentation.keepsExpanded(wasExpanded: true, cardCount: 2))
        #expect(!RemiInboxPresentation.keepsExpanded(wasExpanded: true, cardCount: 0))
        #expect(!RemiInboxPresentation.keepsExpanded(wasExpanded: false, cardCount: 5))
    }

    private func machine(_ id: String, _ reachability: RemiMachineReachability) -> RemiMachineSummary {
        RemiMachineSummary(id: id, name: id, address: id, reachability: reachability, transport: .direct, sessionCount: 0)
    }

    private func session(_ id: String, machine: String, live: Bool = true) -> RemiSessionSummary {
        RemiSessionSummary(id: id, machineID: machine, machineName: machine, name: id, harness: "h", project: "p", status: live ? .idle : .offline, isLive: live)
    }

    @Test func activeSessionsCountOnlyLiveSessionsOnConnectedMachines() {
        let machines = [machine("a", .connected), machine("b", .unreachable)]
        let sessions = [
            session("1", machine: "a"), session("2", machine: "a", live: false),
            session("3", machine: "b"), session("4", machine: "b"), session("5", machine: "b"),
        ]
        #expect(RemiInboxPresentation.activeSessionCount(sessions: sessions, machines: machines) == 1)
    }

    @Test func activeSessionsOnUnknownOrConnectingMachinesDoNotCount() {
        let machines = [machine("a", .connecting)]
        #expect(RemiInboxPresentation.activeSessionCount(sessions: [session("1", machine: "a"), session("2", machine: "zz")], machines: machines) == 0)
    }

    @Test func waitingCountSpansMachinesAndSkipsNotes() {
        let cards = [
            card("q1", machine: "m1"),
            card("q2", machine: "m2", state: .sending),
            card("q3", machine: "m2", state: .resolvedElsewhere(nil)),
            card("q4", machine: "m1", state: .stale),
        ]
        #expect(RemiInboxPresentation.waitingCount(questions: cards) == 2)
        #expect(RemiInboxPresentation.waitingCount(questions: []) == 0)
    }

    @Test func inboxAccessibilityLabelNamesTheCount() {
        #expect(RemiInboxPresentation.inboxAccessibilityLabel(waitingCount: 0) == "Inbox, nothing needs you")
        #expect(RemiInboxPresentation.inboxAccessibilityLabel(waitingCount: 1) == "Inbox, 1 needs you")
        #expect(RemiInboxPresentation.inboxAccessibilityLabel(waitingCount: 3) == "Inbox, 3 need you")
    }

    @Test func sidebarSelectionPrefersTheInboxAndKeepsTheMachine() {
        #expect(RemiMacSidebarSelection.resolve(showsInbox: true, machineID: "m1") == .inbox)
        #expect(RemiMacSidebarSelection.resolve(showsInbox: false, machineID: "m1") == .machine("m1"))
        #expect(RemiMacSidebarSelection.resolve(showsInbox: false, machineID: "") == nil)
        #expect(RemiMacSidebarSelection.machine("m1").machineID == "m1")
        #expect(RemiMacSidebarSelection.inbox.machineID == nil)
    }
}
