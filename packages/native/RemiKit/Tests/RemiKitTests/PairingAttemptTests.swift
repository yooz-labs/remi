import Darwin
import Foundation
import Testing
@testable import RemiKit

@MainActor private final class OwnedRetirementGate { var released = false }

@MainActor
@Suite struct PairingAttemptTests {
    private func payload(hosts: [String] = ["192.168.1.23", "100.101.102.103"],
                         key: String = ClientIdentity().publicKeyBase64, exp: Int? = nil) throws -> PairingPayload {
        let hostsJSON = hosts.map { "\"\($0)\"" }.joined(separator: ",")
        let json = #"{"v":2,"name":"Owned source","hosts":[\#(hostsJSON)],"port":18765,"key":"\#(key)","nonce":"AAAAAAAAAAAAAAAAAAAAAA","exp":\#(exp ?? Int(Date().timeIntervalSince1970) + 300),"proto":1}"#
        return try PairingPayload(scannedValue: "remi://pair#" + RelayCrypto.b64(Data(json.utf8)))
    }

    @Test func typedDraftRetainsAllCandidatesAndLabelFallback() throws {
        let decoded = try payload()
        let draft = AddMachineDraft()
        draft.host = "remi://pair#code"
        #expect(draft.makeEndpoint() == nil)
        #expect(draft.submissionIssue == .pairingCodeRequiresForm)
        draft.mode = .pairingCode
        let json = #"{"v":2,"name":"Owned source","hosts":["192.168.1.23","100.101.102.103"],"port":18765,"key":"\#(decoded.daemonPublicKey)","nonce":"AAAAAAAAAAAAAAAAAAAAAA","exp":\#(Int(decoded.expiresAt.timeIntervalSince1970)),"proto":1}"#
        draft.pairingCode = "remi://pair#" + RelayCrypto.b64(Data(json.utf8))
        let request = try #require(draft.makeRequest(proposedLabel: "bad\nlabel", fallbackLabel: "iPhone"))
        guard case .pairing(let actual, let label) = request else { Issue.record("QR became a manual endpoint"); return }
        #expect(actual == decoded)
        #expect(actual.candidateEndpoints(pairingLabel: label).count == 2)
        #expect(label == "iPhone")
        draft.pairingCode = "not a code"
        #expect(draft.makeRequest(proposedLabel: "Mac", fallbackLabel: "Mac") == nil)
        #expect(draft.submissionIssue == .invalidPairingCode(.notAPairingLink))
    }

    @Test func callbackOverflowInvalidatesQueuedHelloBeforeAdmission() async {
        let bridge = PairingCallbackBridge()
        for _ in 0..<128 { bridge.yield(.state(.connecting(attempt: 1))) }
        bridge.yield(.state(.connected(sessionId: nil)))
        #expect(bridge.didOverflow)
        var acted = false
        _ = bridge.ifValid { acted = true }
        #expect(!acted)
        var count = 0
        for await _ in bridge.stream { count += 1 }
        #expect(count == 128)
    }

    @Test(arguments: MachineConnectionPreference.allCases)
    func strictPolicyAndPendingPersistence(preference: MachineConnectionPreference) throws {
        let decoded = try payload()
        let first = decoded.endpoint.withoutPairingContext
        let key = try #require(Data(base64Encoded: decoded.daemonPublicKey))
        let id = try MachineIdentityVerifier.machineID(forPublicKey: key)
        let profile = MachineRouteProfile(machineID: id, routes: [first], displayName: "Alias",
            connectionPreference: preference, machinePublicKey: RelayCrypto.b64(key))
        let store = MachineStore(profiles: [profile], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        let before = store.persistableProfiles
        let attempt = store.beginPairing(decoded, label: "iPhone")
        #expect(store.persistableProfiles == before)
        #expect(store.machines.count == 1)
        if preference == .relayOnly {
            guard case .failed = store.pairingAttempt(id: attempt)?.phase else { Issue.record("Relay lock admitted direct QR"); return }
        }
        store.cancelPairing(attempt)
        #expect(store.machines.first?.displayName == "Alias")
        #expect(store.machines.first?.connectionPreference == preference)
        store.stop()
    }

    @Test func conflictsAndAmbiguityRefuseBeforeCreatingTransport() throws {
        let decoded = try payload()
        let other = ClientIdentity()
        let route = MachineEndpoint(host: decoded.endpoint.host, port: decoded.endpoint.port,
            expectedFingerprint: other.fingerprint, expectedPublicKey: other.publicKeyBase64)
        for endpoints in [[route], [decoded.endpoint.withoutPairingContext, decoded.candidateEndpoints(pairingLabel: "Mac")[1].withoutPairingContext]] {
            let store = MachineStore(endpoints: endpoints, identity: ClientIdentity(), clientVersion: "test", clientId: "test")
            let id = store.beginPairing(decoded, label: "Mac")
            guard case .failed = store.pairingAttempt(id: id)?.phase else { Issue.record("Conflicting authority was dialed"); return }
            #expect(store.ownedPairingCoordinator == nil)
            #expect(store.connectionGenerations.isEmpty)
            store.stop()
        }
    }

    @Test func pendingLifetimeEndsOnLayerChangeForgetSuspensionAndReplacement() throws {
        let decoded = try payload()
        for change in ["layer", "forget", "suspend", "stop", "replace"] {
            let store = MachineStore(endpoints: [decoded.endpoint.withoutPairingContext], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
            let id = store.beginPairing(decoded, label: "Mac")
            switch change {
            case "layer": store.setConnectionPreference(.tailscaleOnly, for: decoded.endpoint)
            case "forget": _ = store.removeMachine(decoded.endpoint)
            case "suspend": store.suspendForegroundConnections()
            case "stop": store.stop()
            default: _ = store.beginPairing(decoded, label: "Mac")
            }
            #expect(store.pairingAttempt(id: id)?.phase == .cancelled)
            #expect(store.persistableProfiles.allSatisfy { $0.routes.allSatisfy { $0.pairingNonce == nil } })
            store.stop()
        }
    }

    /// Post-verification Store boundary, separate from the real source acceptance below.
    @Test func refreshRetiresPendingAnswerAndResumeWithoutReplaying() async throws {
        var directory = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { directory.deleteLastPathComponent() }
        let fixtures = directory.appendingPathComponent("shared/tests/fixtures/protocol")
        let hello = try JSONDecoder().decode(HelloAckMessage.self, from: Data(contentsOf: fixtures.appendingPathComponent("hello_ack_legacy.json")))
        let question = try JSONDecoder().decode(QuestionMessage.self, from: Data(contentsOf: fixtures.appendingPathComponent("question.json")))
        let key = ClientIdentity().publicKeyRaw
        let listener = try ownedTCPListener()
        let alternative = try ownedTCPListener()
        defer { Darwin.close(listener.0); Darwin.close(alternative.0) }
        let pin = try RelayMachinePin(relayURL: "wss://127.0.0.1:\(listener.1)", machinePublicKey: RelayCrypto.b64(key))
        for isRelay in [false, true] {
            let endpoint = MachineEndpoint(host: "127.0.0.1", port: listener.1, relayPin: isRelay ? pin : nil)
            let profile = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
                routes: [endpoint], machinePublicKey: RelayCrypto.b64(key))
            let store = MachineStore(profiles: [profile], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
            store.start()
            let route = try #require(store.connectionGenerations.keys.first)
            let generation = try #require(store.connectionGenerations[route])
            store.receive(.hello(hello, authorityPublicKey: key), from: route, generation: generation)
            store.receive(.question(question), from: route, generation: generation)
            if isRelay {
                store.answer(sessionId: question.sessionId, questionId: question.question.id, answer: "yes")
                #expect(store.ownedPendingAnswerCount == 1)
            } else {
                store.resumeSession(on: route, sessionId: "00000000-0000-4000-8000-000000000000")
                #expect(store.ownedResumeRequestIDs.count == 1)
            }
            let direct = MachineEndpoint(host: "127.0.0.1", port: alternative.1, expectedPublicKey: key.base64EncodedString())
            let newConnection = RemiConnection(configuration: .init(url: try #require(direct.webSocketURL),
                clientVersion: "test", clientId: "test"), identity: ClientIdentity(), stateHandler: { _ in }, eventHandler: { _ in })
            let origin = MachineStore.PairingOrigin(lifetime: try #require(store.machines.first?.pairingLifetime), preference: .automatic)
            let adopted = store.admitPairing(newConnection, endpoint: direct, hints: [direct], hello: hello,
                authority: key, origin: origin, preference: .automatic)
            #expect(store.ownedPendingAnswerCount == 0)
            #expect(store.ownedResumeRequestIDs.isEmpty)
            #expect(store.connectionGenerations[route] == nil)
            #expect(store.connectionGenerations[direct] == adopted.generation)
            #expect(store.latestOperationError?.contains(isRelay ? "uncertain" : "pairing connection changed") == true)
            store.receive(.hello(hello, authorityPublicKey: key), from: route, generation: generation)
            #expect(store.connectionGenerations[route] == nil)
            #expect(store.ownedPendingAnswerCount == 0 && store.ownedResumeRequestIDs.isEmpty)
            store.stop()
            await newConnection.stop()
        }
    }

    private func ownedTCPListener() throws -> (Int32, Int) {
        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        try #require(fd >= 0)
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, Darwin.listen(fd, 4) == 0 else { Darwin.close(fd); throw CocoaError(.fileReadUnknown) }
        var size = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.getsockname(fd, $0, &size) }
        }
        guard named == 0 else { Darwin.close(fd); throw CocoaError(.fileReadUnknown) }
        return (fd, Int(UInt16(bigEndian: address.sin_port)))
    }

    @Test func rapidReplacementWaitsForInheritedSocketRetirement() async throws {
        let listener = try ownedTCPListener()
        defer { Darwin.close(listener.0) }
        let key = ClientIdentity().publicKeyRaw
        let machineID = try MachineIdentityVerifier.machineID(forPublicKey: key)
        let endpoint = MachineEndpoint(host: "127.0.0.1", port: listener.1, expectedPublicKey: key.base64EncodedString())
        let gate = OwnedRetirementGate()
        let prior = Task<Void, Never> {
            while !gate.released { try? await Task.sleep(for: .milliseconds(10)) }
        }
        func coordinator() -> PairingAttemptCoordinator {
            PairingAttemptCoordinator(id: UUID(), candidates: [endpoint], authority: key, machineID: machineID,
                deadline: Date().addingTimeInterval(10), identity: ClientIdentity(), clientVersion: "test", clientID: "test",
                validate: {}, publish: { _ in }, admit: { _, _, _, _ in throw RelayFailure.closed }, forward: { _, _ in })
        }
        let second = coordinator()
        second.start(after: prior)
        let retiredSecond = second.cancel()
        let third = coordinator()
        third.start(after: retiredSecond)
        try await Task.sleep(for: .milliseconds(50))
        #expect(third.ownedAttemptedAddresses.isEmpty)
        gate.released = true
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while third.ownedAttemptedAddresses.isEmpty, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(third.ownedAttemptedAddresses == [endpoint.displayAddress])
        await third.cancel().value
        await retiredSecond.value
    }

    @Test func terminalHistoryIsBoundedWithoutPayloads() throws {
        let decoded = try payload()
        let store = MachineStore(endpoints: [], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        for _ in 0..<12 {
            let id = store.beginPairing(decoded, label: "Mac", newProfilePreference: .relayOnly)
            #expect(store.pairingAttempt(id: id)?.phase.isTerminal == true)
        }
        #expect(store.pairingAttempts.count == 8)
        #expect(store.persistableProfiles.isEmpty)
    }
}

#if os(macOS)
@MainActor
private final class PairingSourceFixture {
    let process = Process()
    let input = Pipe(), output = Pipe()
    let directory: URL
    private var buffer = Data()
    init(mode: String) throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-swift-pairing-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        process.executableURL = URL(fileURLWithPath: "/Volumes/S1/yooz/remi/cache/tools/bun-1.3.11-darwin-arm64")
        process.arguments = [URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/pairing-source-fixture.ts").path, mode]
        process.currentDirectoryURL = directory
        process.environment = ["HOME": directory.path,
            "PATH": "/private/tmp/remi-1570-tools:/usr/bin:/bin", "TMPDIR": "/private/tmp"]
        if mode == "v2" {
            process.environment?["REMI_NATIVE_PAIRING_LOCAL"] = ProcessInfo.processInfo.environment["REMI_NATIVE_PAIRING_LOCAL"]
            process.environment?["REMI_NATIVE_PAIRING_TAIL"] = ProcessInfo.processInfo.environment["REMI_NATIVE_PAIRING_TAIL"]
        }
        process.standardInput = input; process.standardOutput = output; process.standardError = FileHandle.standardError
        try process.run()
        guard fcntl(output.fileHandleForReading.fileDescriptor, F_SETFL, O_NONBLOCK) != -1 else { throw CocoaError(.fileReadUnknown) }
    }
    func send(_ text: String) throws { try input.fileHandleForWriting.write(contentsOf: Data((text + "\n").utf8)) }
    func message() async throws -> [String: Any] {
        let deadline = ContinuousClock.now.advanced(by: .seconds(20))
        while ContinuousClock.now < deadline {
            if let end = buffer.firstIndex(of: 10) {
                let line = Data(buffer[..<end]); buffer.removeSubrange(...end)
                return try #require(JSONSerialization.jsonObject(with: line) as? [String: Any])
            }
            var bytes = [UInt8](repeating: 0, count: 8192)
            let count = Darwin.read(output.fileHandleForReading.fileDescriptor, &bytes, bytes.count)
            if count > 0 { buffer.append(contentsOf: bytes.prefix(count)) }
            else if count == 0 || (errno != EAGAIN && errno != EINTR) { throw CocoaError(.fileReadUnknown) }
            else { try await Task.sleep(for: .milliseconds(20)) }
        }
        throw CocoaError(.fileReadUnknown)
    }
    func stop() async {
        try? input.fileHandleForWriting.close()
        let end = ContinuousClock.now.advanced(by: .seconds(8))
        while process.isRunning, ContinuousClock.now < end { try? await Task.sleep(for: .milliseconds(20)) }
        if process.isRunning { process.terminate() }
        let terminated = ContinuousClock.now.advanced(by: .seconds(3))
        while process.isRunning, ContinuousClock.now < terminated { try? await Task.sleep(for: .milliseconds(20)) }
        #expect(!process.isRunning)
        try? output.fileHandleForReading.close()
        if !process.isRunning {
            #expect(process.terminationStatus == 0)
            try? FileManager.default.removeItem(at: directory)
        }
    }
}

@MainActor
@Suite(.serialized) struct PairingSourceTests {
    private func wait(_ check: () -> Bool, seconds: Int = 8) async throws {
        let end = ContinuousClock.now.advanced(by: .seconds(seconds))
        while !check(), ContinuousClock.now < end { try await Task.sleep(for: .milliseconds(15)) }
        try #require(check(), "Owned source condition did not finish before its deadline")
    }

    @Test func sourceApprovalAdoptsSameSocketClearsClaimAndPersistsFullPin() async throws {
        let fixture = try PairingSourceFixture(mode: "approve")
        let store = MachineStore(endpoints: [], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        do {
            let info = try await fixture.message()
            let link = try #require(info["link"] as? String)
            let payload = try PairingPayload(scannedValue: link)
            let id = store.beginPairing(payload, label: "Owned phone")
            #expect(store.persistableProfiles.isEmpty)
            try await wait { store.pairingAttempt(id: id)?.phase.isTerminal == true }
            try await wait { store.machines.first?.hasLoadedSessions == true }
            let machine = try #require(store.machines.first)
            #expect(store.pairingAttempt(id: id)?.phase == .admitted(profileID: machine.id))
            #expect(machine.status == .connected)
            #expect(machine.hasLoadedSessions)
            let config = try #require(store.ownedPairingCoordinator?.ownedAdmittedConfiguration)
            #expect(config.pairingNonce == nil && config.pairingLabel == nil)
            #expect(config.directRetryPolicy == .runtime)
            #expect(config.expectedServerPublicKey == payload.daemonPublicKey)
            #expect(config.directConnectTimeout == .seconds(5) && config.directAuthenticationTimeout == .seconds(30))
            #expect(config.directHelloTimeout == .seconds(5))
            #expect(store.persistableProfiles.first?.machinePublicKey == RelayCrypto.b64(Data(base64Encoded: payload.daemonPublicKey)!))
            #expect(store.persistableEndpoints.allSatisfy { $0.pairingNonce == nil && $0.pairingLabel == nil })
            try fixture.send("receipts")
            let receipts = try await fixture.message()
            #expect(receipts["authorized"] as? Int == 1)
            #expect(receipts["label"] as? String == "Owned phone")
            store.stop(); await fixture.stop()
        } catch { store.stop(); await fixture.stop(); throw error }
    }

    @Test(arguments: ["pending", "queue", "store"])
    func actualRetryCodesStayOnCandidateThenAdmit(mode: String) async throws {
        let fixture = try PairingSourceFixture(mode: mode)
        let store = MachineStore(endpoints: [], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        do {
            let info = try await fixture.message()
            let payload = try PairingPayload(scannedValue: #require(info["link"] as? String))
            let id = store.beginPairing(payload, label: "Owned phone")
            let code = mode == "pending" ? "PAIRING_PENDING" : mode == "queue" ? "PENDING_QUEUE_FULL" : "AUTH_STORE_ERROR"
            try await wait({
                if case .retrying(let actual) = store.pairingAttempt(id: id)?.phase { return actual.hasPrefix(code) }
                return false
            }, seconds: 25)
            #expect(store.persistableProfiles.isEmpty)
            #expect(store.pairingAttempt(id: id)?.address == payload.endpoint.displayAddress)
            try fixture.send(mode == "pending" ? "approve" : "recover")
            try await wait { store.pairingAttempt(id: id)?.phase.isTerminal == true }
            #expect(store.machines.count == 1)
            #expect(store.machines.first?.status == .connected)
            store.stop(); await fixture.stop()
        } catch { store.stop(); await fixture.stop(); throw error }
    }

    @Test(arguments: ["cancel", "suspend", "forget", "layer"])
    func lateVerifiedHelloCannotAdmitRetiredAttempt(change: String) async throws {
        let fixture = try PairingSourceFixture(mode: "approve")
        var store: MachineStore?
        do {
            let info = try await fixture.message()
            let payload = try PairingPayload(scannedValue: #require(info["link"] as? String))
            let existing = MachineEndpoint(host: payload.endpoint.host, port: payload.endpoint.port)
            let current = MachineStore(endpoints: [existing], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
            store = current
            current.ownedBeforePairingAdmission = {
                switch change {
                case "cancel": if let id = current.pairingAttempts.last?.id { current.cancelPairing(id) }
                case "suspend": current.suspendForegroundConnections()
                case "forget":
                    _ = current.removeMachine(existing)
                    current.addMachine(existing) // same key/address, different profile lifetime
                default: current.setConnectionPreference(.relayOnly, for: existing)
                }
            }
            let id = current.beginPairing(payload, label: "Owned phone")
            try await wait { current.pairingAttempt(id: id)?.phase.isTerminal == true }
            #expect(current.pairingAttempt(id: id)?.phase == .cancelled)
            #expect(!current.pairingAttempts.contains { if case .admitted = $0.phase { true } else { false } })
            current.stop(); await fixture.stop()
        } catch { store?.stop(); await fixture.stop(); throw error }
    }

    @Test func coordinatorFallbackUsesRealSourceHubAndStore() async throws {
        let fixture = try PairingSourceFixture(mode: "approve")
        let store = MachineStore(endpoints: [], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        var coordinator: PairingAttemptCoordinator?
        do {
            let info = try await fixture.message()
            let payload = try PairingPayload(scannedValue: #require(info["link"] as? String))
            let key = try #require(Data(base64Encoded: payload.daemonPublicKey))
            let machineID = try MachineIdentityVerifier.machineID(forPublicKey: key)
            let failed = MachineEndpoint(host: "127.0.0.1", port: try #require(info["closedPort"] as? Int),
                expectedPublicKey: payload.daemonPublicKey, pairingNonce: payload.nonce, pairingLabel: "Owned phone")
            let live = payload.candidateEndpoints(pairingLabel: "Owned phone")[0]
            var states: [PairingAttemptState] = []
            let owner = PairingAttemptCoordinator(id: UUID(), candidates: [failed, live], authority: key, machineID: machineID,
                deadline: payload.expiresAt, identity: ClientIdentity(), clientVersion: "test", clientID: "test", validate: {},
                publish: { states.append($0) }, admit: { connection, endpoint, hello, key in
                    store.admitPairing(connection, endpoint: endpoint, hints: [failed.withoutPairingContext, live.withoutPairingContext],
                        hello: hello, authority: key, origin: nil, preference: .automatic)
                }, forward: { callback, adopted in
                    switch callback {
                    case .state(let state): store.receive(state, from: adopted.endpoint, generation: adopted.generation)
                    case .event(let event): store.receive(event, from: adopted.endpoint, generation: adopted.generation)
                    case .authenticationRetry: break
                    }
                })
            coordinator = owner
            owner.start(after: nil)
            try await wait { states.last?.phase.isTerminal == true }
            #expect(states.contains { $0.address == failed.displayAddress })
            #expect(states.last?.phase == .admitted(profileID: live.id))
            #expect(store.persistableProfiles.first?.routes.count == 2)
            #expect(store.machines.first?.endpoint == live.withoutPairingContext)
            store.stop(); await fixture.stop()
        } catch { coordinator?.cancel(); store.stop(); await fixture.stop(); throw error }
    }

    @Test(arguments: ["wrong-key", "cancelled", "expired", "noauth"])
    func identityAndAuthRefusalsNeverAdvance(mode: String) async throws {
        let fixture = try PairingSourceFixture(mode: mode)
        var coordinator: PairingAttemptCoordinator?
        do {
            let info = try await fixture.message()
            let payload = try PairingPayload(scannedValue: #require(info["link"] as? String))
            let key = mode == "wrong-key" ? ClientIdentity().publicKeyRaw : try #require(Data(base64Encoded: payload.daemonPublicKey))
            let machineID = try MachineIdentityVerifier.machineID(forPublicKey: key)
            let first = MachineEndpoint(host: payload.endpoint.host, port: payload.endpoint.port,
                expectedPublicKey: key.base64EncodedString(), pairingNonce: payload.nonce, pairingLabel: "Owned phone")
            let next = MachineEndpoint(host: "127.0.0.1", port: try #require(info["closedPort"] as? Int), expectedPublicKey: key.base64EncodedString())
            var states: [PairingAttemptState] = []
            let owner = PairingAttemptCoordinator(id: UUID(), candidates: [first, next], authority: key, machineID: machineID,
                deadline: payload.expiresAt, identity: ClientIdentity(), clientVersion: "test", clientID: "test", validate: {},
                publish: { states.append($0) }, admit: { _, _, _, _ in
                    Issue.record("Refused source reached Store admission")
                    throw RelayFailure.closed
                }, forward: { _, _ in Issue.record("Refused source forwarded domain traffic") })
            coordinator = owner
            owner.start(after: nil)
            try await wait { states.last?.phase.isTerminal == true }
            guard case .failed = states.last?.phase else {
                Issue.record("Refusal was not terminal"); coordinator?.cancel(); await fixture.stop(); return
            }
            #expect(!states.contains { $0.address == next.displayAddress })
            await fixture.stop()
        } catch { coordinator?.cancel(); await fixture.stop(); throw error }
    }

    @Test func originalExpiryBoundsTheEntireAttempt() async throws {
        let fixture = try PairingSourceFixture(mode: "pending")
        let store = MachineStore(endpoints: [], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        do {
            let info = try await fixture.message()
            let original = try PairingPayload(scannedValue: #require(info["link"] as? String))
            let json = #"{"v":1,"name":"Owned source","host":"127.0.0.1","port":\#(original.endpoint.port),"key":"\#(original.daemonPublicKey)","nonce":"\#(original.nonce)","exp":\#(Int(Date().timeIntervalSince1970) - 118),"proto":1}"#
            let bounded = try PairingPayload(scannedValue: "remi://pair#" + RelayCrypto.b64(Data(json.utf8)))
            let id = store.beginPairing(bounded, label: "Owned phone")
            try await wait { store.pairingAttempt(id: id)?.phase.isTerminal == true }
            guard case .failed(let reason) = store.pairingAttempt(id: id)?.phase else {
                Issue.record("Expired pending attempt admitted"); store.stop(); await fixture.stop(); return
            }
            #expect(reason.contains("expired"))
            #expect(store.persistableProfiles.isEmpty)
            store.stop(); await fixture.stop()
        } catch { store.stop(); await fixture.stop(); throw error }
    }

    @Test func refreshPreservesAliasPolicyRelayHintAndNavigationAcrossReload() async throws {
        let fixture = try PairingSourceFixture(mode: "approve")
        var store: MachineStore?
        let configurationKey = "remi.pairing.refresh.\(UUID())"
        defer { UserDefaults.standard.removeObject(forKey: configurationKey) }
        do {
            let info = try await fixture.message()
            let payload = try PairingPayload(scannedValue: #require(info["link"] as? String))
            let key = try #require(Data(base64Encoded: payload.daemonPublicKey))
            let pin = try RelayMachinePin(relayURL: "wss://relay.example.test", machinePublicKey: RelayCrypto.b64(key))
            let relay = MachineEndpoint(host: "relay.example.test", port: 443, relayPin: pin)
            let profile = MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
                routes: [relay], displayName: "Keep alias", connectionPreference: .localOnly, machinePublicKey: RelayCrypto.b64(key))
            let current = MachineStore(profiles: [profile], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
            store = current
            let id = current.beginPairing(payload, label: "Owned phone")
            try await wait { current.pairingAttempt(id: id)?.phase.isTerminal == true }
            #expect(current.pairingAttempt(id: id)?.phase == .admitted(profileID: relay.id))
            let machine = try #require(current.machines.first)
            #expect(machine.id == relay.id && machine.displayName == "Keep alias")
            #expect(machine.connectionPreference == .localOnly)
            #expect(machine.routes.first?.relayPin == pin)
            #expect(current.connectionGenerations.count == 1)
            let configuration = MachineConfigurationStore(key: configurationKey)
            configuration.saveProfiles(current.persistableProfiles)
            let loaded = try configuration.loadProfilesValidated()
            let restored = MachineStore(profiles: loaded, identity: ClientIdentity(), clientVersion: "test", clientId: "test")
            #expect(restored.machines.first?.id == relay.id)
            #expect(restored.machines.first?.displayName == "Keep alias")
            #expect(restored.machines.first?.routes.count == 2)
            current.stop(); await fixture.stop()
        } catch { store?.stop(); await fixture.stop(); throw error }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_NATIVE_PAIRING_LOCAL"] != nil
        && ProcessInfo.processInfo.environment["REMI_NATIVE_PAIRING_TAIL"] != nil,
        "Requires two explicitly selected existing owned interfaces; no network administration."), arguments: MachineConnectionPreference.allCases)
    func v2SamePortLocalRefusalThenTailscaleAdmissionThroughStore(preference: MachineConnectionPreference) async throws {
        let fixture = try PairingSourceFixture(mode: "v2")
        let store = MachineStore(endpoints: [], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        do {
            let info = try await fixture.message()
            let payload = try PairingPayload(scannedValue: #require(info["link"] as? String))
            #expect(payload.version == 2)
            let candidates = payload.candidateEndpoints(pairingLabel: "Owned phone")
            #expect(candidates.count == 2 && candidates[0].port == candidates[1].port)
            #expect(candidates.map(\.connectionLayer) == [.local, .tailscale])
            let id = store.beginPairing(payload, label: "Owned phone", newProfilePreference: preference)
            #expect(store.persistableProfiles.isEmpty)
            try await wait { store.pairingAttempt(id: id)?.phase.isTerminal == true }
            if preference == .localOnly || preference == .relayOnly {
                guard case .failed = store.pairingAttempt(id: id)?.phase else {
                    Issue.record("Strict layer escaped its pairing policy"); store.stop(); await fixture.stop(); return
                }
                let expected = preference == .localOnly ? [candidates[0].displayAddress] : []
                #expect((store.ownedPairingCoordinator?.ownedAttemptedAddresses ?? []) == expected)
                #expect(store.persistableProfiles.isEmpty)
                store.stop(); await fixture.stop(); return
            }
            let machine = try #require(store.machines.first)
            #expect(store.pairingAttempt(id: id)?.phase == .admitted(profileID: machine.id))
            #expect(machine.endpoint == candidates[1].withoutPairingContext)
            let attempted = preference == .tailscaleOnly ? [candidates[1].displayAddress] : candidates.map(\.displayAddress)
            #expect(store.ownedPairingCoordinator?.ownedAttemptedAddresses == attempted)
            #expect(machine.routes.count == 2)
            #expect(machine.routes.allSatisfy { $0.expectedPublicKey == payload.daemonPublicKey && $0.pairingNonce == nil })
            try fixture.send("receipts")
            let receipt = try await fixture.message()
            #expect(receipt["authorized"] as? Int == 1)
            #expect(receipt["claim"] as? String == store.publicIdentity.fingerprint)
            store.stop(); await fixture.stop()
        } catch { store.stop(); await fixture.stop(); throw error }
    }

    @Test func authDisabledSourceNeverAdmitsPinnedQR() async throws {
        let fixture = try PairingSourceFixture(mode: "noauth")
        let store = MachineStore(endpoints: [], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        do {
            let info = try await fixture.message()
            let payload = try PairingPayload(scannedValue: #require(info["link"] as? String))
            let id = store.beginPairing(payload, label: "Owned phone")
            try await wait { store.pairingAttempt(id: id)?.phase.isTerminal == true }
            guard case .failed = store.pairingAttempt(id: id)?.phase else {
                Issue.record("No-auth source admitted QR"); store.stop(); await fixture.stop(); return
            }
            #expect(store.persistableProfiles.isEmpty)
            store.stop(); await fixture.stop()
        } catch { store.stop(); await fixture.stop(); throw error }
    }
}
#endif
