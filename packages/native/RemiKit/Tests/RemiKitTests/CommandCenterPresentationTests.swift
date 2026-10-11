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
        let questions = RemiPreviewData.questionStates

        let pathResult = RemiCommandCenterSnapshot(
            sessions: sessions,
            questions: questions,
            selectedMachineID: "",
            query: sessions[0].projectPath
        )
        #expect(pathResult.sessions.contains { $0.id == sessions[0].id })

        let detail = questions.compactMap(\.detail).first
        let questionResult = RemiCommandCenterSnapshot(
            sessions: sessions,
            questions: questions,
            selectedMachineID: "",
            query: detail ?? questions[0].text
        )
        #expect(!questionResult.questions.isEmpty)
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
}
