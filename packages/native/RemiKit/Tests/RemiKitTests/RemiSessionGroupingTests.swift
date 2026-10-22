import Testing
@testable import RemiUI

@Suite struct RemiSessionGroupingTests {
    private func session(
        _ id: String,
        name: String = "Session",
        status: RemiSessionStatus = .idle,
        activity: String? = nil,
        questions: Int = 0,
        live: Bool? = nil,
        machine: String = "Studio"
    ) -> RemiSessionSummary {
        RemiSessionSummary(
            id: id,
            machineID: machine,
            machineName: machine,
            name: name,
            harness: "Claude",
            project: "remi",
            lastActivity: activity,
            status: status,
            openQuestionCount: questions,
            isLive: live
        )
    }

    @Test func splitsLiveSessionsByNeed() {
        let grouping = RemiSessionGrouping(sessions: [
            session("a", status: .needsYou),
            session("b", status: .working, questions: 1),
            session("c", status: .working),
            session("d", status: .offline),
            session("e", status: .needsYou, live: false),
        ])
        #expect(Set(grouping.needsYou.map(\.id)) == ["a", "b"])
        #expect(grouping.active.map(\.id) == ["c"])
        #expect(Set(grouping.recent.map(\.id)) == ["d", "e"])
        #expect(!grouping.isEmpty)
        #expect(grouping.flattened.count == 5)
    }

    @Test func sortsByActivityThenNameThenID() {
        let grouping = RemiSessionGrouping(sessions: [
            session("1", name: "beta", activity: "2026-10-01T10:00:00Z"),
            session("2", name: "Alpha", activity: "2026-10-01T10:00:00Z"),
            session("3", name: "zeta", activity: "2026-10-02T10:00:00Z"),
            session("5", name: "alpha", activity: "2026-10-01T10:00:00Z"),
            session("4", name: "none", activity: nil),
        ])
        #expect(grouping.active.map(\.id) == ["3", "2", "5", "1", "4"])
    }

    @Test func flattenedFollowsGroupOrder() {
        let grouping = RemiSessionGrouping(sessions: [
            session("recent", status: .offline),
            session("active", status: .working),
            session("need", status: .needsYou),
        ])
        #expect(grouping.flattened.map(\.id) == ["need", "active", "recent"])
    }

    @Test func emptyInputIsEmpty() {
        let grouping = RemiSessionGrouping(sessions: [])
        #expect(grouping.isEmpty)
        #expect(grouping.flattened.isEmpty)
    }

    @Test func groupsPreviewFixtures() {
        let grouping = RemiSessionGrouping(sessions: RemiPreviewData.sessions)
        #expect(grouping.needsYou.map(\.id) == ["1"])
        #expect(grouping.active.map(\.id) == ["2"])
        #expect(grouping.recent.map(\.id) == ["3"])
    }

    @Test func frozenKeepsOrderAndMembership() {
        let snapshot = RemiSessionGrouping(sessions: [
            session("a", status: .needsYou, activity: "2026-10-03T10:00:00Z"),
            session("b", status: .working, activity: "2026-10-02T10:00:00Z"),
            session("c", status: .working, activity: "2026-10-01T10:00:00Z"),
        ])
        let latest = RemiSessionGrouping(sessions: [
            session("c", status: .working, activity: "2026-10-09T10:00:00Z"),
            session("b", status: .working, activity: "2026-10-02T10:00:00Z"),
            session("a", status: .working, activity: "2026-10-03T10:00:00Z"),
        ])
        let frozen = latest.frozen(to: snapshot)
        #expect(frozen.needsYou.map(\.id) == ["a"])
        #expect(frozen.active.map(\.id) == ["b", "c"])
    }

    @Test func frozenUpdatesRowsInPlace() {
        let snapshot = RemiSessionGrouping(sessions: [session("a", status: .working)])
        let latest = RemiSessionGrouping(sessions: [session("a", status: .needsYou, questions: 2)])
        let frozen = latest.frozen(to: snapshot)
        #expect(frozen.needsYou.isEmpty)
        #expect(frozen.active.first?.status == .needsYou)
        #expect(frozen.active.first?.openQuestionCount == 2)
    }

    @Test func frozenAppendsNewSessionsToTheirCurrentSection() {
        let snapshot = RemiSessionGrouping(sessions: [session("a", status: .working, activity: "2026-10-01T10:00:00Z")])
        let latest = RemiSessionGrouping(sessions: [
            session("n", status: .working, activity: "2026-10-09T10:00:00Z"),
            session("a", status: .working, activity: "2026-10-01T10:00:00Z"),
            session("r", status: .offline),
        ])
        let frozen = latest.frozen(to: snapshot)
        #expect(frozen.active.map(\.id) == ["a", "n"])
        #expect(frozen.recent.map(\.id) == ["r"])
    }

    @Test func frozenDropsVanishedSessions() {
        let snapshot = RemiSessionGrouping(sessions: [session("a"), session("gone", status: .offline)])
        let latest = RemiSessionGrouping(sessions: [session("a")])
        let frozen = latest.frozen(to: snapshot)
        #expect(frozen.active.map(\.id) == ["a"])
        #expect(frozen.recent.isEmpty)
    }

    @Test func frozenEmptyCases() {
        let some = RemiSessionGrouping(sessions: [session("a")])
        let none = RemiSessionGrouping(sessions: [])
        #expect(some.frozen(to: none).active.map(\.id) == ["a"])
        #expect(none.frozen(to: some).isEmpty)
        #expect(none.frozen(to: none).isEmpty)
    }

    @Test func keyCombinesMachineAndSession() {
        let a = session("1", machine: "A")
        let b = session("1", machine: "B")
        #expect(a.key != b.key)
        #expect(a.key == RemiSessionKey(machineID: "A", sessionID: "1"))
    }

    @Test func sameSessionIDOnTwoMachinesStaysTwoRows() {
        let grouping = RemiSessionGrouping(sessions: [
            session("1", status: .working, machine: "A"),
            session("1", status: .working, machine: "B"),
        ])
        #expect(grouping.active.count == 2)
        #expect(grouping.active.map(\.machineID) == ["A", "B"])
    }

    @Test func frozenKeepsRowsOfTheSameIDOnDifferentMachinesApart() {
        let snapshot = RemiSessionGrouping(sessions: [
            session("1", status: .working, machine: "B"),
            session("1", status: .offline, machine: "A"),
        ])
        let latest = RemiSessionGrouping(sessions: [
            session("1", status: .needsYou, questions: 1, machine: "A"),
            session("1", status: .working, machine: "B"),
        ])
        let frozen = latest.frozen(to: snapshot)
        #expect(frozen.active.map(\.machineID) == ["B"])
        #expect(frozen.recent.map(\.machineID) == ["A"])
        #expect(frozen.recent.first?.openQuestionCount == 1)
        #expect(frozen.needsYou.isEmpty)
    }

    @Test func frozenDoesNotTreatAnotherMachinesSessionAsKnown() {
        let snapshot = RemiSessionGrouping(sessions: [session("1", machine: "A")])
        let latest = RemiSessionGrouping(sessions: [session("1", machine: "A"), session("1", machine: "B")])
        #expect(latest.frozen(to: snapshot).active.map(\.machineID) == ["A", "B"])
    }
}
