import Foundation
import RemiUI
import Testing
@testable import RemiKit

struct MachineStoreTests {
    @Test func workspaceSessionRequestMatchesTheWireContract() throws {
        let request = CreateSessionRequestMessage(
            id: "request-1",
            timestamp: "2026-10-07T12:00:00Z",
            directory: "~/Documents/git/remi",
            harness: "codex",
            workspace: WorkspaceRequest(
                repository: "~/Documents/git/remi",
                worktree: WorktreeRequest(branch: "feature/native", base: "develop")
            )
        )

        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        )
        let workspace = try #require(object["workspace"] as? [String: Any])
        let worktree = try #require(workspace["worktree"] as? [String: Any])

        #expect(object["type"] as? String == "create_session_request")
        #expect(object["directory"] as? String == "~/Documents/git/remi")
        #expect(object["harness"] as? String == "codex")
        #expect(workspace["repository"] as? String == "~/Documents/git/remi")
        #expect(worktree["branch"] as? String == "feature/native")
        #expect(worktree["base"] as? String == "develop")
    }

    @Test func legacySessionRequestOmitsWorkspace() throws {
        let request = CreateSessionRequestMessage(
            id: "request-2",
            timestamp: "2026-10-07T12:00:00Z",
            directory: "/tmp/project",
            harness: "claude"
        )
        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        )

        #expect(object["workspace"] == nil)
    }

    @Test func resumeSessionRequestMatchesTheWireContract() throws {
        let request = ResumeSessionRequestMessage(
            id: "resume-1",
            timestamp: "2026-10-08T12:00:00Z",
            sessionId: "stored-session"
        )
        let object = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        )

        #expect(object["type"] as? String == "resume_session_request")
        #expect(object["sessionId"] as? String == "stored-session")
    }

    @Test func resumeStateKeepsIdenticalSessionIDsSeparateByMachine() {
        let first = ResumeSessionKey(machineID: "one.example:18765", sessionID: "shared-id")
        let second = ResumeSessionKey(machineID: "two.example:18765", sessionID: "shared-id")

        #expect(first != second)
        #expect(Set([first, second]).count == 2)
    }

    @Test func recentRepositoriesResponseDecodes() throws {
        let data = Data(#"""
        {
            "type":"recent_repositories_response",
            "id":"response-1",
            "timestamp":"2026-10-07T12:00:00Z",
            "requestId":"request-1",
            "repositories":[{
                "repository":"/Users/me/remi",
                "name":"remi",
                "lastUsedAt":"2026-10-07T11:00:00Z"
            }]
        }
        """#.utf8)

        let response = try JSONDecoder().decode(RecentRepositoriesResponseMessage.self, from: data)
        #expect(response.repositories.first?.repository == "/Users/me/remi")
        #expect(response.repositories.first?.name == "remi")
    }

    @Test func endpointIdentityAndURLAreStable() throws {
        let endpoint = MachineEndpoint(host: "127.0.0.1", port: 18765)
        #expect(endpoint.id == "127.0.0.1:18765")
        #expect(endpoint.webSocketURL?.absoluteString == "ws://127.0.0.1:18765/ws")
    }

    @Test @MainActor func storeStartsWithEveryConfiguredMachine() {
        let endpoints = [
            MachineEndpoint(host: "127.0.0.1", port: 18765),
            MachineEndpoint(host: "100.64.0.2", port: 18765),
        ]
        let store = MachineStore(
            endpoints: endpoints,
            identity: ClientIdentity(),
            clientVersion: "test",
            clientId: "test-client"
        )
        #expect(store.machines.map(\.endpoint) == endpoints)
        #expect(store.machines.allSatisfy { !$0.hasLoadedSessions })
    }

    @Test @MainActor func removingMachineRemovesItsConfiguration() {
        let endpoint = MachineEndpoint(host: "127.0.0.1", port: 18765)
        let store = MachineStore(
            endpoints: [endpoint],
            identity: ClientIdentity(),
            clientVersion: "test",
            clientId: "test-client"
        )

        store.removeMachine(endpoint)

        #expect(store.machines.isEmpty)
    }

    @Test func activeSessionsMatchCapacitorDaemonSourceRule() throws {
        var machine = MachineState(
            endpoint: MachineEndpoint(host: "host.example", port: 18765),
            displayName: "Host"
        )
        machine.sessions = [
            try session(id: "live", source: "daemon"),
            try session(id: "recent", source: "transcript"),
        ]

        #expect(machine.activeSessions.map(\.sessionId) == ["live"])
    }

    @Test func notificationDestinationRoundTripsAllRoutingIdentity() throws {
        let destination = RemiNavigationDestination(
            machineID: "host.example:18765",
            sessionID: "session-1",
            questionID: "question-1",
            agentID: "agent-1"
        )

        let decoded = try JSONDecoder().decode(
            RemiNavigationDestination.self,
            from: JSONEncoder().encode(destination)
        )
        #expect(decoded == destination)
    }

    @Test @MainActor func resolutionAndSnapshotsPruneDuplicateMachineCollections() throws {
        let resolved = try question(id: "question-1", sessionId: "session-1")
        let stillLive = try question(id: "question-2", sessionId: "session-1")
        var first = MachineState(
            endpoint: MachineEndpoint(host: "one.example", port: 18765),
            displayName: "One"
        )
        var second = MachineState(
            endpoint: MachineEndpoint(host: "two.example", port: 18765),
            displayName: "Two"
        )
        first.questions = [resolved, stillLive]
        second.questions = [resolved]

        let afterResolution = MachineStore.resolvingQuestion(
            in: [first, second],
            sessionId: "session-1",
            questionId: "question-1"
        )
        #expect(afterResolution.flatMap(\.questions).map(\.question.id) == ["question-2"])

        var otherMachine = afterResolution[1]
        otherMachine.questions = [resolved]
        let firstAfterSnapshot = MachineStore.reconcilingQuestionSnapshot(
            in: afterResolution[0],
            sessionId: "session-1",
            liveQuestionIDs: []
        )
        #expect(firstAfterSnapshot.questions.isEmpty)
        #expect(otherMachine.questions.map(\.question.id) == ["question-1"])
    }

    @Test func machineEndpointsPersistWithoutLeakingUIState() {
        let key = "remi.machine-store-tests.\(UUID().uuidString)"
        let persistence = MachineConfigurationStore(key: key)
        let endpoints = [MachineEndpoint(host: "100.64.0.8", port: 18765)]
        persistence.save(endpoints)
        #expect(persistence.load() == endpoints)
        UserDefaults.standard.removeObject(forKey: key)
    }

    @Test func sessionPresentationKeepsStableMachineIdentity() {
        let session = RemiSessionSummary(
            id: "session-1",
            machineID: "host.example:18765",
            machineName: "Studio",
            name: "Native app",
            harness: "Claude",
            project: "remi",
            status: .working
        )

        #expect(session.machineID == "host.example:18765")
        #expect(session.machineName == "Studio")
    }

    @Test func structuredQuestionAcceptsExactlyOneSingleSelectAnswer() {
        let step = RemiQuestionStep(
            id: "0",
            text: "Which direction?",
            options: [RemiQuestionOption(id: "0", label: "Native")]
        )

        #expect(RemiQuestionForm.isComplete(
            steps: [step],
            selections: [RemiQuestionStepSelection(stepID: "0", optionIDs: ["0"])]
        ))
        #expect(RemiQuestionForm.isComplete(
            steps: [step],
            selections: [RemiQuestionStepSelection(stepID: "0", optionIDs: [], text: "Another path")]
        ))
        #expect(!RemiQuestionForm.isComplete(
            steps: [step],
            selections: [RemiQuestionStepSelection(stepID: "0", optionIDs: ["0"], text: "Both")]
        ))
        #expect(!RemiQuestionForm.isComplete(
            steps: [step],
            selections: [RemiQuestionStepSelection(
                stepID: "0",
                optionIDs: [],
                text: String(repeating: "a", count: RemiQuestionForm.freeTextLimit + 1)
            )]
        ))
    }

    @Test func unknownQuestionKindUsesGenericPresentation() {
        #expect(RemiQuestionKind(wireValue: "future_kind") == .generic)
        #expect(RemiQuestionKind(wireValue: nil) == .generic)
        #expect(RemiQuestionKind(wireValue: "permission") == .permission)
        #expect(RemiQuestionKind.generic.optionRole(isYes: true, isNo: false) == .neutral)
        #expect(RemiQuestionKind.permission.optionRole(isYes: true, isNo: false) == .allow)
    }
}

private func session(id: String, source: String) throws -> DiscoverableSession {
    try JSONDecoder().decode(DiscoverableSession.self, from: Data(#"""
    {
        "sessionId":"\#(id)","name":"Session","projectPath":"/tmp/project",
        "status":"idle","source":"\#(source)"
    }
    """#.utf8))
}

private func question(id: String, sessionId: String) throws -> QuestionMessage {
    try JSONDecoder().decode(QuestionMessage.self, from: Data(#"""
    {
        "type":"question","id":"message-\#(id)","timestamp":"2026-10-07T12:00:00Z",
        "sessionId":"\#(sessionId)","question":{
            "id":"\#(id)","text":"Continue?","options":[],
            "allowsFreeText":false,"isAnswered":false
        }
    }
    """#.utf8))
}
