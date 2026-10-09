import Foundation
import Testing
@testable import RemiKit

@MainActor
struct RelayStoreTests {
    @Test func replacedConnectionsCannotPersistPairingOrChangeState() throws {
        let oracle = try RelayOracle.load()
        let negatives = try #require(oracle["negative"] as? [[String: Any]])
        let vector = try #require(negatives.first { $0["name"] as? String == "control: the genuine token" })
        let token = try RelayPairingToken(#require(vector["text"] as? String),
            now: #require(vector["nowSec"] as? NSNumber).uint64Value)
        let endpoint = MachineEndpoint(relayToken: token)
        let store = MachineStore(endpoints: [], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        defer { store.stop() }
        store.addMachine(endpoint)
        let publicEndpoint = try #require(store.machines.first?.endpoint)
        #expect(publicEndpoint.relayPairingSecret == nil)
        let first = try #require(store.connectionGenerations[publicEndpoint])
        store.addMachine(endpoint)
        let second = try #require(store.connectionGenerations[publicEndpoint])
        #expect(first != second)
        store.receive(.relayReady, from: publicEndpoint, generation: first)
        store.receive(.connected(sessionId: nil), from: publicEndpoint, generation: first)
        #expect(store.persistableEndpoints.isEmpty)
        #expect(store.machines.first?.status == .disconnected)
        store.receive(.awaitingRelayConfirmation(fingerprint: "current"), from: publicEndpoint, generation: second)
        #expect(store.machines.first?.status == .waitingForRelayConfirmation(fingerprint: "current"))
        store.receive(.relayReady, from: publicEndpoint, generation: second)
        #expect(store.persistableEndpoints == [publicEndpoint])
        store.stop()
        store.receive(.connected(sessionId: nil), from: publicEndpoint, generation: second)
        #expect(store.machines.first?.status == .waitingForRelayConfirmation(fingerprint: "current"))
    }

    @Test func relayResumeIsRefusedBeforeSending() throws {
        let oracle = try RelayOracle.load()
        let identities = try #require(oracle["identities"] as? [String: [String: Any]])
        let machine = try RelayOracle.bytes(#require(identities["machine"]), "publicKey")
        let pin = try RelayMachinePin(relayURL: "ws://127.0.0.1:1", machinePublicKey: RelayCrypto.b64(machine))
        let endpoint = MachineEndpoint(host: "127.0.0.1", port: 1, relayPin: pin)
        let store = MachineStore(endpoints: [endpoint], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.resumeSession(on: endpoint, sessionId: "stored-session")
        #expect(store.resumingSessions.isEmpty)
        #expect(store.latestOperationError?.contains("Resume is unavailable over the relay") == true)
        #expect(store.resumedSessionDestination == nil)
    }
}
