import Foundation
import RemiUI
import Testing
@testable import RemiKit

@MainActor
struct LiveSessionStatusTests {
    @Test func liveUpdatesChangeActivityWithoutAnotherSessionList() throws {
        let endpoint = MachineEndpoint(host: "192.0.2.20", port: 28002)
        let store = MachineStore(endpoints: [endpoint], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        defer { store.stop() }
        let generation = try #require(store.connectionGenerations[endpoint])
        let list = try JSONDecoder().decode(SessionListResponse.self,
            from: FixtureConformanceTests.fixture("session_list_response"))
        let update = try JSONDecoder().decode(SessionUpdateMessage.self,
            from: FixtureConformanceTests.fixture("session_update"))
        store.receive(.sessions(list), from: endpoint, generation: generation)
        store.receive(.sessionUpdate(update), from: endpoint, generation: generation)
        // Discovery remains metadata; the activity badge follows the event immediately.
        #expect(store.machines[0].activityStatus(for: list.sessions[0]) == "thinking")
        store.receive(.sessions(list), from: endpoint, generation: generation)
        #expect(store.machines[0].activityStatus(for: list.sessions[0]) == "thinking")

        let snapshot = try JSONDecoder().decode(RemiStatusMessage.self,
            from: FixtureConformanceTests.fixture("remi_status"))
        store.receive(.remiStatus(snapshot), from: endpoint, generation: generation)
        #expect(store.machines[0].activityStatus(for: list.sessions[0]) == "idle")

        store.receive(.sessionUpdate(update), from: endpoint, generation: UUID())
        #expect(store.machines[0].activityStatus(for: list.sessions[0]) == "idle")
        store.receive(.sessionUpdate(update), from: endpoint, generation: generation)
        store.receive(.stopped, from: endpoint, generation: generation)
        #expect(store.machines[0].sessionActivity.isEmpty)
    }

    @Test func identicalSessionIDsOnTwoMachinesDoNotShareActivity() throws {
        let first = MachineEndpoint(host: "192.0.2.20", port: 28002)
        let second = MachineEndpoint(host: "192.0.2.21", port: 28002)
        let store = MachineStore(endpoints: [first, second], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        defer { store.stop() }
        let list = try JSONDecoder().decode(SessionListResponse.self,
            from: FixtureConformanceTests.fixture("session_list_response"))
        let update = try JSONDecoder().decode(SessionUpdateMessage.self,
            from: FixtureConformanceTests.fixture("session_update"))
        for endpoint in [first, second] {
            store.receive(.sessions(list), from: endpoint,
                generation: try #require(store.connectionGenerations[endpoint]))
        }
        store.receive(.sessionUpdate(update), from: first,
            generation: try #require(store.connectionGenerations[first]))
        #expect(store.machines[0].activityStatus(for: list.sessions[0]) == "thinking")
        #expect(store.machines[1].activityStatus(for: list.sessions[0]) == "active")
        store.suspendForegroundConnections()
        #expect(store.machines.allSatisfy { $0.sessionActivity.isEmpty })
    }

    @Test func selectedHistoryGetsANewLoadIdentityWhenItsSocketRecovers() throws {
        let endpoint = MachineEndpoint(host: "192.0.2.20", port: 28002)
        let store = MachineStore(endpoints: [endpoint], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        let list = try JSONDecoder().decode(SessionListResponse.self,
            from: FixtureConformanceTests.fixture("session_list_response"))
        let session = list.sessions[0].sessionId
        store.start()
        defer { store.stop() }
        let generation = try #require(store.connectionGenerations[endpoint])
        #expect(store.loadTranscript(machineID: endpoint.id, sessionId: session) == nil)
        #expect(store.transcriptRouteGeneration(machineID: endpoint.id, sessionID: session) == nil)
        store.receive(.sessions(list), from: endpoint, generation: generation)
        #expect(store.transcriptRouteGeneration(machineID: endpoint.id, sessionID: session) == generation)
        store.receive(.sessions(list), from: endpoint, generation: generation)
        #expect(store.transcriptRouteGeneration(machineID: endpoint.id, sessionID: session) == generation)
        store.suspendForegroundConnections()
        #expect(store.transcriptRouteGeneration(machineID: endpoint.id, sessionID: session) == nil)
        store.start()
        let recovered = try #require(store.connectionGenerations[endpoint])
        store.receive(.sessions(list), from: endpoint, generation: recovered)
        #expect(recovered != generation)
        #expect(store.transcriptRouteGeneration(machineID: endpoint.id, sessionID: session) == recovered)
    }

    @Test func lostChildCannotReviveStaleWorkingWhileItsHubStaysConnected() throws {
        let endpoint = MachineEndpoint(host: "192.0.2.20", port: 28002)
        let store = MachineStore(endpoints: [endpoint], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        defer { store.stop() }
        let generation = try #require(store.connectionGenerations[endpoint])
        let list = try JSONDecoder().decode(SessionListResponse.self,
            from: FixtureConformanceTests.fixture("session_list_response"))
        store.receive(.connected(sessionId: nil), from: endpoint, generation: generation)
        store.receive(.sessions(list), from: endpoint, generation: generation)
        let child = try #require(store.connectionGenerations.keys.first { $0.port == 19924 })
        let childGeneration = try #require(store.connectionGenerations[child])
        store.receive(.sessions(list), from: child, generation: childGeneration)
        let idle = try JSONDecoder().decode(RemiStatusMessage.self,
            from: FixtureConformanceTests.fixture("remi_status"))
        store.receive(.remiStatus(idle), from: child, generation: childGeneration)
        store.receive(.reachabilityFailed(attempt: 1), from: child, generation: childGeneration)
        #expect(store.machines[0].status == .connected)
        #expect(store.machines[0].activityStatus(for: list.sessions[0]) == "idle")
        #expect(store.transcriptRouteGeneration(machineID: endpoint.id, sessionID: idle.sessionId) == nil)
    }

    @Test func siblingCensusesKeepAReadyStoredTranscriptReader() throws {
        let endpoint = MachineEndpoint(host: "192.0.2.20", port: 28002)
        let store = MachineStore(endpoints: [endpoint], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        defer { store.stop() }
        let generation = try #require(store.connectionGenerations[endpoint])
        // Project the shared discovery fixture to its on-disk form.
        var payload = try #require(JSONSerialization.jsonObject(
            with: FixtureConformanceTests.fixture("session_list_response")) as? [String: Any])
        var sessions = try #require(payload["sessions"] as? [[String: Any]])
        sessions[0]["source"] = "transcript"
        sessions[0]["canResume"] = true
        payload["sessions"] = sessions
        let list = try JSONDecoder().decode(SessionListResponse.self,
            from: JSONSerialization.data(withJSONObject: payload))
        let session = list.sessions[0].sessionId
        store.receive(.sessions(list), from: endpoint, generation: generation)
        let child = try #require(store.connectionGenerations.keys.first { $0.port == 19924 })
        let childGeneration = try #require(store.connectionGenerations[child])
        store.receive(.sessions(list), from: child, generation: childGeneration)
        #expect(store.transcriptRouteGeneration(machineID: endpoint.id, sessionID: session) == generation)
        store.receive(.stopped, from: endpoint, generation: generation)
        store.receive(.sessions(list), from: child, generation: childGeneration)
        #expect(store.transcriptRouteGeneration(machineID: endpoint.id, sessionID: session) == childGeneration)
    }

    @Test(arguments: ["thinking", "executing", "working", "active", "evaluating", "approved", "idle", "waiting", "starting"])
    func activityVocabularyIsSharedByBothApps(_ status: String) {
        let mapped = RemiSessionStatus(activityStatus: status)
        switch status {
        case "thinking", "executing", "working", "active", "evaluating", "approved": #expect(mapped == .working)
        case "waiting": #expect(mapped == .needsYou)
        case "starting": #expect(mapped == .connecting)
        default: #expect(mapped == .idle)
        }
    }
}
