import Testing
@testable import RemiUI

@Suite struct RemiSessionGroupingTests {
    private func session(
        _ id: String,
        name: String = "Session",
        status: RemiSessionStatus = .idle,
        activity: String? = nil,
        questions: Int = 0,
        live: Bool? = nil
    ) -> RemiSessionSummary {
        RemiSessionSummary(
            id: id,
            machineName: "Studio",
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
}
