import Darwin
import Foundation
import Testing
@testable import RemiKit

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
            store.answer(sessionId: question.sessionId, questionId: question.question.id, answer: "yes")
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

    #if os(macOS)
    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_LOCAL_DISCOVERY_TEST"] == "1",
        "Publishes owned hostile Bonjour services and uses real sockets; never accepts OS permission prompts."),
        arguments: ["wrong-key", "refusal-PAIRING_PENDING", "refusal-PENDING_QUEUE_FULL", "refusal-AUTH_STORE_ERROR", "refusal-UNKNOWN_KEY", "session-hello", "overflow", "hello-close"])
    func untrustedBonjourRefusalCannotTearDownHealthyRouteOrReplayOperations(_ mode: String) async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/recovery-probe-peer.ts")
        let process = Process(), input = Pipe(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/Volumes/S1/yooz/remi/cache/tools/bun-1.3.11-darwin-arm64")
        process.arguments = [script.path, mode]
        process.environment = ["PATH": "/private/tmp/remi-1570-tools:/usr/bin:/bin"]
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.standardError
        try process.run()
        defer {
            try? input.fileHandleForWriting.close()
            if process.isRunning { process.terminate() }
            process.waitUntilExit()
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
        #expect(store.machines.first?.recoveryProgress?.phase == .waiting)
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
    func realHealthyTailscaleSourceSurvivesWrongKeyLocalDiscovery() async throws {
        let environment = ProcessInfo.processInfo.environment
        let local = try #require(environment["REMI_RECOVERY_LOCAL"])
        let tail = try #require(environment["REMI_RECOVERY_TAIL"])
        #expect(MachineEndpoint(host: tail, port: 1).connectionLayer == .tailscale)
        #expect(MachineEndpoint(host: local, port: 1).connectionLayer == .local)
        let integration = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Integration")
        let identity = ClientIdentity()
        let hub = Process(), hubInput = Pipe(), hubOutput = Pipe()
        hub.executableURL = URL(fileURLWithPath: "/Volumes/S1/yooz/remi/cache/tools/bun-1.3.11-darwin-arm64")
        hub.arguments = [integration.appendingPathComponent("local-discovery-fixture.ts").path, "tail"]
        hub.environment = ["PATH": "/private/tmp/remi-1570-tools:/usr/bin:/bin", "REMI_RECOVERY_SOURCE_BIND": tail]
        hub.standardInput = hubInput; hub.standardOutput = hubOutput; hub.standardError = FileHandle.standardError
        try hub.run()
        defer {
            try? hubInput.fileHandleForWriting.close()
            if hub.isRunning { hub.terminate() }; hub.waitUntilExit()
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
        peer.executableURL = hub.executableURL
        peer.arguments = [integration.appendingPathComponent("recovery-probe-peer.ts").path, "wrong-key", encoded]
        peer.environment = ["PATH": "/private/tmp/remi-1570-tools:/usr/bin:/bin", "REMI_RECOVERY_PEER_BIND": local]
        peer.standardInput = input; peer.standardOutput = output; peer.standardError = FileHandle.standardError
        try peer.run()
        defer {
            try? input.fileHandleForWriting.close()
            if peer.isRunning { peer.terminate() }; peer.waitUntilExit()
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
