import Foundation
import Testing
@testable import RemiKit

#if DEBUG
@MainActor
struct ChildRouteOriginTests {
    // These synchronous tests supply fixtures at the real Store's post-verification boundary.
    // Transport authentication is tested separately.
    // stop() retires generations before its queued connection tasks can start.
    @Test func activeSessionChildDeliversTranscriptEvents() throws {
        let origin = MachineEndpoint(host: "192.0.2.20", port: 28002)
        let store = MachineStore(endpoints: [origin], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        defer { store.stop() }
        let generation = try #require(store.connectionGenerations[origin])
        store.receive(.hello(try hello()), from: origin, generation: generation)
        store.receive(.sessions(try sessions(ports: [28003])), from: origin, generation: generation)
        let child = try #require(store.connectionGenerations.keys.first { $0.port == 28003 })
        let childGeneration = try #require(store.connectionGenerations[child])
        #expect(store.ownedConnectionMachineIDs[child] == store.machines.first?.machineID)
        store.receive(.hello(try hello()), from: child, generation: childGeneration)
        let message = try JSONDecoder().decode(TranscriptContentMessage.self,
            from: FixtureConformanceTests.fixture("transcript_content"))
        store.receive(.transcript(message), from: child, generation: childGeneration)
        let question = try JSONDecoder().decode(QuestionMessage.self,
            from: FixtureConformanceTests.fixture("question"))
        store.receive(.question(question), from: child, generation: childGeneration)

        #expect(store.transcriptsBySession[store.sessionKey(machineID: store.machines[0].id, sessionID: message.sessionId)]?.count == 1)
        #expect(store.machines.first?.questions.count == 1)
    }

    @Test func oldRouteFailuresCannotReplaceTheActiveRouteStatus() throws {
        let (store, old, current, generation) = try consolidatedStore()
        defer { store.stop() }
        store.receive(.connected(sessionId: nil), from: current, generation: generation)
        let oldGeneration = try #require(store.connectionGenerations[old])
        store.receive(.reachabilityFailed(attempt: 3), from: old, generation: oldGeneration)
        #expect(store.machines.first?.status == .connected)
        store.receive(.rejected(reason: "Inactive route identity mismatch"), from: old, generation: oldGeneration)
        #expect(store.machines.first?.status == .connected)
    }

    @Test func sessionChildFailureDoesNotDeclareItsHubUnavailable() throws {
        let (store, _, current, generation) = try consolidatedStore()
        defer { store.stop() }
        store.receive(.connected(sessionId: nil), from: current, generation: generation)
        store.receive(.sessions(try sessions(ports: [28003])), from: current, generation: generation)
        let child = try #require(store.connectionGenerations.keys.first { $0.port == 28003 })
        let childGeneration = try #require(store.connectionGenerations[child])
        store.receive(.rejected(reason: "Session identity mismatch"), from: child, generation: childGeneration)
        #expect(store.machines.first?.status == .connected)
        #expect(store.latestOperationError?.contains("Session identity mismatch") == true)
        #expect(store.machines.first?.sessionConnectionIssue != nil)
        store.retryConnection(for: current)
        let retryGeneration = try #require(store.connectionGenerations[child])
        #expect(retryGeneration != childGeneration)
        #expect(store.machines.first?.sessionConnectionIssue == nil)
        #expect(store.ownedConnectionMachineIDs[child] == store.machines.first?.machineID)
        store.receive(.rejected(reason: "Retired child"), from: child, generation: childGeneration)
        #expect(store.latestOperationError?.contains("Retired child") != true)
    }

    @Test func childApprovalFailureHasAnExplicitRetryWithoutChangingHubTrust() throws {
        let (store, _, current, generation) = try consolidatedStore()
        defer { store.stop() }
        store.receive(.connected(sessionId: nil), from: current, generation: generation)
        store.receive(.sessions(try sessions(ports: [28003])), from: current, generation: generation)
        let child = MachineEndpoint(host: current.host, port: 28003)
        let first = try #require(store.connectionGenerations[child])
        store.receive(.awaitingLocalApproval(fingerprint: "1234567890abcdef"), from: child, generation: first)
        #expect(store.machines.first?.status == .connected)
        #expect(store.machines.first?.sessionConnectionIssue?.contains("1234567890abcdef") == true)
        store.retryConnection(for: current)
        #expect(store.connectionGenerations[child] != first)
        #expect(store.ownedConnectionMachineIDs[child] == store.machines.first?.machineID)
    }

    @Test func oldRouteChildrenCannotDeliverAfterANewRouteBecomesActive() throws {
        let old = MachineEndpoint(host: "192.0.2.10", port: 28000)
        let current = MachineEndpoint(host: "192.0.2.20", port: 28002)
        let store = MachineStore(endpoints: [old], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        defer { store.stop() }
        let first = try #require(store.connectionGenerations[old])
        store.receive(.hello(try hello()), from: old, generation: first)
        store.receive(.sessions(try sessions(ports: [28003])), from: old, generation: first)
        let child = try #require(store.connectionGenerations.keys.first { $0.port == 28003 })
        let childGeneration = try #require(store.connectionGenerations[child])
        store.addMachine(current)
        let next = try #require(store.connectionGenerations[current])
        store.receive(.hello(try hello()), from: current, generation: next)
        let message = try JSONDecoder().decode(TranscriptContentMessage.self,
            from: FixtureConformanceTests.fixture("transcript_content"))
        store.receive(.transcript(message), from: child, generation: childGeneration)

        #expect(store.transcriptsBySession[store.sessionKey(machineID: store.machines[0].id, sessionID: message.sessionId)] == nil)
    }

    @Test func suspensionDoesNotPresentRetiredSocketsAsConnected() throws {
        let origin = MachineEndpoint(host: "192.0.2.20", port: 28002)
        let store = MachineStore(endpoints: [origin], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        let generation = try #require(store.connectionGenerations[origin])
        store.receive(.connected(sessionId: nil), from: origin, generation: generation)
        #expect(store.machines.first?.status == .connected)
        store.suspendForegroundConnections()

        #expect(store.machines.first?.status == .disconnected)
        #expect(store.persistableEndpoints == [origin])
    }

    @Test func discoveryUsesTheRespondingAddressAfterRouteConsolidation() throws {
        let (store, old, current, generation) = try consolidatedStore()
        defer { store.stop() }
        store.receive(.sessions(try sessions(ports: [28003])), from: current, generation: generation)

        #expect(store.connectionGenerations[MachineEndpoint(host: current.host, port: 28003)] != nil)
        #expect(store.connectionGenerations[MachineEndpoint(host: old.host, port: 28003)] == nil)
    }

    @Test func discoveryNeverRedialsItsOwnPortWithoutThePin() throws {
        let (store, _, current, generation) = try consolidatedStore()
        defer { store.stop() }
        store.receive(.sessions(try sessions(ports: [current.port])), from: current, generation: generation)

        #expect(store.connectionGenerations.count == 2)
    }

    @Test func relayDiscoveryCannotDialChildrenThroughTheDirectAnchor() throws {
        let key = Data(repeating: 7, count: 32)
        let pin = try RelayMachinePin(relayURL: "wss://relay.example.test", machinePublicKey: RelayCrypto.b64(key))
        let relay = MachineEndpoint(host: "relay.example.test", port: 443, relayPin: pin)
        let (store, generation) = try activeRelayStore(relay)
        defer { store.stop() }
        store.receive(.sessions(try sessions(ports: [28003])), from: relay, generation: generation)

        #expect(store.machines.first?.endpoint.id == relay.id)
        #expect(store.connectionGenerations.count == 1)
        #expect(!store.connectionGenerations.keys.contains { $0.relayPin == nil && $0.port == 28003 })
    }

    @Test func inactiveRelayHelloCannotReplaceDirectCapabilities() throws {
        let pin = try RelayMachinePin(relayURL: "wss://relay.example.test",
            machinePublicKey: RelayCrypto.b64(Data(repeating: 7, count: 32)))
        let relay = MachineEndpoint(host: "relay.example.test", port: 443, relayPin: pin)
        let (store, old, _, generation) = try consolidatedStore(current: relay)
        defer { store.stop() }
        let acknowledgment: HelloAckMessage = try frame([
            "type": "hello_ack", "serverVersion": "1.0.0", "machine": descriptor,
            "capabilities": ["relay-only"], "harnesses": ["codex"],
        ])
        store.receive(.hello(acknowledgment), from: relay, generation: generation)

        #expect(store.machines.first?.endpoint == old)
        #expect(store.machines.first?.capabilities == [])
        #expect(store.machines.first?.harnesses == ["claude"])
    }

    @Test func createResponseUsesTheRespondingAddress() throws {
        let (store, old, current, generation) = try consolidatedStore()
        defer { store.stop() }
        let response: CreateSessionResponseMessage = try frame([
            "type": "create_session_response", "requestId": "create", "success": true,
            "sessionId": "created", "port": 28004,
        ])
        store.receive(.createSessionResponse(response), from: current, generation: generation)

        #expect(store.connectionGenerations[MachineEndpoint(host: current.host, port: 28004)] != nil)
        #expect(store.connectionGenerations[MachineEndpoint(host: old.host, port: 28004)] == nil)
    }

    @Test func relayCreateResponseNeverDialsADirectChild() throws {
        let pin = try RelayMachinePin(relayURL: "wss://relay.example.test",
            machinePublicKey: RelayCrypto.b64(Data(repeating: 7, count: 32)))
        let relay = MachineEndpoint(host: "relay.example.test", port: 443, relayPin: pin)
        let (store, generation) = try activeRelayStore(relay)
        defer { store.stop() }
        let response: CreateSessionResponseMessage = try frame([
            "type": "create_session_response", "requestId": "create", "success": true,
            "sessionId": "created", "port": 28004,
        ])
        store.receive(.createSessionResponse(response), from: relay, generation: generation)

        #expect(store.machines.first?.endpoint.id == relay.id)
        #expect(store.connectionGenerations.count == 1)
        #expect(!store.connectionGenerations.keys.contains { $0.relayPin == nil && $0.port == 28004 })
    }

    @Test func resumeResponseKeepsExactCorrelationAndUsesTheRespondingAddress() throws {
        let (store, old, current, generation) = try consolidatedStore()
        defer { store.stop() }
        store.resumeSession(on: current, sessionId: "stored")
        let requestID = try #require(store.ownedResumeRequestIDs.first)
        let response: ResumeSessionResponseMessage = try frame([
            "type": "resume_session_response", "requestId": requestID, "success": true,
            "sessionId": "resumed", "port": 28005,
        ])
        let oldGeneration = try #require(store.connectionGenerations[old])
        store.receive(.resumeSessionResponse(response), from: old, generation: oldGeneration)
        #expect(store.connectionGenerations.count == 2)
        store.receive(.resumeSessionResponse(response), from: current, generation: generation)

        #expect(store.connectionGenerations[MachineEndpoint(host: current.host, port: 28005)] != nil)
        #expect(store.connectionGenerations[MachineEndpoint(host: old.host, port: 28005)] == nil)
    }

    private func activeRelayStore(_ relay: MachineEndpoint) throws -> (MachineStore, UUID) {
        let key = Data(repeating: 7, count: 32)
        let local = MachineEndpoint(host: "192.0.2.10", port: 28000)
        let profile = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
            routes: [local, relay], connectionPreference: .relayOnly, machinePublicKey: RelayCrypto.b64(key))
        let store = MachineStore(profiles: [profile], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        let generation = try #require(store.connectionGenerations[relay])
        store.receive(.hello(try hello(), authorityPublicKey: key), from: relay, generation: generation)
        return (store, generation)
    }

    private func consolidatedStore(current: MachineEndpoint = MachineEndpoint(host: "192.0.2.20", port: 28002)) throws
        -> (MachineStore, MachineEndpoint, MachineEndpoint, UUID) {
        let old = MachineEndpoint(host: "192.0.2.10", port: 28000)
        let store = MachineStore(endpoints: [old], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        let first = try #require(store.connectionGenerations[old])
        store.receive(.hello(try hello()), from: old, generation: first)
        store.addMachine(current)
        let next = try #require(store.connectionGenerations[current])
        store.receive(.hello(try hello()), from: current, generation: next)
        #expect(store.machines.count == 1)
        #expect(store.machines.first?.routes.first == old)
        return (store, old, current, next)
    }

    private var descriptor: [String: Any] {
        get throws {
            ["id": try MachineIdentityVerifier.machineID(forPublicKey: Data(repeating: 7, count: 32)),
             "name": "Unit Mac", "platform": "darwin", "remiVersion": "0.8.0", "harnesses": ["claude"], "capabilities": []]
        }
    }

    private func hello() throws -> HelloAckMessage {
        try frame(["type": "hello_ack", "serverVersion": "1.0.0", "machine": descriptor])
    }

    private func sessions(ports: [Int]) throws -> SessionListResponse {
        try frame(["type": "session_list_response", "requestId": "list", "sessions": [],
                   "daemonPorts": ports, "machine": descriptor])
    }

    private func frame<T: Decodable>(_ fields: [String: Any]) throws -> T {
        var object = fields
        object["id"] = UUID().uuidString
        object["timestamp"] = "2026-10-20T06:00:00Z"
        return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }
}
#endif
