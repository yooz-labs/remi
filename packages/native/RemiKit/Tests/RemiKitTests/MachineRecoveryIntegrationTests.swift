import Darwin
import Foundation
import Testing
@testable import RemiKit

@MainActor
private final class RecoveryAdmissionGate {
    var entered = false
    var released = false
}

private actor RecoveryVerifiedHello {
    private(set) var value: (HelloAckMessage, Data)?
    func record(_ event: RemiInboundEvent) {
        if case .hello(let hello, let key?) = event { value = (hello, key) }
    }
}

@MainActor
@Suite(.serialized)
struct MachineRecoveryIntegrationTests {
    private func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: root.appendingPathComponent("shared/tests/fixtures/protocol/\(name).json")))
    }

    private func listener() throws -> (Int32, Int) {
        let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw CocoaError(.fileReadUnknown) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        } }
        guard bound == 0, Darwin.listen(descriptor, 8) == 0 else { Darwin.close(descriptor); throw CocoaError(.fileReadUnknown) }
        var size = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.getsockname(descriptor, $0, &size) } }
        return (descriptor, Int(UInt16(bigEndian: address.sin_port)))
    }

    /// This exercises only the post-verification Store commit. The separate
    /// source and hostile-peer tests exercise real transport admission.
    @Test(arguments: [false, true])
    func promotionRetiresOperationsAndChildrenWithoutPersistingDiscovery(_ relay: Bool) async throws {
        let old = try listener(), fresh = try listener()
        defer { Darwin.close(old.0); Darwin.close(fresh.0) }
        let key = ClientIdentity().publicKeyRaw
        let relayPin = relay ? try RelayMachinePin(relayURL: "wss://127.0.0.1:\(old.1)", machinePublicKey: RelayCrypto.b64(key)) : nil
        let endpoint = MachineEndpoint(host: "127.0.0.1", port: old.1, relayPin: relayPin)
        let profile = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key), routes: [endpoint],
            displayName: "Saved alias", machinePublicKey: RelayCrypto.b64(key))
        let store = MachineStore(profiles: [profile], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start(); defer { store.stop() }
        let root = try #require(store.connectionGenerations.keys.first)
        let oldGeneration = try #require(store.connectionGenerations[root])
        let hello = try fixture("hello_ack_legacy", as: HelloAckMessage.self)
        let question = try fixture("question", as: QuestionMessage.self)
        store.receive(.hello(hello, authorityPublicKey: key), from: root, generation: oldGeneration)
        store.receive(.question(question), from: root, generation: oldGeneration)
        if relay {
            store.answer(machineID: store.machines[0].id, sessionId: question.sessionId, questionId: question.question.id, answer: "yes")
            #expect(store.ownedPendingAnswerCount == 1)
        } else {
            store.resumeSession(on: root, sessionId: "00000000-0000-4000-8000-000000000000")
            #expect(store.ownedResumeRequestIDs.count == 1)
            // Same-layer replacement is allowed only after the route lost health.
            store.receive(.retrying(attempt: 1, delaySeconds: 1), from: root, generation: oldGeneration)
        }
        let before = store.persistableProfiles
        let target = try #require(store.recoveryTargets().first)
        let candidate = MachineEndpoint(host: "127.0.0.1", port: fresh.1, expectedFingerprint: ClientIdentity.fingerprint(ofPublicKeyRaw: key),
            expectedPublicKey: key.base64EncodedString())
        try store.validateRecovery(target, endpoint: candidate)
        let connection = RemiConnection(configuration: .init(url: try #require(candidate.webSocketURL), clientVersion: "test", clientId: "test"),
            identity: ClientIdentity(), stateHandler: { _ in }, eventHandler: { _ in })
        let generation = UUID()
        let adoption = try store.admitRecovery(target: target, endpoint: candidate, discovered: true,
            connection: connection, generation: generation, hello: hello, key: key)
        #expect(adoption.generation == generation && store.connectionGenerations[candidate] == generation)
        #expect(store.connectionGenerations[root] == nil)
        #expect(store.ownedPendingAnswerCount == 0 && store.ownedResumeRequestIDs.isEmpty)
        #expect(store.persistableProfiles == before)
        #expect(store.machines.first?.displayName == "Saved alias")
        #expect(store.machines.first?.discoveredRoutes.count == 1)
        #expect(store.latestOperationNotice?.contains("uncertain") == true)
        store.receive(.rejected(reason: "stale old route"), from: root, generation: oldGeneration)
        #expect(store.machines.first?.status == .connected)
        #expect(store.ownedPendingAnswerCount == 0 && store.ownedResumeRequestIDs.isEmpty)
        store.stop(); await connection.stop()
    }

    @Test func healthySameLayerAndChangedPolicyCannotPassFinalValidation() throws {
        let socket = try listener()
        defer { Darwin.close(socket.0) }
        let key = ClientIdentity().publicKeyRaw
        let endpoint = MachineEndpoint(host: "127.0.0.1", port: socket.1)
        let saved = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key), routes: [endpoint], machinePublicKey: RelayCrypto.b64(key))
        let store = MachineStore(profiles: [saved], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start(); defer { store.stop() }
        let lifetime = try #require(store.machines.first?.pairingLifetime)
        let target = try #require(MachineRecoveryTarget(profile: saved, lifetime: lifetime,
            revision: 0, healthyLayer: nil))
        let root = try #require(store.connectionGenerations.keys.first)
        let generation = try #require(store.connectionGenerations[root])
        store.receive(.hello(try fixture("hello_ack_legacy", as: HelloAckMessage.self), authorityPublicKey: key), from: root, generation: generation)
        #expect(store.recoveryTargets().isEmpty)
        #expect(throws: (any Error).self) { try store.validateRecovery(target, endpoint: root) }
        store.setConnectionPreference(.tailscaleOnly, for: root)
        #expect(throws: (any Error).self) { try store.validateRecovery(target, endpoint: root) }
        _ = store.removeMachine(root)
        #expect(throws: (any Error).self) { try store.validateRecovery(target, endpoint: root) }
    }

    @Test func actualCoordinatorDebouncesBoundsStartsAndCancelsLateWork() async throws {
        let sockets = try (0..<12).map { _ in try listener() }
        let ports = sockets.map(\.1)
        // Real kernel refusals: release the owned listeners before connecting.
        for socket in sockets { Darwin.close(socket.0) }
        let key = ClientIdentity().publicKeyRaw
        let profile = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
            routes: ports.map { MachineEndpoint(host: "127.0.0.1", port: $0) }, connectionPreference: .localOnly,
            machinePublicKey: RelayCrypto.b64(key))
        let target = try #require(MachineRecoveryTarget(profile: profile, lifetime: UUID(), revision: 0, healthyLayer: nil))
        let coordinator = MachineRecoveryCoordinator(identity: ClientIdentity(), clientVersion: "test", clientID: "test",
            snapshot: { [target] }, validate: { target, route in
                guard target.permits(route) else { throw CancellationError() }
            }, admit: { _, _, _, _, _, _, _ in throw PairingAdmissionError.refused("A closed listener cannot authenticate") },
            forward: { _, _ in Issue.record("A refused socket acquired domain dispatch") }, resume: { _ in }, publish: { _, _ in })
        coordinator.start(); defer { coordinator.stop() }
        var requested = ContinuousClock.now
        for _ in 0..<8 { requested = .now; coordinator.trigger(newEpisode: true) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(4))
        while coordinator.ownedStarts.count < 8, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        #expect(coordinator.ownedStarts.count == 8)
        let firstStart = try #require(coordinator.ownedStartTimes.first)
        // A full-suite MainActor stall may delay this test's own wakeup beyond
        // 750 ms. Check actual start timestamps, not a presumed 200 ms wakeup.
        #expect(firstStart >= requested.advanced(by: MachineRecoverySchedule.debounce))
        #expect(coordinator.ownedStarts.allSatisfy { $0.1 == .local && !$0.2 })
        coordinator.trigger(newEpisode: true)
        try await Task.sleep(for: .milliseconds(200))
        #expect(coordinator.ownedStarts.count == 8) // path epoch retains cooldown
        let epoch = coordinator.ownedEpoch
        coordinator.stop()
        try await Task.sleep(for: .milliseconds(150))
        #expect(coordinator.ownedEpoch != epoch && coordinator.ownedActiveProbes == 0 && !coordinator.ownedIsBrowsing)
        #expect(coordinator.ownedStarts.count == 8)
    }

    @Test(arguments: [MachineConnectionPreference.tailscaleOnly, .relayOnly])
    func strictMissingLayersStartNoDiscoveryOrDisallowedProbes(_ preference: MachineConnectionPreference) async throws {
        let socket = try listener()
        defer { Darwin.close(socket.0) }
        let key = ClientIdentity().publicKeyRaw
        let saved = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
            routes: [MachineEndpoint(host: "127.0.0.1", port: socket.1)], connectionPreference: preference,
            machinePublicKey: RelayCrypto.b64(key))
        let store = MachineStore(profiles: [saved], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start(); defer { store.stop() }
        let settled = ContinuousClock.now.advanced(by: .seconds(5))
        while store.machines.first?.recoveryProgress?.phase != .exhausted, ContinuousClock.now < settled {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(store.connectionGenerations.isEmpty)
        #expect(store.ownedRecoveryCoordinator?.ownedStarts.isEmpty == true)
        #expect(store.ownedRecoveryCoordinator?.ownedIsBrowsing == false)
        #expect(store.machines.first?.recoveryProgress?.message.contains(preference == .relayOnly ? "enrolled Relay" : "Tailscale") == true)
        let epoch = store.ownedRecoveryCoordinator?.ownedEpoch
        store.suspendForegroundConnections()
        #expect(store.ownedRecoveryCoordinator?.ownedEpoch != epoch)
        #expect(store.ownedRecoveryCoordinator?.ownedActiveProbes == 0)
    }

    @Test func foregroundResetsExhaustedEpisodeWithoutBypassingCooldown() async throws {
        let socket = try listener()
        defer { Darwin.close(socket.0) }
        let key = ClientIdentity().publicKeyRaw
        let profile = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
            routes: [MachineEndpoint(host: "127.0.0.1", port: socket.1)], connectionPreference: .relayOnly,
            machinePublicKey: RelayCrypto.b64(key))
        let store = MachineStore(profiles: [profile], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start(); defer { store.stop() }
        let until = ContinuousClock.now.advanced(by: .seconds(5))
        while store.machines.first?.recoveryProgress?.phase != .exhausted, ContinuousClock.now < until {
            try await Task.sleep(for: .milliseconds(10))
        }
        let coordinator = try #require(store.ownedRecoveryCoordinator)
        #expect(store.machines.first?.recoveryProgress?.phase == .exhausted && coordinator.ownedSweepCount == 1)
        let epoch = coordinator.ownedEpoch
        let started = try #require(coordinator.ownedLastSweepStart)
        store.foregroundRecoveryActivated()
        let due = try #require(coordinator.ownedNextSweep)
        #expect(coordinator.ownedEpoch != epoch && coordinator.ownedSweepCount == 0)
        #expect(due >= started.advanced(by: MachineRecoverySchedule.cooldown))
        #expect(store.connectionGenerations.isEmpty && coordinator.ownedStarts.isEmpty && !coordinator.ownedIsBrowsing)
    }

    @Test(arguments: [false, true])
    func foregroundKeepsHealthyGenerationAndConfiguredAuthenticationStops(_ approval: Bool) throws {
        let socket = try listener()
        defer { Darwin.close(socket.0) }
        let key = ClientIdentity().publicKeyRaw
        let profile = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
            routes: [MachineEndpoint(host: "127.0.0.1", port: socket.1)], machinePublicKey: RelayCrypto.b64(key))
        let store = MachineStore(profiles: [profile], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start(); defer { store.stop() }
        let root = try #require(store.machines.first?.endpoint)
        let generation = try #require(store.connectionGenerations[root])
        store.receive(.hello(try fixture("hello_ack_legacy", as: HelloAckMessage.self), authorityPublicKey: key), from: root, generation: generation)
        store.foregroundRecoveryActivated()
        #expect(store.machines.first?.status == .connected && store.connectionGenerations[root] == generation)
        #expect(store.recoveryTargets().isEmpty)
        store.receive(approval ? .awaitingLocalApproval(fingerprint: "owned-device") : .rejected(reason: "Wrong saved key"),
            from: root, generation: generation)
        let stopped = store.machines.first?.status
        store.foregroundRecoveryActivated()
        #expect(store.machines.first?.status == stopped && store.recoveryTargets().isEmpty)
        #expect(store.ownedRecoveryCoordinator?.ownedStarts.isEmpty == true)
        #expect(approval ? store.connectionGenerations[root] == generation : store.connectionGenerations.isEmpty)
    }

    @Test func fullPinRetryStillReplacesFailedChildWithoutRestartingHealthyHub() throws {
        let hub = try listener(), session = try listener()
        defer { Darwin.close(hub.0); Darwin.close(session.0) }
        let key = ClientIdentity().publicKeyRaw
        let profile = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
            routes: [MachineEndpoint(host: "127.0.0.1", port: hub.1)], machinePublicKey: RelayCrypto.b64(key))
        let store = MachineStore(profiles: [profile], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start(); defer { store.stop() }
        let root = try #require(store.machines.first?.endpoint)
        let generation = try #require(store.connectionGenerations[root])
        store.ownedObserveParentHello(root, key: key)
        store.receive(.hello(try fixture("hello_ack_legacy", as: HelloAckMessage.self), authorityPublicKey: key), from: root, generation: generation)
        var payload = try #require(JSONSerialization.jsonObject(with: FixtureConformanceTests.fixture("session_list_response")) as? [String: Any])
        payload["sessions"] = [] as [String]
        payload["daemonPorts"] = [session.1]
        let list = try JSONDecoder().decode(SessionListResponse.self, from: JSONSerialization.data(withJSONObject: payload))
        store.receive(.sessions(list), from: root, generation: generation)
        let child = try #require(store.connectionGenerations.keys.first { $0.port == session.1 })
        let old = try #require(store.connectionGenerations[child])
        store.receive(.rejected(reason: "Owned child refusal"), from: child, generation: old)
        #expect(store.machines.first?.sessionConnectionIssue != nil)
        store.retryConnection(for: root)
        #expect(store.connectionGenerations[child] != old && store.connectionGenerations[child] != nil)
        #expect(store.connectionGenerations[root] == generation && store.machines.first?.status == .connected)
        #expect(store.machines.first?.sessionConnectionIssue == nil)
        #expect(store.ownedConnectionMachineIDs[child] == profile.machineID)
        store.receive(.rejected(reason: "Retired child"), from: child, generation: old)
        #expect(store.machines.first?.sessionConnectionIssue == nil)
    }

    /// Both the original owner and the promoted connection complete a real
    /// signed Hello before this Store-commit control exercises its route changes.
    @Test(arguments: [false, true])
    func learnedPinRecoveryKeepsCanonicalConfiguredOwner(_ discovered: Bool) async throws {
        let session = try listener()
        defer { Darwin.close(session.0) }
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/direct-child-key-peer.ts")
        let peer = Process(), input = Pipe(), output = Pipe()
        let directory = try OwnedRecoveryFixture.configure(peer, script: script, arguments: ["matching", "stats.json"])
        peer.standardInput = input; peer.standardOutput = output; peer.standardError = FileHandle.standardError
        try peer.run()
        defer {
            try? input.fileHandleForWriting.close()
            if peer.isRunning { peer.terminate() }
        }
        let info = try #require(try await readLine(output.fileHandleForReading) as? [String: Any])
        let encodedKey = try #require(info["publicKey"] as? String)
        let key = try #require(Data(base64Encoded: encodedKey))
        let root = MachineEndpoint(host: "127.0.0.1", port: try #require(info["rootPort"] as? Int))
        let store = MachineStore(endpoints: [root], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start(); defer { store.stop() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while store.machines.first?.status != .connected && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        try #require(store.machines.first?.status == .connected, "Original route must complete real signed Hello")
        let initial = try #require(store.connectionGenerations[root])
        store.renameMachine(root, to: "Saved manual alias")
        store.receive(.retrying(attempt: 1, delaySeconds: 1), from: root, generation: initial)
        let navigationID = try #require(store.machines.first?.id)
        let target = try #require(store.recoveryTargets().first)
        let pinned = target.pinned(root)
        #expect(pinned.id == root.id && pinned != root)
        let received = RecoveryVerifiedHello()
        let connection = RemiConnection(configuration: .init(url: try #require(pinned.webSocketURL), clientVersion: "test", clientId: "test",
            expectedServerPublicKey: key.base64EncodedString()), identity: ClientIdentity(), stateHandler: { _ in },
            eventHandler: { event in Task { await received.record(event) } })
        defer { Task { await connection.stop() } }
        await connection.start()
        let secondDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while await received.value == nil && ContinuousClock.now < secondDeadline { try await Task.sleep(for: .milliseconds(10)) }
        let (hello, provenKey) = try #require(await received.value, "Promoted socket must complete real signed Hello")
        #expect(provenKey == key)
        let generation = UUID()
        let adopted = try store.admitRecovery(target: target, endpoint: pinned, discovered: discovered,
            connection: connection, generation: generation, hello: hello, key: provenKey)
        #expect(adopted.endpoint == pinned && store.machines.first?.routes.first == pinned)
        #expect(store.machines.first?.endpoint == pinned && store.machines.first?.id == navigationID)
        #expect(store.machines.first?.displayName == "Saved manual alias")
        #expect(store.machines.first?.discoveredRoutes.isEmpty == true)
        #expect(store.connectionGenerations[root] == nil && store.connectionGenerations[pinned] == generation)
        var payload = try #require(try JSONSerialization.jsonObject(with: FixtureConformanceTests.fixture("session_list_response")) as? [String: Any])
        payload["daemonPorts"] = [session.1]
        let list = try JSONDecoder().decode(SessionListResponse.self, from: JSONSerialization.data(withJSONObject: payload))
        store.receive(.sessions(list), from: pinned, generation: generation)
        let child = try #require(store.connectionGenerations.keys.first { $0.port == session.1 })
        let childGeneration = try #require(store.connectionGenerations[child])
        store.receive(.sessions(list), from: child, generation: childGeneration)
        #expect(store.ownedConnectionMachineIDs[child] == target.machineID)
        #expect(store.ownedParentRoutes[child] == pinned)
        let sessionID = try #require(list.sessions.first?.sessionId)
        #expect(store.ownedSessionRoutes[MachineSessionKey(machineID: store.machines[0].id, sessionID: sessionID)] == child)
        store.setConnectionPreference(.relayOnly, for: pinned)
        #expect(store.connectionGenerations.isEmpty && store.ownedParentRoutes.isEmpty && store.ownedSessionRoutes.isEmpty)
        #expect(store.machines.first?.connectionPreference == .relayOnly)
        let stopped = store.machines.first?.status
        store.receive(.hello(hello, authorityPublicKey: key), from: pinned, generation: generation)
        store.receive(.sessions(list), from: child, generation: childGeneration)
        #expect(store.connectionGenerations.isEmpty && store.ownedSessionRoutes.isEmpty && store.machines.first?.status == stopped)
        store.stop(); await connection.stop()
        try? input.fileHandleForWriting.close()
        let stopDeadline = ContinuousClock.now.advanced(by: .seconds(3))
        while peer.isRunning && ContinuousClock.now < stopDeadline { try await Task.sleep(for: .milliseconds(10)) }
        #expect(!peer.isRunning)
        if !peer.isRunning { try? FileManager.default.removeItem(at: directory) }
    }

    @Test(arguments: [0, 1, 2])
    func lateConfiguredStopInvalidatesRecoverySnapshot(_ stop: Int) throws {
        let hub = try listener()
        defer { Darwin.close(hub.0) }
        let key = ClientIdentity().publicKeyRaw
        let root = MachineEndpoint(host: "127.0.0.1", port: hub.1)
        let profile = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
            routes: [root], machinePublicKey: RelayCrypto.b64(key))
        let store = MachineStore(profiles: [profile], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start(); defer { store.stop() }
        let route = try #require(store.machines.first?.endpoint)
        let generation = try #require(store.connectionGenerations[route])
        store.receive(.retrying(attempt: 1, delaySeconds: 1), from: route, generation: generation)
        let target = try #require(store.recoveryTargets().first)
        let coordinator = try #require(store.ownedRecoveryCoordinator)
        let due = try #require(coordinator.ownedNextSweep)
        let state: RemiConnectionState = stop == 0 ? .awaitingLocalApproval(fingerprint: "owned")
            : stop == 1 ? .awaitingRelayConfirmation(fingerprint: "owned") : .rejected(reason: "Configured refusal")
        store.receive(state, from: route, generation: generation)
        #expect(coordinator.ownedNextSweep == due)
        #expect(store.recoveryTargets().isEmpty)
        #expect(throws: (any Error).self) { try store.validateRecovery(target, endpoint: target.pinned(route)) }
    }

    @Test func admittedDiscoveredRootStopBlocksSnapshotAndFinalValidation() async throws {
        let hub = try listener(), fresh = try listener()
        defer { Darwin.close(hub.0); Darwin.close(fresh.0) }
        let key = ClientIdentity().publicKeyRaw
        let root = MachineEndpoint(host: "127.0.0.1", port: hub.1)
        let profile = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
            routes: [root], machinePublicKey: RelayCrypto.b64(key))
        let store = MachineStore(profiles: [profile], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start(); defer { store.stop() }
        let configured = try #require(store.machines.first?.endpoint)
        let initial = try #require(store.connectionGenerations[configured])
        store.receive(.retrying(attempt: 1, delaySeconds: 1), from: configured, generation: initial)
        let target = try #require(store.recoveryTargets().first)
        let candidate = target.pinned(MachineEndpoint(host: "127.0.0.1", port: fresh.1))
        let connection = RemiConnection(configuration: .init(url: try #require(candidate.webSocketURL), clientVersion: "test", clientId: "test"),
            identity: ClientIdentity(), stateHandler: { _ in }, eventHandler: { _ in })
        let generation = UUID()
        _ = try store.admitRecovery(target: target, endpoint: candidate, discovered: true, connection: connection,
            generation: generation, hello: try fixture("hello_ack_legacy", as: HelloAckMessage.self), key: key)
        store.receive(.retrying(attempt: 1, delaySeconds: 1), from: candidate, generation: generation)
        let snapshot = try #require(store.recoveryTargets().first)
        store.receive(.awaitingLocalApproval(fingerprint: "owned-discovered"), from: candidate, generation: generation)
        #expect(store.recoveryTargets().isEmpty)
        #expect(store.machines.first?.status == .waitingForApproval(fingerprint: "owned-discovered"))
        #expect(throws: (any Error).self) { try store.validateRecovery(snapshot, endpoint: target.pinned(root)) }
        store.stop(); await connection.stop()
    }

    @Test func configuredStopReschedulesOtherProfilesWithinExistingEpisode() async throws {
        let sockets = try (0..<2).map { _ in try listener() }
        defer { for socket in sockets { Darwin.close(socket.0) } }
        let profiles = try sockets.map { socket in
            let key = ClientIdentity().publicKeyRaw
            return MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
                routes: [MachineEndpoint(host: "127.0.0.1", port: socket.1)], connectionPreference: .localOnly,
                machinePublicKey: RelayCrypto.b64(key))
        }
        let store = MachineStore(profiles: profiles, identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start(); defer { store.stop() }
        let routes = store.machines.map(\.endpoint)
        let generations = try routes.map { try #require(store.connectionGenerations[$0]) }
        for (route, generation) in zip(routes, generations) {
            store.receive(.retrying(attempt: 1, delaySeconds: 1), from: route, generation: generation)
        }
        let coordinator = try #require(store.ownedRecoveryCoordinator)
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while coordinator.ownedActiveProbes < 2, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        try #require(coordinator.ownedActiveProbes == 2)
        let started = try #require(coordinator.ownedLastSweepStart)
        let sweeps = coordinator.ownedSweepCount, epoch = coordinator.ownedEpoch, starts = coordinator.ownedStarts.count
        store.receive(.awaitingLocalApproval(fingerprint: "owned-profile"), from: routes[0], generation: generations[0])
        let due = try #require(coordinator.ownedNextSweep)
        #expect(coordinator.ownedEpoch != epoch && coordinator.ownedActiveProbes == 0)
        #expect(coordinator.ownedSweepCount == sweeps && coordinator.ownedLastSweepStart == started)
        #expect(due >= started.advanced(by: MachineRecoverySchedule.cooldown))
        #expect(coordinator.ownedStarts.count == starts && store.recoveryTargets().map(\.id) == [store.machines[1].id])
        #expect(store.machines[0].status == .waitingForApproval(fingerprint: "owned-profile"))
        #expect(store.machines[0].recoveryProgress == nil && store.machines[1].recoveryProgress?.phase == .scheduled)
    }

    #if os(macOS)
    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_LOCAL_DISCOVERY_TEST"] == "1",
        "Owns a real authenticated candidate socket and gates it before Store admission."), arguments: [0, 1, 2])
    func configuredStopWhileRealCandidateAwaitsAdmission(_ stop: Int) async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/recovery-probe-peer.ts")
        let peer = Process(), input = Pipe(), output = Pipe()
        let directory = try OwnedRecoveryFixture.configure(peer, script: script, arguments: ["admission"],
            environment: ["REMI_RECOVERY_PEER_BIND": "127.0.0.1"])
        peer.standardInput = input; peer.standardOutput = output; peer.standardError = FileHandle.standardError
        try peer.run()
        defer {
            try? input.fileHandleForWriting.close()
            if peer.isRunning { peer.terminate() }; peer.waitUntilExit()
            try? FileManager.default.removeItem(at: directory)
        }
        let metadata = try #require(try await readLine(output.fileHandleForReading) as? [String: Any])
        let encoded = try #require(metadata["publicKey"] as? String)
        let key = try #require(Data(base64Encoded: encoded))
        let port = try #require(metadata["port"] as? Int)
        let root = MachineEndpoint(host: "100.64.0.1", port: port, expectedFingerprint: ClientIdentity.fingerprint(ofPublicKeyRaw: key), expectedPublicKey: key.base64EncodedString())
        let candidate = MachineEndpoint(host: "127.0.0.1", port: port)
        let profile = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
            routes: [root, candidate], machinePublicKey: RelayCrypto.b64(key))
        let identity = ClientIdentity()
        let store = MachineStore(profiles: [profile], identity: identity, clientVersion: "test", clientId: "test")
        store.start(); defer { store.stop() }
        let connection = RemiConnection(configuration: .init(url: try #require(root.webSocketURL), clientVersion: "test", clientId: "test"),
            identity: identity, stateHandler: { _ in }, eventHandler: { _ in })
        let lifetime = try #require(store.machines.first?.pairingLifetime)
        // Only the previous configured root uses the post-verification seam.
        // The quarantined candidate below authenticates over its actual socket.
        let old = store.admitPairing(connection, endpoint: root, hints: [root, candidate],
            hello: try fixture("hello_ack_legacy", as: HelloAckMessage.self), authority: key,
            origin: .init(lifetime: lifetime, preference: .automatic), preference: .automatic)
        let gate = RecoveryAdmissionGate()
        store.ownedBeforeRecoveryAdmission = {
            gate.entered = true
            while !gate.released { try? await Task.sleep(for: .milliseconds(10)) }
        }
        defer { gate.released = true }
        store.retryConnection(for: root)
        let deadline = ContinuousClock.now.advanced(by: .seconds(8))
        while !gate.entered, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        try #require(gate.entered)
        let target = try #require(store.recoveryTargets().first)
        let coordinator = try #require(store.ownedRecoveryCoordinator)
        let starts = coordinator.ownedStarts.count
        let state: RemiConnectionState = stop == 0 ? .awaitingLocalApproval(fingerprint: "owned")
            : stop == 1 ? .awaitingRelayConfirmation(fingerprint: "owned") : .rejected(reason: "Configured refusal")
        store.receive(state, from: old.endpoint, generation: old.generation)
        let stopped = store.machines.first?.status
        #expect(throws: (any Error).self) { try store.validateRecovery(target, endpoint: target.pinned(candidate)) }
        gate.released = true
        let retired = ContinuousClock.now.advanced(by: .seconds(3))
        while coordinator.ownedActiveProbes != 0, ContinuousClock.now < retired { try await Task.sleep(for: .milliseconds(10)) }
        try await Task.sleep(for: .milliseconds(850))
        #expect(coordinator.ownedAdmittedConnections.isEmpty)
        #expect(coordinator.ownedStarts.count == starts && coordinator.ownedActiveProbes == 0)
        #expect(store.machines.first?.status == stopped && store.recoveryTargets().isEmpty)
        store.retryConnection(for: try #require(store.machines.first?.endpoint))
        #expect(!store.recoveryTargets().isEmpty && coordinator.ownedNextSweep != nil)
        store.stop(); await connection.stop()
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_LOCAL_DISCOVERY_TEST"] == "1",
        "Publishes owned hostile Bonjour services and uses real sockets; never accepts OS permission prompts."),
        arguments: ["wrong-key", "refusal-PAIRING_PENDING", "refusal-PENDING_QUEUE_FULL", "refusal-AUTH_STORE_ERROR", "refusal-UNKNOWN_KEY", "session-hello", "overflow", "hello-close"])
    func untrustedBonjourRefusalCannotTearDownHealthyRouteOrReplayOperations(_ mode: String) async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/recovery-probe-peer.ts")
        let process = Process(), input = Pipe(), output = Pipe()
        let directory = try OwnedRecoveryFixture.configure(process, script: script, arguments: [mode])
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.standardError
        try process.run()
        defer {
            try? input.fileHandleForWriting.close()
            if process.isRunning { process.terminate() }
            process.waitUntilExit()
            try? FileManager.default.removeItem(at: directory)
        }
        let metadata = try #require(try await readLine(output.fileHandleForReading) as? [String: Any])
        let encoded = try #require(metadata["publicKey"] as? String)
        let key = try #require(Data(base64Encoded: encoded))
        let old = try listener()
        defer { Darwin.close(old.0) }
        let pin = try RelayMachinePin(relayURL: "wss://127.0.0.1:\(old.1)", machinePublicKey: RelayCrypto.b64(key))
        let saved = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
            routes: [MachineEndpoint(host: "127.0.0.1", port: old.1, relayPin: pin)], displayName: "Kept alias", machinePublicKey: RelayCrypto.b64(key))
        let store = MachineStore(profiles: [saved], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        if mode == "overflow" || mode == "hello-close" { store.ownedBeforeRecoveryAdmission = { try? await Task.sleep(for: .milliseconds(250)) } }
        defer { store.stop() }
        let oldRoute = try #require(store.machines.first?.endpoint)
        let ownedConnection = RemiConnection(configuration: .init(url: try #require(pin.clientURL),
            clientVersion: "test", clientId: "test", relayPin: pin), identity: ClientIdentity(),
            stateHandler: { _ in }, eventHandler: { _ in })
        let lifetime = try #require(store.machines.first?.pairingLifetime)
        // Explicit post-verification healthy-route fixture. This is not claimed
        // as real relay acceptance; the candidate browser/socket below are real.
        let oldAdoption = store.admitPairing(ownedConnection, endpoint: oldRoute, hints: [oldRoute],
            hello: try fixture("hello_ack_legacy", as: HelloAckMessage.self), authority: key,
            origin: .init(lifetime: lifetime, preference: .automatic), preference: .automatic)
        let generation = oldAdoption.generation
        let before = store.persistableProfiles
        store.retryConnection(for: oldRoute)
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while (store.machines.first?.recoveryProgress?.phase != .waiting || store.ownedRecoveryCoordinator?.ownedActiveProbes != 0), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(store.machines.first?.recoveryProgress?.phase == .waiting,
            Comment(rawValue: "Owned recovery: \(store.ownedRecoveryCoordinator?.ownedScheduleEvents ?? []); starts=\(store.ownedRecoveryCoordinator?.ownedStarts ?? []); stops=\(store.ownedTerminalRootIDs)"))
        let starts = store.ownedRecoveryCoordinator?.ownedStarts.count ?? 0
        #expect((1...4).contains(starts))
        #expect(store.ownedRecoveryCoordinator?.ownedStarts.first?.2 == true)
        #expect(store.connectionGenerations[oldRoute] == generation)
        #expect(store.machines.first?.status == .connected && store.machines.first?.endpoint.id == oldRoute.id)
        #expect(store.persistableProfiles == before && store.ownedPendingAnswerCount == 0 && store.ownedResumeRequestIDs.isEmpty)
        #expect(store.latestOperationError == nil)
        try await Task.sleep(for: .milliseconds(1200))
        try input.fileHandleForWriting.write(contentsOf: Data("stats\n".utf8))
        let stats = try #require(try await readLine(output.fileHandleForReading) as? [String: Any])
        let opens = try #require(stats["opens"] as? Int)
        #expect(opens >= 1 && opens <= starts)
        #expect(store.ownedRecoveryCoordinator?.ownedStarts.count == starts)
        #expect(stats["operations"] as? Int == 0)
        #expect(store.ownedRecoveryCoordinator?.ownedAdmittedConnections.isEmpty == true)
    }

    private func readLine(_ handle: FileHandle) async throws -> Any {
        var data = Data()
        for try await byte in handle.bytes { if byte == 10 { break }; data.append(byte) }
        return try JSONSerialization.jsonObject(with: data)
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_OWNED_RECOVERY_NETWORK_TEST"] == "1",
        "Requires two explicitly selected existing owned interfaces; no network administration."))
    func realHealthyLockedTailscaleDoesNotReportItsAddressMissing() async throws {
        let tail = try #require(ProcessInfo.processInfo.environment["REMI_RECOVERY_TAIL"])
        #expect(MachineEndpoint(host: tail, port: 1).connectionLayer == .tailscale)
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/local-discovery-fixture.ts")
        let identity = ClientIdentity()
        let hub = Process(), input = Pipe(), output = Pipe()
        let directory = try OwnedRecoveryFixture.configure(hub, script: script, arguments: ["tail"],
            environment: ["REMI_RECOVERY_SOURCE_BIND": tail])
        hub.standardInput = input; hub.standardOutput = output; hub.standardError = FileHandle.standardError
        try hub.run()
        defer {
            try? input.fileHandleForWriting.close()
            if hub.isRunning { hub.terminate() }; hub.waitUntilExit()
            try? FileManager.default.removeItem(at: directory)
        }
        let client = try JSONSerialization.data(withJSONObject: ["publicKey": identity.publicKeyBase64])
        try input.fileHandleForWriting.write(contentsOf: client + Data([10]))
        let metadata = try #require(try await readLine(output.fileHandleForReading) as? [String: Any])
        let encodedKey = try #require(metadata["publicKey"] as? String)
        let key = try #require(Data(base64Encoded: encodedKey))
        let port = try #require(metadata["hubPort"] as? Int)
        let endpoint = MachineEndpoint(host: tail, port: port)
        let profile = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
            routes: [endpoint], connectionPreference: .tailscaleOnly, machinePublicKey: RelayCrypto.b64(key))
        let store = MachineStore(profiles: [profile], identity: identity, clientVersion: "owned-locked-recovery", clientId: "owned-locked-recovery")
        store.start(); defer { store.stop() }
        let connected = ContinuousClock.now.advanced(by: .seconds(10))
        while (store.machines.first?.status != .connected || store.machines.first?.hasLoadedSessions != true), ContinuousClock.now < connected {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(store.machines.first?.status == .connected && store.machines.first?.hasLoadedSessions == true)
        let active = try #require(store.machines.first?.endpoint)
        let generation = try #require(store.connectionGenerations[active])
        let socket = try #require(store.ownedConnectionID(active))
        let before = store.persistableProfiles
        store.foregroundRecoveryActivated()
        // Exercise the real debounce and coordinator, rather than only testing
        // the target list. The active owned source hub stays reachable.
        try await Task.sleep(for: MachineRecoverySchedule.debounce + .milliseconds(500))
        #expect(store.machines.first?.status == .connected)
        #expect(store.machines.first?.connectionPreference == .tailscaleOnly)
        #expect(store.machines.first?.routes.contains { $0.connectionLayer == .tailscale } == true)
        #expect(store.recoveryTargets().isEmpty)
        #expect(store.machines.first?.recoveryProgress == nil,
            Comment(rawValue: store.machines.first?.recoveryProgress?.message ?? "No spurious recovery warning"))
        #expect(store.ownedRecoveryCoordinator?.ownedStarts.isEmpty == true)
        #expect(store.connectionGenerations[active] == generation && store.ownedConnectionID(active) == socket)
        #expect(store.persistableProfiles == before)
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_OWNED_RECOVERY_NETWORK_TEST"] == "1",
        "Requires two explicitly selected existing owned interfaces; no network administration."))
    func realHealthyTailscaleSourceSurvivesWrongKeyLocalDiscovery() async throws {
        let environment = ProcessInfo.processInfo.environment
        let local = try #require(environment["REMI_RECOVERY_LOCAL"])
        let tail = try #require(environment["REMI_RECOVERY_TAIL"])
        #expect(MachineEndpoint(host: tail, port: 1).connectionLayer == .tailscale)
        #expect(MachineEndpoint(host: local, port: 1).connectionLayer == .local)
        let integration = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Integration")
        let identity = ClientIdentity()
        let hub = Process(), hubInput = Pipe(), hubOutput = Pipe()
        let hubDirectory = try OwnedRecoveryFixture.configure(hub, script: integration.appendingPathComponent("local-discovery-fixture.ts"),
            arguments: ["tail"], environment: ["REMI_RECOVERY_SOURCE_BIND": tail])
        hub.standardInput = hubInput; hub.standardOutput = hubOutput; hub.standardError = FileHandle.standardError
        try hub.run()
        defer {
            try? hubInput.fileHandleForWriting.close()
            if hub.isRunning { hub.terminate() }; hub.waitUntilExit()
            try? FileManager.default.removeItem(at: hubDirectory)
        }
        let client = try JSONSerialization.data(withJSONObject: ["publicKey": identity.publicKeyBase64])
        try hubInput.fileHandleForWriting.write(contentsOf: client + Data([10]))
        let metadata = try #require(try await readLine(hubOutput.fileHandleForReading) as? [String: Any])
        let encoded = try #require(metadata["publicKey"] as? String)
        let key = try #require(Data(base64Encoded: encoded))
        let port = try #require(metadata["hubPort"] as? Int)
        let saved = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
            routes: [MachineEndpoint(host: tail, port: port)], displayName: "Real owned hub", machinePublicKey: RelayCrypto.b64(key))
        let store = MachineStore(profiles: [saved], identity: identity, clientVersion: "owned-recovery", clientId: "owned-recovery")
        store.start(); defer { store.stop() }
        let connected = ContinuousClock.now.advanced(by: .seconds(10))
        while (store.machines.first?.status != .connected || store.machines.first?.hasLoadedSessions != true), ContinuousClock.now < connected {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(store.machines.first?.status == .connected)
        let active = try #require(store.machines.first?.endpoint)
        #expect(active.host == tail)
        let generation = try #require(store.connectionGenerations[active])
        let socket = try #require(store.ownedConnectionID(active))
        let before = store.persistableProfiles
        let peer = Process(), input = Pipe(), output = Pipe()
        let peerDirectory = try OwnedRecoveryFixture.configure(peer, script: integration.appendingPathComponent("recovery-probe-peer.ts"),
            arguments: ["wrong-key", encoded], environment: ["REMI_RECOVERY_PEER_BIND": local])
        peer.standardInput = input; peer.standardOutput = output; peer.standardError = FileHandle.standardError
        try peer.run()
        defer {
            try? input.fileHandleForWriting.close()
            if peer.isRunning { peer.terminate() }; peer.waitUntilExit()
            try? FileManager.default.removeItem(at: peerDirectory)
        }
        _ = try await readLine(output.fileHandleForReading)
        store.retryConnection(for: active)
        let refused = ContinuousClock.now.advanced(by: .seconds(12))
        while (store.ownedRecoveryCoordinator?.ownedRefusalReasons.contains(where: { $0.contains("saved machine identity") }) != true
               || store.machines.first?.recoveryProgress?.message.contains("saved machine identity") != true
               || store.ownedRecoveryCoordinator?.ownedActiveProbes != 0), ContinuousClock.now < refused {
            try await Task.sleep(for: .milliseconds(20))
        }
        let message = store.machines.first?.recoveryProgress?.message ?? "missing recovery progress"
        #expect(message.contains("saved machine identity"), Comment(rawValue: message))
        #expect(store.ownedRecoveryCoordinator?.ownedRefusalReasons.contains(where: { $0.contains("saved machine identity") }) == true,
            Comment(rawValue: "Terminal probe refusals: \(store.ownedRecoveryCoordinator?.ownedRefusalReasons ?? [])"))
        #expect(store.ownedRecoveryCoordinator?.ownedStarts.allSatisfy { $0.1 == .local && $0.2 } == true)
        #expect(store.ownedRecoveryCoordinator?.ownedStarts.isEmpty == false)
        #expect(store.connectionGenerations[active] == generation && store.ownedConnectionID(active) == socket)
        #expect(store.machines.first?.status == .connected && store.machines.first?.endpoint.id == active.id)
        #expect(store.persistableProfiles == before)
        let request = try #require(store.ownedRequestSessions(active))
        let receipt = ContinuousClock.now.advanced(by: .seconds(3))
        while !store.ownedSessionListReceipts.contains(request), ContinuousClock.now < receipt {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(store.ownedSessionListReceipts.contains(request))
        #expect(store.connectionGenerations[active] == generation && store.ownedConnectionID(active) == socket)
        try await Task.sleep(for: .milliseconds(1200))
        try input.fileHandleForWriting.write(contentsOf: Data("stats\n".utf8))
        let stats = try #require(try await readLine(output.fileHandleForReading) as? [String: Any])
        #expect(stats["authenticationResponses"] as? Int == 0)
        #expect(stats["operations"] as? Int == 0)
        let opens = try #require(stats["opens"] as? Int)
        #expect((1...4).contains(opens))
    }
    #endif
}
