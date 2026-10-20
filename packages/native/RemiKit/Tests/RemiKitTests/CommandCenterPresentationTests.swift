import Testing
@testable import RemiUI

@Suite struct CommandCenterPresentationTests {
    @Test func scopesSessionsAndQuestionsToOneMachine() {
        let studioSession = RemiPreviewData.primarySession
        let laptopSession = RemiSessionSummary(
            id: "laptop-session",
            machineID: "laptop",
            machineName: "Laptop",
            name: "Documentation",
            harness: "Claude",
            project: "remi",
            status: .idle
        )
        let studioQuestion = RemiQuestionCardModel(
            id: "studio-question",
            kind: .generic,
            text: "Continue?",
            machineID: "studio",
            machineName: "Studio",
            sessionID: studioSession.id,
            sessionName: studioSession.name
        )
        let laptopQuestion = RemiQuestionCardModel(
            id: "laptop-question",
            kind: .generic,
            text: "Continue?",
            machineID: "laptop",
            machineName: "Laptop",
            sessionID: laptopSession.id,
            sessionName: laptopSession.name
        )
        let snapshot = RemiCommandCenterSnapshot(
            sessions: [studioSession, laptopSession],
            questions: [studioQuestion, laptopQuestion],
            selectedMachineID: "studio",
            query: ""
        )

        #expect(snapshot.sessions.map(\.id) == [studioSession.id])
        #expect(snapshot.questions.map(\.id) == [studioQuestion.id])
    }

    @Test func searchMatchesProjectPathHarnessAndQuestionDetail() {
        let sessions = RemiPreviewData.sessions
        let detailedQuestion = RemiQuestionCardModel(
            id: "detailed-question",
            kind: .permission,
            text: "Allow this command?",
            detail: "swift test --filter CommandCenter",
            machineID: "studio",
            machineName: "Studio",
            sessionID: sessions[0].id,
            sessionName: sessions[0].name
        )

        let pathResult = RemiCommandCenterSnapshot(
            sessions: sessions,
            questions: [],
            selectedMachineID: "",
            query: sessions[0].projectPath
        )
        #expect(pathResult.sessions.contains { $0.id == sessions[0].id })

        let harnessResult = RemiCommandCenterSnapshot(
            sessions: sessions,
            questions: [],
            selectedMachineID: "",
            query: "Codex"
        )
        #expect(harnessResult.sessions.contains { $0.harness == "Codex" })

        let questionResult = RemiCommandCenterSnapshot(
            sessions: sessions,
            questions: [detailedQuestion],
            selectedMachineID: "",
            query: "CommandCenter"
        )
        #expect(questionResult.questions.map(\.id) == [detailedQuestion.id])
        #expect(questionResult.sessions.map(\.id) == [sessions[0].id])
    }

    @Test func whitespaceQueryBehavesLikeNoSearch() {
        let snapshot = RemiCommandCenterSnapshot(
            sessions: RemiPreviewData.sessions,
            questions: RemiPreviewData.questionStates,
            selectedMachineID: "",
            query: " \n "
        )

        #expect(snapshot.sessions == RemiPreviewData.sessions)
        #expect(snapshot.questions == RemiPreviewData.questionStates)
    }

    @Test func countsDistinctWorkspacesAndOnlyUnresolvedQuestions() {
        let snapshot = RemiCommandCenterSnapshot(
            sessions: RemiPreviewData.sessions,
            questions: RemiPreviewData.questionStates,
            selectedMachineID: "",
            query: ""
        )

        #expect(snapshot.workspaceCount == Set(RemiPreviewData.sessions.map { "\($0.machineID)|\($0.projectPath)" }).count)
        #expect(snapshot.activeSessionCount == RemiPreviewData.sessions.count(where: \.isLive))
        #expect(snapshot.waitingQuestionCount == RemiPreviewData.questionStates.count { question in
            switch question.state {
            case .pending, .sending: true
            case .answered, .resolvedElsewhere, .stale: false
            }
        })
    }

    @Test func activityScopesComposeWithMachineScopeAndExposeStableCounts() {
        let sessions = scopedSessions
        let questions = scopedQuestions
        let snapshot = RemiCommandCenterSnapshot(
            sessions: sessions,
            questions: questions,
            selectedMachineID: "studio",
            query: "",
            scope: .needsYou
        )

        #expect(snapshot.sessions.map(\.id) == ["waiting"])
        #expect(snapshot.questions.map(\.id) == ["question"])
        #expect(snapshot.scopeCounts[.overview] == 3)
        #expect(snapshot.scopeCounts[.needsYou] == 1)
        #expect(snapshot.scopeCounts[.active] == 2)
        #expect(snapshot.scopeCounts[.recent] == 1)
    }

    @Test func activeAndRecentScopesSeparateLiveAndFinishedWork() {
        let active = RemiCommandCenterSnapshot(
            sessions: scopedSessions,
            questions: scopedQuestions,
            selectedMachineID: "studio",
            query: "",
            scope: .active
        )
        let recent = RemiCommandCenterSnapshot(
            sessions: scopedSessions,
            questions: scopedQuestions,
            selectedMachineID: "studio",
            query: "",
            scope: .recent
        )

        #expect(active.sessions.map(\.id) == ["waiting", "working"])
        #expect(active.questions.map(\.id) == ["question", "resolved"])
        #expect(recent.sessions.map(\.id) == ["finished"])
        #expect(recent.questions.isEmpty)
    }

    @Test func needsYouScopeExcludesResolvedQuestionsAndUnrelatedSessions() {
        let snapshot = RemiCommandCenterSnapshot(
            sessions: scopedSessions,
            questions: scopedQuestions,
            selectedMachineID: "studio",
            query: "",
            scope: .needsYou
        )

        #expect(snapshot.questions.map(\.id) == ["question"])
        #expect(snapshot.sessions.map(\.id) == ["waiting"])
    }

    @Test func searchFiltersTheChosenScopeWithoutChangingItsCounts() {
        let snapshot = RemiCommandCenterSnapshot(
            sessions: scopedSessions,
            questions: scopedQuestions,
            selectedMachineID: "studio",
            query: "/src/working",
            scope: .active
        )

        #expect(snapshot.sessions.map(\.id) == ["working"])
        #expect(snapshot.questions.isEmpty)
        #expect(snapshot.scopeCounts[.active] == 2)
        #expect(snapshot.scopeCounts[.recent] == 1)
    }

    @Test func recentDisclosureFollowsScopeSearchAndManualChoice() {
        #expect(RemiCommandCenterDisclosure.showsRecent(scope: .recent, query: "", manuallyExpanded: false))
        #expect(RemiCommandCenterDisclosure.showsRecent(scope: .overview, query: "remi", manuallyExpanded: false))
        #expect(RemiCommandCenterDisclosure.showsRecent(scope: .overview, query: "", manuallyExpanded: true))
        #expect(!RemiCommandCenterDisclosure.showsRecent(scope: .overview, query: "", manuallyExpanded: false))
        #expect(RemiCommandCenterDisclosure.showsMachineManagement(hasRecoveryWork: true, manuallyExpanded: false))
        #expect(RemiCommandCenterDisclosure.showsMachineManagement(hasRecoveryWork: false, manuallyExpanded: true))
        #expect(!RemiCommandCenterDisclosure.showsMachineManagement(hasRecoveryWork: false, manuallyExpanded: false))
    }

    @Test func workspaceOrderingPrioritizesAttentionThenLiveThenRecentActivity() {
        let waiting = [session(id: "waiting", status: .needsYou, activity: "2026-10-10T08:00:00Z")]
        let working = [session(id: "working", status: .working, activity: "2026-10-12T08:00:00Z")]
        let recent = [session(id: "recent", status: .offline, activity: "2026-10-12T09:00:00Z", isLive: false)]
        let older = [session(id: "older", status: .working, activity: "2026-10-11T08:00:00Z")]

        #expect(RemiWorkspaceOrdering.sortsBefore(waiting, working))
        #expect(RemiWorkspaceOrdering.sortsBefore(working, recent))
        #expect(RemiWorkspaceOrdering.sortsBefore(working, older))
    }

    private var scopedSessions: [RemiSessionSummary] {
        [
            session(id: "waiting", status: .needsYou),
            session(id: "working", status: .working),
            session(id: "finished", status: .offline, isLive: false),
            RemiSessionSummary(
                id: "laptop",
                machineID: "laptop",
                machineName: "Laptop",
                name: "Laptop",
                harness: "claude",
                project: "other",
                status: .working
            ),
        ]
    }

    private var scopedQuestions: [RemiQuestionCardModel] {
        [
            question(id: "question", sessionID: "waiting", state: .pending),
            question(id: "resolved", sessionID: "working", state: .resolvedElsewhere(.terminal)),
        ]
    }

    private func session(
        id: String,
        status: RemiSessionStatus,
        activity: String? = nil,
        isLive: Bool = true
    ) -> RemiSessionSummary {
        RemiSessionSummary(
            id: id,
            machineID: "studio",
            machineName: "Studio",
            name: id.capitalized,
            harness: "claude",
            project: id,
            projectPath: "/src/\(id)",
            lastActivity: activity,
            status: status,
            isLive: isLive
        )
    }

    private func question(
        id: String,
        sessionID: String,
        state: RemiQuestionState
    ) -> RemiQuestionCardModel {
        RemiQuestionCardModel(
            id: id,
            kind: .permission,
            text: "Continue?",
            machineID: "studio",
            machineName: "Studio",
            sessionID: sessionID,
            sessionName: sessionID,
            state: state
        )
    }
}
