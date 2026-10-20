import CryptoKit
import Foundation
import Testing
@testable import RemiKit

@MainActor
struct MachineConnectionPreferenceTests {
    private func profile(_ preference: MachineConnectionPreference) throws -> MachineRouteProfile {
        let key = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let encoded = RelayCrypto.b64(key)
        let pin = try RelayMachinePin(relayURL: "wss://relay.example.test", machinePublicKey: encoded)
        return MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key), routes: [
            MachineEndpoint(host: "192.0.2.10", port: 28000),
            MachineEndpoint(host: "100.64.0.10", port: 28000),
            MachineEndpoint(host: "relay.example.test", port: 443, relayPin: pin),
        ], connectionPreference: preference, machinePublicKey: encoded)
    }

    @Test(arguments: MachineConnectionPreference.allCases)
    func persistedPolicyRestrictsActualStoreConnectionCreation(_ preference: MachineConnectionPreference) throws {
        let configurationKey = "remi.route-policy.all-modes.\(UUID())"
        defer { UserDefaults.standard.removeObject(forKey: configurationKey) }
        let configuration = MachineConfigurationStore(key: configurationKey)
        configuration.saveProfiles([try profile(preference)])
        let stored = try #require(try configuration.loadProfilesValidated().first)
        let store = MachineStore(profiles: [stored], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        defer { store.stop() }
        let layers = Set(store.connectionGenerations.keys.map(\.connectionLayer))
        switch preference {
        case .automatic: #expect(layers == [.local])
        case .localOnly: #expect(layers == [.local])
        case .tailscaleOnly: #expect(layers == [.tailscale])
        case .relayOnly: #expect(layers == [.relay])
        }
        #expect(store.persistableProfiles.first?.connectionPreference == preference)
    }

    @Test func preferenceAndFullMachinePinSurviveRealConfigurationSaveAndReload() throws {
        let key = "remi.route-policy.test.\(UUID().uuidString)"
        defer { UserDefaults.standard.removeObject(forKey: key) }
        let configuration = MachineConfigurationStore(key: key)
        var stored = try profile(.tailscaleOnly)
        stored.routes.removeAll { $0.relayPin != nil }
        configuration.saveProfiles([stored])
        let loaded = configuration.loadProfiles()
        #expect(loaded == [stored])
        let store = MachineStore(profiles: loaded, identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        #expect(store.machines.count == 1)
        #expect(store.machines.first?.routes.count == 2)
        #expect(store.machines.first?.endpoint.connectionLayer == .tailscale)
        #expect(store.persistableProfiles.first?.machinePublicKey == stored.machinePublicKey)
    }

    @Test func olderProfileDefaultsToAutomatic() throws {
        let data = Data(#"{"routes":[{"host":"127.0.0.1","port":18765}]}"#.utf8)
        #expect(try JSONDecoder().decode(MachineRouteProfile.self, from: data).connectionPreference == .automatic)
    }

    @Test func missingLockedLayerDoesNotStartAnotherLayer() {
        let endpoint = MachineEndpoint(host: "192.0.2.10", port: 28000)
        let store = MachineStore(profiles: [MachineRouteProfile(machineID: nil, routes: [endpoint], connectionPreference: .tailscaleOnly)],
            identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        defer { store.stop() }
        #expect(store.connectionGenerations.isEmpty)
        guard case .unavailable(let reason) = store.machines.first?.status else {
            Issue.record("Missing Tailscale route must be unavailable"); return
        }
        #expect(reason?.contains("Tailscale only") == true)
    }

    @Test func changingPolicyRetiresDisallowedGenerationsBeforeAnyLateEvent() throws {
        let store = MachineStore(profiles: [try profile(.automatic)], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        defer { store.stop() }
        let local = try #require(store.connectionGenerations.keys.first { $0.connectionLayer == .local })
        let retired = try #require(store.connectionGenerations[local])
        store.setConnectionPreference(.tailscaleOnly, for: local)
        #expect(Set(store.connectionGenerations.keys.map(\.connectionLayer)) == [.tailscale])
        store.receive(.rejected(reason: "Retired Local route"), from: local, generation: retired)
        #expect(store.machines.first?.status != .unavailable(reason: "Retired Local route"))
        #expect(store.persistableProfiles.first?.connectionPreference == .tailscaleOnly)
    }

    @Test func automaticExhaustsDirectRoutesBeforeStartingRelayAndAuthRejectionNeverDoes() throws {
        let stored = try profile(.automatic)
        let store = MachineStore(profiles: [stored], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        defer { store.stop() }
        let local = try #require(store.connectionGenerations.keys.first { $0.connectionLayer == .local })
        store.receive(.reachabilityFailed(attempt: 1), from: local, generation: try #require(store.connectionGenerations[local]))
        let tail = try #require(store.connectionGenerations.keys.first { $0.connectionLayer == .tailscale })
        #expect(store.machines.first?.endpoint.connectionLayer == .tailscale)
        #expect(!store.connectionGenerations.keys.contains { $0.connectionLayer == .relay })
        store.receive(.reachabilityFailed(attempt: 1), from: tail, generation: try #require(store.connectionGenerations[tail]))
        #expect(store.connectionGenerations.keys.contains { $0.connectionLayer == .relay })

        let rejected = MachineStore(profiles: [stored], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        rejected.start()
        defer { rejected.stop() }
        let origin = try #require(rejected.connectionGenerations.keys.first { $0.connectionLayer == .local })
        rejected.receive(.rejected(reason: "Identity mismatch"), from: origin, generation: try #require(rejected.connectionGenerations[origin]))
        #expect(rejected.connectionGenerations.isEmpty)
        #expect(rejected.machines.first?.status == .unavailable(reason: "Identity mismatch"))
    }

    @Test func tailscaleAddressRecognitionDoesNotMatchDNSLookalikes() {
        #expect(MachineEndpoint(host: "100.64.0.1", port: 1).connectionLayer == .tailscale)
        #expect(MachineEndpoint(host: "100.127.255.254", port: 1).connectionLayer == .tailscale)
        #expect(MachineEndpoint(host: "100.64.0.1.example", port: 1).connectionLayer == .local)
        #expect(MachineEndpoint(host: "100.128.0.1", port: 1).connectionLayer == .local)
        #expect(MachineEndpoint(host: "build.example.ts.net", port: 1).connectionLayer == .tailscale)
    }

    @Test func lockedDirectPolicyAlsoRefusesRelayActionsAndStalePolicySnapshotsCannotUnlockIt() throws {
        let stored = try profile(.tailscaleOnly)
        let store = MachineStore(profiles: [stored], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        let relay = try #require(stored.routes.first { $0.relayPin != nil })
        let room = try RelayCrypto.room(RelayCrypto.unb64(try #require(stored.machinePublicKey)))
        #expect(!MachineConnectionPolicyFence.shared.permitsRelay(room: room))
        var old = stored
        old.connectionPreference = .automatic
        MachineConnectionPolicyFence.shared.seed([old])
        #expect(!MachineConnectionPolicyFence.shared.permitsRelay(room: room))
        store.setConnectionPreference(.relayOnly, for: relay)
        #expect(MachineConnectionPolicyFence.shared.permitsRelay(room: room))
    }

    @Test func malformedSavedPolicyCannotBeReadAsAutomaticForColdActions() {
        let key = "remi.route-policy.invalid.\(UUID().uuidString)"
        defer { UserDefaults.standard.removeObject(forKey: key) }
        UserDefaults.standard.set(Data(#"[{"routes":[{"host":"127.0.0.1","port":1}],"connectionPreference":"invalid"}]"#.utf8), forKey: key)
        #expect(throws: MachineConfigurationStore.ReadError.self) {
            try MachineConfigurationStore(key: key).loadProfilesValidated()
        }
    }

    @Test func addingAReachableRoutePreservesTheExistingLockAndPinnedProfile() throws {
        let full = try profile(.tailscaleOnly)
        let local = try #require(full.routes.first { $0.connectionLayer == .local })
        let tail = try #require(full.routes.first { $0.connectionLayer == .tailscale })
        let saved = MachineRouteProfile(machineID: full.machineID, routes: [local],
            connectionPreference: .tailscaleOnly, machinePublicKey: full.machinePublicKey)
        let store = MachineStore(profiles: [saved], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        defer { store.stop() }
        #expect(store.connectionGenerations.isEmpty)
        store.addMachine(tail)
        let generation = try #require(store.connectionGenerations[tail])
        let payload: [String: Any] = ["type": "hello_ack", "id": "hello", "timestamp": "2026-10-20T00:00:00Z",
            "serverVersion": "1.0.0", "machine": ["id": try #require(full.machineID), "name": "Test Mac",
            "platform": "darwin", "remiVersion": "0.8.0", "harnesses": ["claude"], "capabilities": []]]
        let hello = try JSONDecoder().decode(HelloAckMessage.self, from: JSONSerialization.data(withJSONObject: payload))
        store.receive(.hello(hello, authorityPublicKey: try RelayCrypto.unb64(try #require(full.machinePublicKey))),
            from: tail, generation: generation)
        #expect(store.machines.count == 1)
        #expect(store.machines.first?.connectionPreference == .tailscaleOnly)
        #expect(store.machines.first?.endpoint.id == tail.id)
        #expect(store.machines.first?.status == .connected)
        #expect(store.connectionGenerations.keys.allSatisfy { $0.connectionLayer == .tailscale })
    }

    @Test(arguments: MachineConnectionPreference.allCases)
    func rePairingTheSameEndpointPreservesItsPolicyAndOtherRoutes(_ preference: MachineConnectionPreference) throws {
        let saved = try profile(preference)
        let store = MachineStore(profiles: [saved], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        let local = try #require(saved.routes.first { $0.relayPin == nil })
        let key = try RelayCrypto.unb64(try #require(saved.machinePublicKey))
        store.addMachine(MachineEndpoint(host: local.host, port: local.port,
            expectedPublicKey: key.base64EncodedString(), pairingNonce: "owned-memory-only"))
        defer { store.stop() }
        #expect(store.machines.count == 1)
        #expect(store.machines.first?.routes.count == 3)
        #expect(store.machines.first?.connectionPreference == preference)
        #expect(store.persistableProfiles.first?.machinePublicKey == saved.machinePublicKey)
        #expect(store.connectionGenerations.keys.allSatisfy { preference.permits($0) })
        let persisted = try JSONEncoder().encode(store.persistableProfiles)
        #expect(!String(decoding: persisted, as: UTF8.self).contains("owned-memory-only"))
    }

    @Test(arguments: ["malformed", "mismatched-id", "conflicting-relay"])
    func invalidSavedTrustNeverBecomesAnUnpinnedConnection(_ variant: String) throws {
        var saved = try profile(.automatic)
        if variant == "malformed" { saved.machinePublicKey = "invalid" }
        if variant == "mismatched-id" {
            saved = MachineRouteProfile(machineID: String(repeating: "0", count: 32), routes: saved.routes,
                machinePublicKey: saved.machinePublicKey)
        }
        if variant == "conflicting-relay" {
            saved.machinePublicKey = RelayCrypto.b64(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation)
        }
        let store = MachineStore(profiles: [saved], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        defer { store.stop() }
        #expect(store.connectionGenerations.isEmpty)
        #expect(store.persistableProfiles.first?.machinePublicKey == saved.machinePublicKey)
        guard case .unavailable = store.machines.first?.status else {
            Issue.record("Invalid saved trust must stay unavailable"); return
        }
        let defaultsKey = "remi.route-policy.corrupt.\(UUID())"
        defer { UserDefaults.standard.removeObject(forKey: defaultsKey) }
        let configuration = MachineConfigurationStore(key: defaultsKey)
        configuration.saveProfiles([saved])
        #expect(throws: MachineConfigurationStore.ReadError.self) { try configuration.loadProfilesValidated() }
    }

    @Test func choosingALockBeforeFirstHelloPublishesItWhenTheIdentityArrives() throws {
        let endpoint = MachineEndpoint(host: "100.64.0.15", port: 28000)
        let store = MachineStore(endpoints: [endpoint], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.setConnectionPreference(.tailscaleOnly, for: endpoint)
        store.start()
        defer { store.stop() }
        let key = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let generation = try #require(store.connectionGenerations[endpoint])
        store.receive(.hello(try hello(key), authorityPublicKey: key), from: endpoint, generation: generation)
        #expect(!MachineConnectionPolicyFence.shared.permitsRelay(room: RelayCrypto.room(key)))
    }

    @Test func explicitPolicyAndForgetOutliveStaleStoresAndColdSnapshots() throws {
        let saved = try profile(.localOnly)
        let store = MachineStore(profiles: [saved], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        let stale = MachineStore(profiles: [saved], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        let local = try #require(saved.routes.first { $0.connectionLayer == .local })
        let key = try RelayCrypto.unb64(try #require(saved.machinePublicKey))
        let room = RelayCrypto.room(key)
        store.setConnectionPreference(.relayOnly, for: local)
        stale.start()
        defer { store.stop(); stale.stop() }
        let staleRoute = try #require(stale.connectionGenerations.keys.first)
        let staleGeneration = try #require(stale.connectionGenerations[staleRoute])
        stale.receive(.hello(try hello(key), authorityPublicKey: key), from: staleRoute, generation: staleGeneration)
        #expect(MachineConnectionPolicyFence.shared.permitsRelay(room: room))
        store.setConnectionPreference(.tailscaleOnly, for: local)
        #expect(!MachineConnectionPolicyFence.shared.permitsRelay(room: room))
        #expect(store.removeMachine(local))
        MachineConnectionPolicyFence.shared.seed([saved])
        var fresh = saved
        fresh.connectionPreference = .automatic
        let replacement = MachineStore(profiles: [fresh], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        defer { replacement.stop() }
        stale.receive(.hello(try hello(key), authorityPublicKey: key), from: staleRoute, generation: staleGeneration)
        #expect(MachineConnectionPolicyFence.shared.permitsRelay(room: room))
    }

    @Test(arguments: [false, true])
    func inactiveAuthenticationFailureCannotBecomeAnInfiniteConnectingRoute(_ approval: Bool) throws {
        let saved = try profile(.automatic)
        let localAddress = try #require(saved.routes.first { $0.connectionLayer == .local })
        let tail = try #require(saved.routes.first { $0.connectionLayer == .tailscale })
        let key = try RelayCrypto.unb64(try #require(saved.machinePublicKey))
        let store = MachineStore(endpoints: [localAddress], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        defer { store.stop() }
        let local = try #require(store.connectionGenerations.keys.first { $0.connectionLayer == .local })
        store.receive(.hello(try hello(key), authorityPublicKey: key), from: local,
            generation: try #require(store.connectionGenerations[local]))
        store.addMachine(tail)
        store.receive(.hello(try hello(key), authorityPublicKey: key), from: tail,
            generation: try #require(store.connectionGenerations[tail]))
        #expect(store.machines.first?.endpoint.id == local.id)
        store.receive(approval ? .awaitingLocalApproval(fingerprint: "owned-client") : .rejected(reason: "Wrong machine"),
            from: tail, generation: try #require(store.connectionGenerations[tail]))
        store.receive(.reachabilityFailed(attempt: 1), from: local, generation: try #require(store.connectionGenerations[local]))
        #expect(store.machines.first?.status == (approval ? .waitingForApproval(fingerprint: "owned-client") : .unavailable(reason: "Wrong machine")))
        #expect(!store.connectionGenerations.keys.contains { $0.connectionLayer == .relay })
    }

    private func hello(_ key: Data) throws -> HelloAckMessage {
        let payload: [String: Any] = ["type": "hello_ack", "id": "hello", "timestamp": "2026-10-20T00:00:00Z",
            "serverVersion": "1.0.0", "machine": ["id": try MachineIdentityVerifier.machineID(forPublicKey: key), "name": "Test Mac",
            "platform": "darwin", "remiVersion": "0.8.0", "harnesses": ["claude"], "capabilities": []]]
        return try JSONDecoder().decode(HelloAckMessage.self, from: JSONSerialization.data(withJSONObject: payload))
    }

    @Test func activeApprovalStopRemainsVisibleAfterAnotherRouteConnectsAndFails() throws {
        let saved = try profile(.automatic)
        let localAddress = try #require(saved.routes.first { $0.connectionLayer == .local })
        let tail = try #require(saved.routes.first { $0.connectionLayer == .tailscale })
        let key = try RelayCrypto.unb64(try #require(saved.machinePublicKey))
        let localProfile = MachineRouteProfile(machineID: saved.machineID, routes: [localAddress],
            machinePublicKey: saved.machinePublicKey)
        let store = MachineStore(profiles: [localProfile], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        defer { store.stop() }
        let local = try #require(store.connectionGenerations.keys.first)
        store.receive(.awaitingLocalApproval(fingerprint: "owned-client"), from: local,
            generation: try #require(store.connectionGenerations[local]))
        store.addMachine(tail)
        let tailGeneration = try #require(store.connectionGenerations[tail])
        store.receive(.hello(try hello(key), authorityPublicKey: key), from: tail, generation: tailGeneration)
        #expect(store.machines.first?.endpoint.id == tail.id)
        store.receive(.reachabilityFailed(attempt: 1), from: tail, generation: tailGeneration)
        #expect(store.machines.first?.status == .waitingForApproval(fingerprint: "owned-client"))
    }

    @Test func choosingAPolicyOnAStoppedStoreDoesNotClaimAConnectionAttempt() throws {
        let saved = try profile(.automatic)
        let store = MachineStore(profiles: [saved], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        let endpoint = try #require(store.machines.first?.endpoint)
        store.setConnectionPreference(.tailscaleOnly, for: endpoint)
        #expect(store.machines.first?.endpoint.connectionLayer == .tailscale)
        #expect(store.machines.first?.status == .disconnected)
        #expect(store.connectionGenerations.isEmpty)
    }

    @Test(arguments: ["fd7a:115c:a1e0:0:0:0:0:1", "::ffff:6440:1", "ts.net."])
    func numericCandidateClassificationMatchesCodec(host: String) throws {
        let key = ClientIdentity().publicKeyBase64
        let json = #"{"v":2,"name":"Owned source","hosts":["\#(host)"],"port":18765,"key":"\#(key)","nonce":"AAAAAAAAAAAAAAAAAAAAAA","exp":\#(Int(Date().timeIntervalSince1970) + 300),"proto":1}"#
        let decoded = try PairingPayload(scannedValue: "remi://pair#" + RelayCrypto.b64(Data(json.utf8)))
        #expect(decoded.endpoint.connectionLayer == .tailscale)
        #expect(!MachineConnectionPreference.localOnly.permits(decoded.endpoint))
        #expect(MachineConnectionPreference.tailscaleOnly.permits(decoded.endpoint))
    }

}
