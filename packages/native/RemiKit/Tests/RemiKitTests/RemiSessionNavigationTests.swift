import Testing
@testable import RemiUI

@Suite struct RemiSessionNavigationTests {
    private func session(
        _ id: String,
        machine: String = "m1",
        activity: String,
        live: Bool = true
    ) -> RemiSessionSummary {
        RemiSessionSummary(
            id: id,
            machineID: machine,
            machineName: machine,
            name: id,
            harness: "Claude",
            project: "remi",
            lastActivity: activity,
            status: .idle,
            isLive: live
        )
    }

    // Newest first: c, b, a. The stored session never takes part: opening it needs Resume.
    private var sessions: [RemiSessionSummary] {
        [
            session("a", activity: "2026-10-21T09:00:00Z"),
            session("b", activity: "2026-10-21T10:00:00Z"),
            session("c", activity: "2026-10-21T11:00:00Z"),
            session("old", activity: "2026-10-20T09:00:00Z", live: false),
        ]
    }

    private func key(_ id: String, machine: String = "m1") -> RemiSessionKey {
        RemiSessionKey(machineID: machine, sessionID: id)
    }

    @Test func nextFollowsTheDrawerOrderAndSkipsStoredSessions() {
        let next = RemiSessionNavigation.shifted(from: key("c"), in: sessions, machineKey: nil, offset: 1)
        #expect(next?.id == "b")
    }

    @Test func previousWrapsToTheEnd() {
        let previous = RemiSessionNavigation.shifted(from: key("c"), in: sessions, machineKey: nil, offset: -1)
        #expect(previous?.id == "a")
    }

    @Test func noCurrentSessionStartsAtTheEdge() {
        #expect(RemiSessionNavigation.shifted(from: nil, in: sessions, machineKey: nil, offset: 1)?.id == "c")
        #expect(RemiSessionNavigation.shifted(from: nil, in: sessions, machineKey: nil, offset: -1)?.id == "a")
    }

    @Test func machineFilterNarrowsTheCycle() {
        let mixed = sessions + [session("x", machine: "m2", activity: "2026-10-21T12:00:00Z")]
        let next = RemiSessionNavigation.shifted(from: key("x", machine: "m2"), in: mixed, machineKey: "m2", offset: 1)
        #expect(next?.id == "x")
        #expect(RemiSessionNavigation.shifted(from: nil, in: mixed, machineKey: "m1", offset: 1)?.machineID == "m1")
    }

    @Test func noLiveSessionsGivesNothing() {
        let stored = [session("old", activity: "2026-10-20T09:00:00Z", live: false)]
        #expect(RemiSessionNavigation.shifted(from: nil, in: stored, machineKey: nil, offset: 1) == nil)
    }
}
