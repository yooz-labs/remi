import Testing
@testable import RemiUI

@Suite struct WorkspaceGroupTests {
    private func session(
        _ id: String,
        _ status: RemiSessionStatus,
        activity: String? = nil,
        questions: Int = 0
    ) -> RemiSessionSummary {
        RemiSessionSummary(
            id: id,
            machineName: "Mac",
            name: id,
            harness: "claude",
            project: "transit",
            projectPath: "/work/transit",
            lastActivity: activity,
            status: status,
            openQuestionCount: questions
        )
    }

    private func group(_ sessions: [RemiSessionSummary]) throws -> RemiWorkspaceGroup {
        try #require(RemiWorkspaceGroup(sessions: sessions))
    }

    @Test func noSessionsMakeNoGroup() {
        #expect(RemiWorkspaceGroup(sessions: []) == nil)
    }

    @Test func latestIsTheMostUrgentThenTheMostRecent() throws {
        let group = try group([
            session("old-idle", .idle, activity: "2026-10-01T00:00:00Z"),
            session("new-idle", .idle, activity: "2026-10-20T00:00:00Z"),
            session("working", .working, activity: "2026-10-02T00:00:00Z"),
            session("asking", .needsYou, activity: "2026-09-01T00:00:00Z"),
        ])
        #expect(group.sessions.map(\.id) == ["asking", "working", "new-idle", "old-idle"])
    }

    @Test func counts() throws {
        let group = try group([
            session("a", .working),
            session("b", .working),
            session("c", .idle, questions: 0),
            session("d", .needsYou, questions: 2),
        ])
        #expect(group.workingCount == 2)
        #expect(group.questionCount == 2)
        #expect(group.needsAttention)
    }

    @Test func collapsedProjectWithSomeRunningShowsHowMany() throws {
        let group = try group([session("a", .working), session("b", .idle), session("c", .offline)])
        let summary = group.rowSummary(isExpanded: false)
        #expect(summary.countText == "1/3 active")
        #expect(summary.showsWorking)
        #expect(summary.questionCount == nil)
    }

    @Test func collapsedProjectWithAllRunning() throws {
        let group = try group([session("a", .working), session("b", .working)])
        #expect(group.rowSummary(isExpanded: false).countText == "2/2 active")
    }

    @Test func singleSessionShowsTheBadgeAndNoCount() throws {
        let running = try group([session("a", .working)]).rowSummary(isExpanded: false)
        #expect(running.countText == nil)
        #expect(running.showsWorking)

        let idle = try group([session("a", .idle)]).rowSummary(isExpanded: false)
        #expect(idle.countText == nil)
        #expect(!idle.showsWorking)
    }

    @Test func expandedProjectShowsOnlyTheSessionCount() throws {
        let group = try group([session("a", .working), session("b", .idle)])
        let summary = group.rowSummary(isExpanded: true)
        #expect(summary.countText == "2")
        #expect(!summary.showsWorking)
    }

    @Test func nothingRunningShowsOnlyTheSessionCount() throws {
        let summary = try group([session("a", .idle), session("b", .offline)]).rowSummary(isExpanded: false)
        #expect(summary.countText == "2")
        #expect(!summary.showsWorking)
    }

    @Test func waitingQuestionsOutrankWorking() throws {
        let group = try group([session("a", .working), session("b", .needsYou, questions: 1)])
        let summary = group.rowSummary(isExpanded: false)
        #expect(summary.questionCount == 1)
        #expect(summary.countText == nil)
        #expect(!summary.showsWorking)
    }

    @Test func voiceOverHearsWhatIsRunning() throws {
        let group = try group([session("a", .working), session("b", .working), session("c", .idle)])
        #expect(group.accessibilityLabel() == "transit, /work/transit, 3 sessions, 2 working")
        let waiting = try self.group([session("a", .needsYou, questions: 1)])
        #expect(waiting.accessibilityLabel() == "transit, /work/transit, 1 session, 1 question needs attention")
    }
}
