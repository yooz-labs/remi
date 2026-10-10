import Foundation
@testable import RemiKit
@testable import RemiUI
import Testing

struct PendingQuestionPresentationTests {
    @Test func groupsMachinesAndRequestsDeterministically() throws {
        var zeta = MachineState(
            endpoint: MachineEndpoint(host: "zeta.local", port: 18765),
            displayName: "Zeta"
        )
        zeta.status = .connected
        zeta.sessions = [try session(id: "session-b", name: "Beta", project: "/work/beta", harness: "codex")]
        zeta.questions = [
            try question(id: "question-z", sessionID: "session-b"),
            try question(id: "question-a", sessionID: "session-b"),
        ]

        var alpha = MachineState(
            endpoint: MachineEndpoint(host: "127.0.0.1", port: 18765),
            displayName: "alpha"
        )
        alpha.questions = [try question(id: "question-local", sessionID: "session-a")]

        let groups = RemiPendingQuestionPresentation.groups(machines: [zeta, alpha])

        #expect(groups.map(\.machineName) == ["alpha", "Zeta"])
        #expect(groups[0].transport == .local)
        #expect(groups[0].reachability == .unreachable)
        #expect(groups[1].transport == .direct)
        #expect(groups[1].reachability == .connected)
        #expect(groups[1].items.map(\.questionID) == ["question-a", "question-z"])
    }

    @Test func carriesSessionProjectHarnessAndSubagentContext() throws {
        var machine = MachineState(
            endpoint: MachineEndpoint(host: "studio.local", port: 18765),
            displayName: "Studio"
        )
        machine.sessions = [try session(
            id: "session",
            name: "Native app",
            project: "/Users/me/remi",
            harness: "claude"
        )]
        machine.questions = [try question(id: "question", sessionID: "session", agentID: "reviewer")]

        let item = try #require(RemiPendingQuestionPresentation.groups(
            machines: [machine],
            viewsBySession: ["session": [SessionViewMeta(agentId: "reviewer", agentType: "Code reviewer", active: true)]]
        ).first?.items.first)

        #expect(item.model.sessionName == "Native app")
        #expect(item.projectName == "remi")
        #expect(item.harnessName == "Claude Code")
        #expect(item.conversationName == "Code reviewer")
        #expect(item.destination.agentID == "reviewer")
    }

    @Test func bothGrantShapesArePresentedAsSessionScoped() throws {
        var machine = MachineState(
            endpoint: MachineEndpoint(host: "studio.local", port: 18765),
            displayName: "Studio"
        )
        machine.questions = [try question(
            id: "grant",
            sessionID: "session",
            options: [
                testOption(label: "Allow rule", value: "rule", standingGrant: "addRules"),
                testOption(label: "Allow mode", value: "mode", sessionGrant: "acceptEdits"),
            ]
        )]

        let options = try #require(
            RemiPendingQuestionPresentation.groups(machines: [machine]).first?.items.first?.model.options
        )

        #expect(options.map(\.grantsForSession) == [true, true])
    }

    @Test func unknownAnswerPathRemainsFailClosed() throws {
        var machine = MachineState(
            endpoint: MachineEndpoint(host: "studio.local", port: 18765),
            displayName: "Studio"
        )
        machine.questions = [try question(id: "future", sessionID: "session", answerPath: "future")]

        let model = try #require(
            RemiPendingQuestionPresentation.groups(machines: [machine]).first?.items.first?.model
        )

        #expect(model.terminalOnly)
    }

    private func session(id: String, name: String, project: String, harness: String) throws -> DiscoverableSession {
        let object: [String: Any] = [
            "sessionId": id,
            "name": name,
            "projectPath": project,
            "status": "active",
            "source": "daemon",
            "harness": harness,
        ]
        return try JSONDecoder().decode(DiscoverableSession.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func question(
        id: String,
        sessionID: String,
        agentID: String? = nil,
        answerPath: String = "structured",
        options: [[String: Any]] = [
            testOption(label: "Yes", value: "yes", isYes: true),
            testOption(label: "No", value: "no", isNo: true),
        ]
    ) throws -> QuestionMessage {
        var question: [String: Any] = [
            "id": id,
            "text": "Proceed with the request?",
            "options": options,
            "allowsFreeText": false,
            "isAnswered": false,
            "answerPath": answerPath,
            "kind": "permission",
        ]
        if let agentID { question["agentId"] = agentID }
        let object: [String: Any] = [
            "type": "question",
            "id": "message-\(id)",
            "timestamp": "2026-10-10T00:00:00Z",
            "question": question,
            "sessionId": sessionID,
        ]
        return try JSONDecoder().decode(QuestionMessage.self, from: JSONSerialization.data(withJSONObject: object))
    }

}

private func testOption(
    label: String,
    value: String,
    isYes: Bool = false,
    isNo: Bool = false,
    standingGrant: String? = nil,
    sessionGrant: String? = nil
) -> [String: Any] {
    [
        "label": label,
        "value": value,
        "isRecommended": false,
        "isYes": isYes,
        "isNo": isNo,
        "description": NSNull(),
        "suggestionIndex": NSNull(),
        "standingGrant": standingGrant ?? NSNull(),
        "sessionGrant": sessionGrant ?? NSNull(),
    ]
}
