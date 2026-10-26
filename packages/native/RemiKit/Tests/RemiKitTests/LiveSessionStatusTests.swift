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
