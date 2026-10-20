import Foundation
import Testing
@testable import RemiKit

#if DEBUG
@MainActor
struct ChildRouteOriginTests {
    // These synchronous tests deliver verified transport events to the real Store.
    // stop() retires generations before its queued connection tasks can start.
    @Test func discoveryUsesTheRespondingAddressAfterRouteConsolidation() throws {
        let (store, old, current, generation) = try consolidatedStore()
        defer { store.stop() }
        store.receive(.sessions(try sessions(ports: [28003])), from: current, generation: generation)

        #expect(store.ownedConnectionGenerations[MachineEndpoint(host: current.host, port: 28003)] != nil)
        #expect(store.ownedConnectionGenerations[MachineEndpoint(host: old.host, port: 28003)] == nil)
    }

    @Test func discoveryNeverRedialsItsOwnPortWithoutThePin() throws {
        let (store, _, current, generation) = try consolidatedStore()
        defer { store.stop() }
        store.receive(.sessions(try sessions(ports: [current.port])), from: current, generation: generation)

        #expect(store.ownedConnectionGenerations.count == 2)
    }

    @Test func relayDiscoveryCannotDialChildrenThroughTheDirectAnchor() throws {
        let key = Data(repeating: 7, count: 32)
        let pin = try RelayMachinePin(relayURL: "wss://relay.example.test", machinePublicKey: RelayCrypto.b64(key))
        let relay = MachineEndpoint(host: "relay.example.test", port: 443, relayPin: pin)
        let (store, _, _, generation) = try consolidatedStore(current: relay)
        defer { store.stop() }
        store.receive(.sessions(try sessions(ports: [28003])), from: relay, generation: generation)

        #expect(store.ownedConnectionGenerations.count == 2)
    }

    @Test func createResponseUsesTheRespondingAddress() throws {
        let (store, old, current, generation) = try consolidatedStore()
        defer { store.stop() }
        let response: CreateSessionResponseMessage = try frame([
            "type": "create_session_response", "requestId": "create", "success": true,
            "sessionId": "created", "port": 28004,
        ])
        store.receive(.createSessionResponse(response), from: current, generation: generation)

        #expect(store.ownedConnectionGenerations[MachineEndpoint(host: current.host, port: 28004)] != nil)
        #expect(store.ownedConnectionGenerations[MachineEndpoint(host: old.host, port: 28004)] == nil)
    }

    @Test func relayCreateResponseNeverDialsADirectChild() throws {
        let pin = try RelayMachinePin(relayURL: "wss://relay.example.test",
            machinePublicKey: RelayCrypto.b64(Data(repeating: 7, count: 32)))
        let relay = MachineEndpoint(host: "relay.example.test", port: 443, relayPin: pin)
        let (store, _, _, generation) = try consolidatedStore(current: relay)
        defer { store.stop() }
        let response: CreateSessionResponseMessage = try frame([
            "type": "create_session_response", "requestId": "create", "success": true,
            "sessionId": "created", "port": 28004,
        ])
        store.receive(.createSessionResponse(response), from: relay, generation: generation)

        #expect(store.ownedConnectionGenerations.count == 2)
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
        let oldGeneration = try #require(store.ownedConnectionGenerations[old])
        store.receive(.resumeSessionResponse(response), from: old, generation: oldGeneration)
        #expect(store.ownedConnectionGenerations.count == 2)
        store.receive(.resumeSessionResponse(response), from: current, generation: generation)

        #expect(store.ownedConnectionGenerations[MachineEndpoint(host: current.host, port: 28005)] != nil)
        #expect(store.ownedConnectionGenerations[MachineEndpoint(host: old.host, port: 28005)] == nil)
    }

    private func consolidatedStore(current: MachineEndpoint = MachineEndpoint(host: "192.0.2.20", port: 28002)) throws
        -> (MachineStore, MachineEndpoint, MachineEndpoint, UUID) {
        let old = MachineEndpoint(host: "192.0.2.10", port: 28000)
        let store = MachineStore(endpoints: [old], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        let first = try #require(store.ownedConnectionGenerations[old])
        store.receive(.hello(try hello()), from: old, generation: first)
        store.addMachine(current)
        let next = try #require(store.ownedConnectionGenerations[current])
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
