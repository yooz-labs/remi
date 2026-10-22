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
            machineCount: 0, questions: [card("q1")], activeSessionCount: 0
        )
        #expect(state == .firstRun)
    }

    @Test func machinesWithNothingWaitingIsQuiet() {
        let state = RemiInboxPresentation.state(
            machineCount: 2, questions: [], activeSessionCount: 3
        )
        #expect(state == .quiet(activeSessionCount: 3, notes: []))
    }

    @Test func oneWaitingCardIsWaiting() {
        let q1 = card("q1")
        let state = RemiInboxPresentation.state(
            machineCount: 1, questions: [q1], activeSessionCount: 1
        )
        #expect(state == .waiting(cards: [q1], notes: []))
    }

    @Test func manyCardsKeepTheirOrderAndSendingStillWaits() {
        let cards = [card("q1"), card("q2", state: .sending), card("q3"), card("q4")]
        let state = RemiInboxPresentation.state(
            machineCount: 1, questions: cards, activeSessionCount: 4
        )
        #expect(state == .waiting(cards: cards, notes: []))
    }

    @Test func resolvedNotesAloneStayQuiet() {
        let note = card("q1", state: .resolvedElsewhere(nil))
        let state = RemiInboxPresentation.state(
            machineCount: 1, questions: [note], activeSessionCount: 0
        )
        #expect(state == .quiet(activeSessionCount: 0, notes: [note]))
    }

    @Test func notesAreSeparatedFromWaitingCards() {
        let waiting = card("q1")
        let note = card("q2", state: .resolvedElsewhere(nil))
        let finished = card("q3", state: .answered("yes"))
        let stale = card("q4", state: .stale)
        let state = RemiInboxPresentation.state(
            machineCount: 1,
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
}
