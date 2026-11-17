import Foundation
import Testing
@testable import RemiKit
@testable import RemiUI

@MainActor
@Suite(.serialized)
struct RemiQuestionNotificationStoreTests {
    private struct Fixture {
        let store: MachineStore
        let root: MachineEndpoint
        let rootGeneration: UUID
        let child: MachineEndpoint
        let childGeneration: UUID
        let machineID: String
        let sessionID: String
    }

    @Test func firstSnapshotIsStablePerGenerationAndChildReconnectInvalidatesIt() throws {
        let fixture = try fixture()
        defer { fixture.store.stop() }
        let store = fixture.store
        let sessionKey = MachineSessionKey(machineID: fixture.machineID, sessionID: fixture.sessionID)
        let firstQuestion = try question(sessionID: fixture.sessionID, id: "question-one")
        let nextQuestion = try question(sessionID: fixture.sessionID, id: "question-two")

        store.receive(.connected(sessionId: nil), from: fixture.child, generation: fixture.childGeneration)
        store.receive(.hello(try hello(attachState: "attached")), from: fixture.child, generation: fixture.childGeneration)
        store.receive(.question(firstQuestion), from: fixture.child, generation: fixture.childGeneration)
        store.receive(.questionSnapshot(try snapshot(sessionID: fixture.sessionID, questionIDs: [firstQuestion.question.id])),
            from: fixture.child, generation: fixture.childGeneration)
        #expect(store.machine(withIdentifier: fixture.machineID)?.currentQuestionSnapshot(for: fixture.sessionID)?.questionIDs
            == [firstQuestion.question.id])

        store.receive(.questionSnapshot(try snapshot(sessionID: fixture.sessionID, questionIDs: [nextQuestion.question.id])),
            from: fixture.child, generation: fixture.childGeneration)
        #expect(store.machine(withIdentifier: fixture.machineID)?.currentQuestionSnapshot(for: fixture.sessionID)?.questionIDs
            == [firstQuestion.question.id])

        store.routeBySession[sessionKey] = nil
        store.ownedReplaceConnectionGeneration(fixture.child)
        let reconnectGeneration = try #require(store.connectionGenerations[fixture.child])
        store.receive(.connected(sessionId: nil), from: fixture.child, generation: reconnectGeneration)
        #expect(store.machine(withIdentifier: fixture.machineID)?.currentQuestionSnapshot(for: fixture.sessionID) == nil)

        store.receive(.hello(try hello(attachState: "attached")), from: fixture.child, generation: reconnectGeneration)
        store.receive(.question(nextQuestion), from: fixture.child, generation: reconnectGeneration)
        #expect(store.machine(withIdentifier: fixture.machineID)?.currentQuestionSnapshot(for: fixture.sessionID) == nil)

        store.receive(.questionSnapshot(try snapshot(sessionID: fixture.sessionID, questionIDs: [nextQuestion.question.id])),
            from: fixture.child, generation: reconnectGeneration)
        let current = try #require(store.machine(withIdentifier: fixture.machineID)?.currentQuestionSnapshot(for: fixture.sessionID))
        #expect(current.endpointID == fixture.child.id)
        #expect(current.generation == reconnectGeneration)
        #expect(current.questionIDs == [nextQuestion.question.id])

        store.receive(.questionSnapshot(try snapshot(sessionID: fixture.sessionID, questionIDs: [firstQuestion.question.id])),
            from: fixture.child, generation: fixture.childGeneration)
        #expect(store.machine(withIdentifier: fixture.machineID)?.currentQuestionSnapshot(for: fixture.sessionID) == current)
    }

    @Test func connectionWithoutAttachStateFailsClosedEvenIfALiveSnapshotArrives() throws {
        let fixture = try fixture()
        defer { fixture.store.stop() }
        let store = fixture.store
        let question = try question(sessionID: fixture.sessionID, id: "live-question")

        store.receive(.connected(sessionId: nil), from: fixture.child, generation: fixture.childGeneration)
        store.receive(.hello(try hello(attachState: nil)), from: fixture.child, generation: fixture.childGeneration)
        store.receive(.question(question), from: fixture.child, generation: fixture.childGeneration)
        store.receive(.questionSnapshot(try snapshot(sessionID: fixture.sessionID, questionIDs: [question.question.id])),
            from: fixture.child, generation: fixture.childGeneration)

        #expect(store.machine(withIdentifier: fixture.machineID)?.currentQuestionSnapshot(for: fixture.sessionID) == nil)
        let update = RemiQuestionNotificationPolicy.update(
            state: .init(),
            currentQuestionIDsBySession: ["\(fixture.machineID)|\(fixture.sessionID)": [question.question.id]],
            snapshotsBySession: [:]
        )
        #expect(update.identitiesToPost.isEmpty)
        #expect(update.state.knownQuestionIDsBySession.isEmpty)
    }

    @Test func killingASessionClearsItsQuestionConnectionState() throws {
        let fixture = try fixture()
        defer { fixture.store.stop() }
        let store = fixture.store
        let question = try question(sessionID: fixture.sessionID, id: "question-to-kill")
        store.receive(.connected(sessionId: nil), from: fixture.child, generation: fixture.childGeneration)
        store.receive(.hello(try hello(attachState: "attached")), from: fixture.child, generation: fixture.childGeneration)
        store.receive(.question(question), from: fixture.child, generation: fixture.childGeneration)
        store.receive(.questionSnapshot(try snapshot(sessionID: fixture.sessionID, questionIDs: [question.question.id])),
            from: fixture.child, generation: fixture.childGeneration)
        #expect(store.machine(withIdentifier: fixture.machineID)?.currentQuestionSnapshot(for: fixture.sessionID) != nil)

        let key = store.sessionKey(machineID: fixture.machineID, sessionID: fixture.sessionID)
        store.sessionByKillRequest["kill-question-session"] = key
        var payload = try #require(
            JSONSerialization.jsonObject(with: FixtureConformanceTests.fixture("kill_session_response")) as? [String: Any]
        )
        payload["requestId"] = "kill-question-session"
        let response = try JSONDecoder().decode(
            KillSessionResponseMessage.self,
            from: JSONSerialization.data(withJSONObject: payload)
        )
        store.receive(.killSessionResponse(response), from: fixture.root, generation: fixture.rootGeneration)

        let machine = try #require(store.machine(withIdentifier: fixture.machineID))
        #expect(machine.questionConnectionSnapshots[fixture.sessionID] == nil)
        #expect(machine.questionConnectionGenerations[fixture.child.id] == nil)
        #expect(machine.currentQuestionSnapshot(for: fixture.sessionID) == nil)
    }

    private func fixture() throws -> Fixture {
        let root = MachineEndpoint(host: "192.0.2.20", port: 28002)
        let store = MachineStore(endpoints: [root], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        let rootGeneration = try #require(store.connectionGenerations[root])
        let authority = Data(repeating: 7, count: 32)
        store.ownedObserveParentHello(root, key: authority)
        store.receive(.connected(sessionId: nil), from: root, generation: rootGeneration)
        store.receive(.hello(try hello(attachState: nil, includesMachine: true), authorityPublicKey: Data(repeating: 7, count: 32)),
            from: root, generation: rootGeneration)
        store.receive(.sessions(try sessions(ports: [28003])), from: root, generation: rootGeneration)
        let child = try #require(store.connectionGenerations.keys.first { $0.port == 28003 })
        let childGeneration = try #require(store.connectionGenerations[child])
        return Fixture(
            store: store,
            root: root,
            rootGeneration: rootGeneration,
            child: child,
            childGeneration: childGeneration,
            machineID: try #require(store.machines.first?.id),
            sessionID: "fixture-session-id"
        )
    }

    private func hello(attachState: String?, includesMachine: Bool = false) throws -> HelloAckMessage {
        var fields: [String: Any] = ["type": "hello_ack", "serverVersion": "1.0.0"]
        if let attachState { fields["attachState"] = attachState }
        if includesMachine { fields["machine"] = try descriptor() }
        return try frame(fields)
    }

    private func sessions(ports: [Int]) throws -> SessionListResponse {
        try frame(["type": "session_list_response", "requestId": "question-list", "sessions": [],
                   "daemonPorts": ports, "machine": try descriptor()])
    }

    private func question(sessionID: String, id: String) throws -> QuestionMessage {
        var payload = try #require(
            JSONSerialization.jsonObject(with: FixtureConformanceTests.fixture("question")) as? [String: Any]
        )
        payload["sessionId"] = sessionID
        var question = try #require(payload["question"] as? [String: Any])
        question["id"] = id
        payload["question"] = question
        return try JSONDecoder().decode(QuestionMessage.self, from: JSONSerialization.data(withJSONObject: payload))
    }

    private func snapshot(sessionID: String, questionIDs: [String]) throws -> QuestionSnapshotMessage {
        try frame(["type": "question_snapshot", "sessionId": sessionID, "questionIds": questionIDs])
    }

    private func descriptor() throws -> [String: Any] {
        let key = Data(repeating: 7, count: 32)
        return ["id": try MachineIdentityVerifier.machineID(forPublicKey: key),
                "name": "Notification Test Machine", "platform": "darwin", "remiVersion": "0.8.0",
                "harnesses": ["claude"], "capabilities": []]
    }

    private func frame<T: Decodable>(_ fields: [String: Any]) throws -> T {
        var object = fields
        object["id"] = UUID().uuidString.lowercased()
        object["timestamp"] = "2026-11-14T12:00:00Z"
        return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }
}
