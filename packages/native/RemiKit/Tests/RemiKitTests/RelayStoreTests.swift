import Foundation
import RemiPush
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
        #expect(store.machines.first?.status == .disconnected)
        store.receive(.connected(sessionId: nil), from: publicEndpoint, generation: second)
        #expect(store.machines.first?.status == .disconnected)
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

    @Test func refreshingAnEnrolledRelayKeepsItsSavedRouteBeforeReadyAndAfterFailure() throws {
        let oracle = try RelayOracle.load()
        let negatives = try #require(oracle["negative"] as? [[String: Any]])
        let vector = try #require(negatives.first { $0["name"] as? String == "control: the genuine token" })
        let token = try RelayPairingToken(#require(vector["text"] as? String),
            now: #require(vector["nowSec"] as? NSNumber).uint64Value)
        let fresh = MachineEndpoint(relayToken: token)
        let endpoint = fresh.publicConfiguration
        let key = try RelayCrypto.unb64(token.pin.machinePublicKey)
        let room = RelayCrypto.room(key)
        let identity = ClientIdentity()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-x2-route-refresh-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let push = try RemiPushStore.ownedTestStore(file: directory.appendingPathComponent("public.sqlite"),
            service: "live.yooz.remi.tests.route-refresh", account: UUID().uuidString)
        let authority = PushDeviceAuthority(publicKey: identity.publicKeyRaw, revision: UUID().uuidString, requiresAppUnlock: false)
        let authorityGeneration: Int64
        do {
            let lease = try push.acquireIdentityMutation()
            defer { lease.release() }
            authorityGeneration = try lease.invalidate()
            try lease.install(authority, generation: authorityGeneration)
        }
        var origin = try #require(URLComponents(string: token.pin.relayURL))
        origin.scheme = "https"; origin.path = ""
        try push.commitMachine(room: room, machinePublicKey: key, origin: try #require(origin.string),
            relayURL: token.pin.relayURL, authority: authority, generation: authorityGeneration)
        let originalTrust = try #require(try push.machine(room: room))
        let profile = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
            routes: [endpoint], connectionPreference: .relayOnly, machinePublicKey: RelayCrypto.b64(key))
        let store = MachineStore(profiles: [profile], identity: identity, clientVersion: "test", clientId: "test", pushStore: push)
        defer { store.stop() }
        let defaultsKey = "remi.route-refresh.\(UUID())"
        defer { UserDefaults.standard.removeObject(forKey: defaultsKey) }
        let configuration = MachineConfigurationStore(key: defaultsKey)
        store.addMachine(fresh)
        configuration.saveProfiles(store.persistableProfiles)
        #expect(configuration.loadProfiles().first?.routes.map(\.id) == [endpoint.id])
        #expect(try push.machine(room: room) == originalTrust)
        let generation = try #require(store.connectionGenerations[endpoint])
        store.receive(.rejected(reason: "Owned refused refresh"), from: endpoint, generation: generation)
        configuration.saveProfiles(store.persistableProfiles)
        #expect(configuration.loadProfiles().first?.routes.map(\.id) == [endpoint.id])
        #expect(configuration.loadProfiles().first?.connectionPreference == .relayOnly)
        #expect(try push.machine(room: room) == originalTrust)
    }
}
