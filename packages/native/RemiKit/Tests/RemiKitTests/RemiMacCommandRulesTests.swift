import Testing
@testable import RemiUI

@Suite struct RemiMacCommandRulesTests {
    private func session(_ id: String, machine: String, status: RemiSessionStatus) -> RemiSessionSummary {
        RemiSessionSummary(
            id: id,
            machineID: machine,
            machineName: machine,
            name: id,
            harness: "claude",
            project: "remi",
            status: status
        )
    }

    private func key(_ machine: String, _ session: String) -> RemiSessionKey {
        RemiSessionKey(machineID: machine, sessionID: session)
    }

    @Test func nothingToJumpToDisablesTheCommandsThatNeedSomething() {
        let none = RemiMacCommandAvailability(
            machineCount: 0, needsYouSessionCount: 0, sessionListCount: 0, reconnect: nil
        )
        #expect(none.goToInbox == false)
        #expect(none.nextNeedsYou == false)
        #expect(none.previousSession == false && none.nextSession == false)
        #expect(none.previousMachine == false && none.nextMachine == false)
        #expect(none.reconnect == false)
    }

    @Test func oneMachineHasNoMachineToMoveTo() {
        let one = RemiMacCommandAvailability(
            machineCount: 1, needsYouSessionCount: 1, sessionListCount: 3, reconnect: .connection
        )
        #expect(one.goToInbox && one.nextNeedsYou && one.reconnect)
        #expect(one.previousSession && one.nextSession)
        #expect(one.previousMachine == false && one.nextMachine == false)

        let two = RemiMacCommandAvailability(
            machineCount: 2, needsYouSessionCount: 0, sessionListCount: 0, reconnect: nil
        )
        #expect(two.previousMachine && two.nextMachine)
        #expect(two.nextNeedsYou == false)
    }

    @Test func reconnectOnlyForStatesARetryCanFix() {
        typealias Reconnect = RemiMacCommandAvailability.Reconnect
        #expect(Reconnect.resolve(recovery: .retryableOffline) == .connection)
        #expect(Reconnect.resolve(recovery: .retryableUnavailable(reason: "x")) == .connection)
        #expect(Reconnect.resolve(recovery: .waitingForDirectApproval(fingerprint: "ab")) == .approval)
        #expect(Reconnect.resolve(recovery: .none) == nil)
        #expect(Reconnect.resolve(recovery: .waitingForRelayConfirmation(fingerprint: "ab")) == nil)
        #expect(Reconnect.resolve(recovery: .relayOffline) == nil)
        #expect(Reconnect.resolve(recovery: .relayNeedsFreshPairing(reason: nil)) == nil)
    }

    @Test func findNeedsAnOpenConversationWithEntries() {
        #expect(RemiMacCommandAvailability.canFind(hasOpenConversation: true, entryCount: 2))
        #expect(!RemiMacCommandAvailability.canFind(hasOpenConversation: true, entryCount: 0))
        #expect(!RemiMacCommandAvailability.canFind(hasOpenConversation: false, entryCount: 5))
    }

    @Test func needsYouJumpCrossesMachinesInMachineOrder() {
        let sessions = [
            session("b1", machine: "B", status: .needsYou),
            session("a1", machine: "A", status: .needsYou),
            session("a2", machine: "A", status: .idle),
            session("a3", machine: "A", status: .needsYou),
        ]
        let order = ["A", "B"]
        func next(_ from: RemiSessionKey?, _ offset: Int) -> RemiSessionKey? {
            RemiNeedsYouJump.target(from: from, sessions: sessions, machineOrder: order, offset: offset)
        }
        #expect(next(nil, 1) == key("A", "a1"))
        #expect(next(key("A", "a1"), 1) == key("A", "a3"))
        #expect(next(key("A", "a3"), 1) == key("B", "b1"))
        #expect(next(key("B", "b1"), 1) == key("A", "a1"))
        #expect(next(key("A", "a1"), -1) == key("B", "b1"))
        #expect(next(nil, -1) == key("B", "b1"))
        // A quiet session starts from the edge.
        #expect(next(key("A", "a2"), 1) == key("A", "a1"))
    }

    @Test func sameSessionIDOnTwoMachinesIsTwoTargets() {
        let sessions = [
            session("s", machine: "A", status: .needsYou),
            session("s", machine: "B", status: .needsYou),
        ]
        let target = RemiNeedsYouJump.target(
            from: key("A", "s"), sessions: sessions, machineOrder: ["A", "B"], offset: 1
        )
        #expect(target == key("B", "s"))
    }

    @Test func noWaitingSessionMeansNoTarget() {
        let sessions = [session("a", machine: "A", status: .working)]
        #expect(RemiNeedsYouJump.target(from: nil, sessions: sessions, machineOrder: ["A"], offset: 1) == nil)
    }
}
