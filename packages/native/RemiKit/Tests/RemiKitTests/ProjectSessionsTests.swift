import Testing
@testable import RemiUI

@Suite struct ProjectSessionsTests {
    private func session(
        _ id: String,
        machine: String = "m1",
        path: String = "/work/transit",
        activity: String? = nil,
        name: String? = nil,
        status: RemiSessionStatus = .idle
    ) -> RemiSessionSummary {
        RemiSessionSummary(
            id: id, machineID: machine, machineName: machine, name: name ?? id,
            harness: "claude", project: "transit", projectPath: path,
            lastActivity: activity, status: status)
    }

    @Test func othersExcludeTheSessionAndComeMostRecentFirst() {
        let a = session("a", activity: "2026-10-01T00:00:00Z")
        let b = session("b", activity: "2026-10-03T00:00:00Z")
        let c = session("c", activity: "2026-10-02T00:00:00Z")
        let index = RemiProjectSessions(sessions: [a, b, c])
        #expect(index.others(than: a).map(\.id) == ["b", "c"])
        #expect(index.others(than: b).map(\.id) == ["c", "a"])
    }

    @Test func aProjectOnAnotherMachineOrPathIsNotMixedIn() {
        let here = session("here")
        let index = RemiProjectSessions(sessions: [
            here,
            session("other-machine", machine: "m2"),
            session("other-path", path: "/work/other"),
            session("sibling"),
        ])
        #expect(index.others(than: here).map(\.id) == ["sibling"])
    }

    @Test func theListIsCapped() {
        let all = (0..<20).map { session("s\($0)", activity: "2026-10-01T00:00:\(String(format: "%02d", $0))Z") }
        let index = RemiProjectSessions(sessions: all)
        #expect(index.others(than: all[0]).count == RemiProjectSessions.defaultLimit)
        #expect(index.others(than: all[0], limit: 3).count == 3)
        // The cap keeps the newest.
        #expect(index.others(than: all[0], limit: 1).map(\.id) == ["s19"])
    }

    @Test func equalTimesSettleTheSameWayEveryPass() {
        let sessions = [session("z", name: "Zed"), session("a", name: "Alpha"), session("m", name: "Mid")]
        let one = RemiProjectSessions(sessions: sessions).others(than: session("x"))
        let two = RemiProjectSessions(sessions: sessions.reversed()).others(than: session("x"))
        #expect(one.map(\.id) == ["a", "m", "z"])
        #expect(two.map(\.id) == one.map(\.id))
    }

    @Test func aProjectWithNothingElseHasNoOthers() {
        let only = session("only")
        #expect(RemiProjectSessions(sessions: [only]).others(than: only).isEmpty)
        #expect(RemiProjectSessions(sessions: []).others(than: only).isEmpty)
    }

    @Test func workingIsOnlyClaimedByAMachineThatIsReachable() {
        #expect(RemiSessionStatus.working.whileMachine(connected: true) == .working)
        #expect(RemiSessionStatus.working.whileMachine(connected: false) == .idle)
        // Nothing else is rewritten: a waiting question stays visible whatever the connection.
        #expect(RemiSessionStatus.needsYou.whileMachine(connected: false) == .needsYou)
        #expect(RemiSessionStatus.idle.whileMachine(connected: false) == .idle)
        #expect(RemiSessionStatus.offline.whileMachine(connected: false) == .offline)
    }
}
