import Foundation
import Testing
@testable import RemiKit

#if os(macOS)
private actor OwnedChildSignGate {
    private(set) var entered = false
    private var released = false
    func hold() async {
        entered = true
        while !released { try? await Task.sleep(for: .milliseconds(5)) }
    }
    func open() { released = true }
}

@MainActor
@Suite(.serialized)
struct DirectChildKeyIntegrationTests {
    private func fixture(_ name: String, port: Int, requestID: String? = nil) throws -> Data {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("shared/tests/fixtures/protocol/\(name).json")
        var value = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        if name == "session_list_response" { value["daemonPorts"] = [port]; value["sessions"] = [] as [String] }
        else { value["port"] = port }
        if let requestID { value["requestId"] = requestID }
        return try JSONSerialization.data(withJSONObject: value)
    }

    @Test(arguments: ["discovery-matching", "discovery-wrong", "create-matching", "create-wrong", "resume-matching", "resume-wrong", "discovery-legacy", "childfirst-legacy", "earlydiscovery-wrong", "earlycreate-wrong", "earlydiscovery-matching", "earlycreate-matching", "earlydiscovery-legacy", "waitingdiscovery-matching", "waitingdiscovery-wrong", "waitingcreate-matching", "waitingcreate-wrong", "waitingforget-matching", "stale-matching"])
    func childUsesAuthenticatedParentKey(_ scenario: String) async throws {
        let pieces = scenario.split(separator: "-")
        let action = String(pieces[0]), mode = String(pieces[1])
        let early = action.hasPrefix("early")
        let waiting = action.hasPrefix("waiting")
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/direct-child-key-peer.ts")
        let peer = Process(), input = Pipe(), output = Pipe()
        let wireMode = waiting ? (mode == "wrong" ? "rootheld-wrong" : "rootheld") : mode
        let folder = try OwnedRecoveryFixture.configure(peer, script: script, arguments: [wireMode, "stats.json"])
        peer.standardInput = input; peer.standardOutput = output; peer.standardError = FileHandle.standardError
        try peer.run()
        func cleanup() async {
            try? input.fileHandleForWriting.close()
            let deadline = ContinuousClock.now.advanced(by: .seconds(3))
            while peer.isRunning && ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(20)) }
            if peer.isRunning { peer.terminate() }
            let end = ContinuousClock.now.advanced(by: .seconds(2))
            while peer.isRunning && ContinuousClock.now < end { try? await Task.sleep(for: .milliseconds(20)) }
            #expect(!peer.isRunning, "Owned peer must exit")
            if !peer.isRunning { try? FileManager.default.removeItem(at: folder) }
        }
        var store: MachineStore?
        let parentHelloGate = OwnedChildSignGate()
        do {
            var line = Data()
            for try await byte in output.fileHandleForReading.bytes { if byte == 10 { break }; line.append(byte) }
            let info = try #require(JSONSerialization.jsonObject(with: line) as? [String: Any])
            let rootPort = try #require(info["rootPort"] as? Int)
            let childPort = try #require(info["childPort"] as? Int)
            let publicKey = try #require(info["publicKey"] as? String)
            let machineID = try #require(info["machineID"] as? String)
            #expect(publicKey.contains("+") && publicKey.contains("/") && publicKey.hasSuffix("="))
            let root = MachineEndpoint(host: "127.0.0.1", port: rootPort, expectedPublicKey: mode == "legacy" ? nil : publicKey,
                pairingNonce: "owned-only", pairingLabel: "synthetic")
            let subject: MachineStore
            if mode == "legacy" {
                subject = MachineStore(endpoints: [root], identity: ClientIdentity(), clientVersion: "test", clientId: "owned")
            } else {
                let profile = MachineRouteProfile(machineID: machineID, routes: [root], machinePublicKey: RelayCrypto.b64(try #require(Data(base64Encoded: publicKey))))
                subject = MachineStore(profiles: [profile], identity: ClientIdentity(), clientVersion: "test", clientId: "owned")
            }
            store = subject
            if early { subject.ownedBeforeParentHello = { await parentHelloGate.hold() } }
            subject.start()
            let activeRoot = try #require(subject.machines.first?.endpoint)
            let statsFile = folder.appendingPathComponent("stats.json")
            func stats() throws -> [String: Int] {
                try #require(JSONSerialization.jsonObject(with: Data(contentsOf: statsFile)) as? [String: Int])
            }
            let rootDeadline = ContinuousClock.now.advanced(by: .seconds(5))
            if waiting {
                while try stats()["rootHelloHeld", default: 0] == 0 && ContinuousClock.now < rootDeadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
                try #require(try stats()["rootHelloHeld"] == 1, "The authenticated root Hello must be held on the peer")
            } else {
                while subject.machines.first?.status != .connected && ContinuousClock.now < rootDeadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
                try #require(subject.machines.first?.status == .connected, "Real root must authenticate before dispatch")
            }
            if early {
                while !(await parentHelloGate.entered) && ContinuousClock.now < rootDeadline { try await Task.sleep(for: .milliseconds(10)) }
                try #require(await parentHelloGate.entered, "Verified parent Hello must be held before Store processing")
            }
            let rootGeneration = try #require(subject.connectionGenerations[activeRoot])
            if action == "waitingforget" {
                let response = try JSONDecoder().decode(SessionListResponse.self, from: fixture("session_list_response", port: childPort))
                subject.receive(.sessions(response), from: activeRoot, generation: rootGeneration)
                #expect(try stats()["childOpens"] == 0)
                _ = subject.removeMachine(activeRoot)
                subject.addMachine(activeRoot)
                try input.fileHandleForWriting.write(contentsOf: Data("release-root\n".utf8))
                try await Task.sleep(for: .milliseconds(300))
                #expect(try stats()["childOpens"] == 0, "Forget and re-pair must retire the earlier pending child")
                #expect(!subject.ownedParentRoutes.keys.contains(where: { $0.port == childPort }))
                subject.stop()
                await cleanup()
                return
            }
            if action == "stale" {
                let oldEpoch = try #require(subject.ownedParentEpoch(activeRoot))
                subject.ownedResetParentHello(activeRoot)
                let question = try JSONDecoder().decode(QuestionMessage.self, from: FixtureConformanceTests.fixture("question"))
                subject.receive(.question(question), from: activeRoot, generation: rootGeneration, callbackEpoch: oldEpoch)
                #expect(subject.machines.first?.questions.contains(where: { $0.question.id == question.question.id }) == true,
                    "A delivered question must survive delayed Store dispatch")
                let response = try JSONDecoder().decode(CreateSessionResponseMessage.self, from: fixture("create_session_response", port: childPort))
                subject.receive(.createSessionResponse(response), from: activeRoot, generation: rootGeneration, callbackEpoch: oldEpoch)
                #expect(subject.latestOperationError != nil)
                #expect(try stats()["childOpens"] == 0)
                subject.stop()
                await cleanup()
                return
            }
            switch action {
            case "discovery", "childfirst", "earlydiscovery", "waitingdiscovery":
                let response = try JSONDecoder().decode(SessionListResponse.self, from: fixture("session_list_response", port: childPort))
                subject.receive(.sessions(response), from: activeRoot, generation: rootGeneration)
            case "create", "earlycreate", "waitingcreate":
                let response = try JSONDecoder().decode(CreateSessionResponseMessage.self, from: fixture("create_session_response", port: childPort))
                subject.receive(.createSessionResponse(response), from: activeRoot, generation: rootGeneration)
            case "resume":
                subject.resumeSession(on: activeRoot, sessionId: "fixture-session-id")
                let requestID = try #require(subject.ownedResumeRequestIDs.first)
                let response = try JSONDecoder().decode(ResumeSessionResponseMessage.self, from: fixture("resume_session_response_child", port: childPort, requestID: requestID))
                subject.receive(.resumeSessionResponse(response), from: activeRoot, generation: rootGeneration)
            default: Issue.record("Unknown scenario")
            }
            if waiting {
                try await Task.sleep(for: .milliseconds(150))
                #expect(try stats()["childOpens"] == 0, "The child intent must wait until the parent Hello")
                try input.fileHandleForWriting.write(contentsOf: Data("release-root\n".utf8))
            }
            if early {
                try await Task.sleep(for: .milliseconds(150))
                if mode == "wrong" {
                    #expect(try stats()["childAuth"] == 0, "A delayed parent Hello must not let a wrong child obtain a signature")
                }
                await parentHelloGate.open()
            }
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while ContinuousClock.now < deadline {
                let current = try stats()
                if mode != "wrong", current["childHello", default: 0] > 0,
                   subject.ownedSessionRoutes.values.contains(where: { $0.port == childPort }) { break }
                if mode == "wrong", current["childAuth", default: 0] > 0 || subject.machines.first?.sessionConnectionIssue != nil { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            let observed = try stats()
            #expect(observed["rootAuth"] == (mode == "legacy" ? 0 : 1))
            #expect(observed["childOpens"] == 1)
            #expect(observed["childPairing"] == 0)
            #expect(observed["childAuth"] == (mode == "wrong" ? 0 : 1), "Wrong child must never receive a signed auth response")
            #expect(observed["childHello"] == (mode == "wrong" ? 0 : 1))
            #expect(subject.ownedSessionRoutes.values.contains(where: { $0.port == childPort }) == (mode != "wrong"))
            if action == "childfirst" {
                // The first child has authenticated, but an unauthenticated legacy
                // root cannot promote that child's key to parent authority.
                let otherPort = try #require(info["child2Port"] as? Int)
                let second = try JSONDecoder().decode(SessionListResponse.self, from: fixture("session_list_response", port: otherPort))
                subject.receive(.sessions(second), from: activeRoot, generation: rootGeneration)
                let secondDeadline = ContinuousClock.now.advanced(by: .seconds(5))
                while try stats()["child2Auth", default: 0] == 0 && ContinuousClock.now < secondDeadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
                #expect(try stats()["child2Auth"] == 1, "A child-first key must not become the legacy parent's pin")
            }
            subject.stop()
        } catch {
            await parentHelloGate.open()
            store?.stop()
            await cleanup()
            throw error
        }
        await cleanup()
    }

    @Test(arguments: ["discovery", "create", "resume", "pending"])
    func anotherParentCannotReuseChildSocket(_ action: String) async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/direct-child-key-peer.ts")
        let peer = Process(), input = Pipe(), output = Pipe()
        let folder = try OwnedRecoveryFixture.configure(peer, script: script, arguments: [action == "pending" ? "rootheld" : "matching", "stats.json"])
        peer.standardInput = input; peer.standardOutput = output; peer.standardError = FileHandle.standardError
        try peer.run()
        func cleanup() async {
            try? input.fileHandleForWriting.close()
            let deadline = ContinuousClock.now.advanced(by: .seconds(3))
            while peer.isRunning && ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(20)) }
            if peer.isRunning { peer.terminate() }
            let end = ContinuousClock.now.advanced(by: .seconds(2))
            while peer.isRunning && ContinuousClock.now < end { try? await Task.sleep(for: .milliseconds(20)) }
            #expect(!peer.isRunning)
            if !peer.isRunning { try? FileManager.default.removeItem(at: folder) }
        }
        var store: MachineStore?
        do {
            var line = Data()
            for try await byte in output.fileHandleForReading.bytes { if byte == 10 { break }; line.append(byte) }
            let info = try #require(JSONSerialization.jsonObject(with: line) as? [String: Any])
            let childPort = try #require(info["childPort"] as? Int)
            let firstKey = try #require(info["publicKey"] as? String), secondKey = try #require(info["otherPublicKey"] as? String)
            let first = MachineEndpoint(host: "127.0.0.1", port: try #require(info["rootPort"] as? Int), expectedPublicKey: firstKey)
            let second = MachineEndpoint(host: "127.0.0.1", port: try #require(info["root2Port"] as? Int), expectedPublicKey: secondKey)
            let profiles = try [(first, firstKey, "machineID"), (second, secondKey, "otherMachineID")].map { endpoint, key, id in
                MachineRouteProfile(machineID: try #require(info[id] as? String), routes: [endpoint],
                    machinePublicKey: RelayCrypto.b64(try #require(Data(base64Encoded: key))))
            }
            let subject = MachineStore(profiles: profiles, identity: ClientIdentity(), clientVersion: "test", clientId: "owned")
            store = subject
            subject.start()
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            let expectedConnected = action == "pending" ? 1 : 2
            while subject.machines.filter({ $0.status == .connected }).count != expectedConnected && ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            try #require(subject.machines.filter({ $0.status == .connected }).count == expectedConnected)
            let owner = try #require(subject.machines.first(where: { $0.endpoint.port == first.port })?.endpoint)
            let other = try #require(subject.machines.first(where: { $0.endpoint.port == second.port })?.endpoint)
            let ownerGeneration = try #require(subject.connectionGenerations[owner])
            let list = try JSONDecoder().decode(SessionListResponse.self, from: fixture("session_list_response", port: childPort))
            if action == "pending" {
                let statsFile = folder.appendingPathComponent("stats.json")
                func rootHeld() throws -> Bool {
                    let stats = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: statsFile)) as? [String: Int])
                    return stats["rootHelloHeld"] == 1
                }
                while try !rootHeld() && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
                try #require(try rootHeld())
            }
            subject.receive(.sessions(list), from: owner, generation: ownerGeneration)
            if action == "pending" {
                subject.receive(.sessions(list), from: other, generation: try #require(subject.connectionGenerations[other]))
                #expect(subject.latestOperationError != nil, "Another parent cannot claim a deferred child address")
                #expect(!subject.ownedParentRoutes.keys.contains(where: { $0.port == childPort }))
                try input.fileHandleForWriting.write(contentsOf: Data("release-root\n".utf8))
            }
            while !subject.ownedSessionRoutes.values.contains(where: { $0.port == childPort }) && ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            let child = try #require(subject.ownedParentRoutes.keys.first(where: { $0.port == childPort }))
            #expect(subject.ownedParentRoutes[child] == owner)
            try #require(subject.ownedSessionRoutes.values.contains(child))
            let childGeneration = try #require(subject.connectionGenerations[child])
            let otherGeneration = try #require(subject.connectionGenerations[other])
            switch action {
            case "pending": break
            case "discovery": subject.receive(.sessions(list), from: other, generation: otherGeneration)
            case "create":
                let response = try JSONDecoder().decode(CreateSessionResponseMessage.self, from: fixture("create_session_response", port: childPort))
                subject.receive(.createSessionResponse(response), from: other, generation: otherGeneration)
            case "resume":
                subject.resumeSession(on: other, sessionId: "fixture-session-id")
                let requestID = try #require(subject.ownedResumeRequestIDs.first)
                let response = try JSONDecoder().decode(ResumeSessionResponseMessage.self,
                    from: fixture("resume_session_response_child", port: childPort, requestID: requestID))
                subject.receive(.resumeSessionResponse(response), from: other, generation: otherGeneration)
            default: Issue.record("Unknown action")
            }
            try await Task.sleep(for: .milliseconds(300))
            #expect(subject.resumedSessionDestination == nil, "A different profile must not reuse the owner's child")
            #expect(subject.latestOperationError != nil, "A child address collision must be visible")
            #expect(subject.ownedParentRoutes[child] == owner && subject.connectionGenerations[child] == childGeneration)
            _ = subject.removeMachine(other)
            #expect(subject.ownedParentRoutes[child] == owner && subject.connectionGenerations[child] == childGeneration)
            subject.stop()
        } catch {
            store?.stop()
            await cleanup()
            throw error
        }
        await cleanup()
    }

    @Test(arguments: ["forget-peer", "repair-peer", "stop-peer", "forget-entered", "repair-entered", "stop-entered"])
    func retiredChildCannotAnswerHeldChallenge(_ scenario: String) async throws {
        let pieces = scenario.split(separator: "-")
        let retirement = String(pieces[0]), atSigner = pieces[1] == "entered"
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/direct-child-key-peer.ts")
        let peer = Process(), input = Pipe(), output = Pipe()
        let folder = try OwnedRecoveryFixture.configure(peer, script: script, arguments: [atSigner ? "matching" : "held", "stats.json"])
        peer.standardInput = input; peer.standardOutput = output; peer.standardError = FileHandle.standardError
        try peer.run()
        func cleanup() async {
            try? input.fileHandleForWriting.close()
            let deadline = ContinuousClock.now.advanced(by: .seconds(3))
            while peer.isRunning && ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(20)) }
            if peer.isRunning { peer.terminate() }
            let end = ContinuousClock.now.advanced(by: .seconds(2))
            while peer.isRunning && ContinuousClock.now < end { try? await Task.sleep(for: .milliseconds(20)) }
            #expect(!peer.isRunning)
            if !peer.isRunning { try? FileManager.default.removeItem(at: folder) }
        }
        var store: MachineStore?
        let gate = OwnedChildSignGate()
        do {
            var line = Data()
            for try await byte in output.fileHandleForReading.bytes { if byte == 10 { break }; line.append(byte) }
            let info = try #require(JSONSerialization.jsonObject(with: line) as? [String: Any])
            let key = try #require(info["publicKey"] as? String)
            let childPort = try #require(info["childPort"] as? Int)
            let root = MachineEndpoint(host: "127.0.0.1", port: try #require(info["rootPort"] as? Int), expectedPublicKey: key)
            let profile = MachineRouteProfile(machineID: try #require(info["machineID"] as? String), routes: [root],
                machinePublicKey: RelayCrypto.b64(try #require(Data(base64Encoded: key))))
            let subject = MachineStore(profiles: [profile], identity: ClientIdentity(), clientVersion: "test", clientId: "owned")
            store = subject
            if atSigner { subject.ownedBeforeChildSignature = { await gate.hold() } }
            subject.start()
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while subject.machines.first?.status != .connected && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
            try #require(subject.machines.first?.status == .connected)
            let parent = try #require(subject.machines.first?.endpoint)
            let generation = try #require(subject.connectionGenerations[parent])
            let list = try JSONDecoder().decode(SessionListResponse.self, from: fixture("session_list_response", port: childPort))
            subject.receive(.sessions(list), from: parent, generation: generation)
            let statsFile = folder.appendingPathComponent("stats.json")
            func stats() throws -> [String: Int] {
                try #require(JSONSerialization.jsonObject(with: Data(contentsOf: statsFile)) as? [String: Int])
            }
            while try stats()["childOpens", default: 0] == 0 && ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            try #require(try stats()["childOpens"] == 1, "The child socket must be held before retirement")
            if atSigner {
                while !(await gate.entered) && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
                try #require(await gate.entered, "The received challenge must reach the child signing boundary")
            }
            switch retirement {
            case "forget": _ = subject.removeMachine(parent)
            case "repair": subject.addMachine(parent)
            case "stop": subject.stop()
            default: Issue.record("Unknown retirement")
            }
            if atSigner { await gate.open() }
            else { try input.fileHandleForWriting.write(contentsOf: Data("release\n".utf8)) }
            try await Task.sleep(for: .milliseconds(250))
            #expect(try stats()["childAuth"] == 0)
            #expect(try stats()["childHello"] == 0)
            #expect(!subject.ownedSessionRoutes.values.contains(where: { $0.port == childPort }))
            subject.stop()
        } catch {
            await gate.open()
            store?.stop()
            await cleanup()
            throw error
        }
        await cleanup()
    }

    @Test(arguments: ["legacy", "matching"])
    func learnedManualRootCannotDowngradeOnReconnect(_ scenario: String) async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/direct-child-key-peer.ts")
        let peer = Process(), input = Pipe(), output = Pipe()
        let folder = try OwnedRecoveryFixture.configure(peer, script: script,
            arguments: [scenario == "legacy" ? "manual-reconnect" : "matching", "stats.json"])
        peer.standardInput = input; peer.standardOutput = output; peer.standardError = FileHandle.standardError
        try peer.run()
        func cleanup() async {
            try? input.fileHandleForWriting.close()
            let deadline = ContinuousClock.now.advanced(by: .seconds(3))
            while peer.isRunning && ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(20)) }
            if peer.isRunning { peer.terminate() }
            let end = ContinuousClock.now.advanced(by: .seconds(2))
            while peer.isRunning && ContinuousClock.now < end { try? await Task.sleep(for: .milliseconds(20)) }
            #expect(!peer.isRunning)
            if !peer.isRunning { try? FileManager.default.removeItem(at: folder) }
        }
        var store: MachineStore?
        let reconnectGate = OwnedChildSignGate()
        do {
            var line = Data()
            for try await byte in output.fileHandleForReading.bytes { if byte == 10 { break }; line.append(byte) }
            let info = try #require(JSONSerialization.jsonObject(with: line) as? [String: Any])
            let rootPort = try #require(info["rootPort"] as? Int), childPort = try #require(info["childPort"] as? Int)
            let endpoint = MachineEndpoint(host: "127.0.0.1", port: rootPort)
            let subject = MachineStore(endpoints: [endpoint], identity: ClientIdentity(), clientVersion: "test", clientId: "owned")
            store = subject
            subject.ownedBeforeParentReconnectState = { await reconnectGate.hold() }
            subject.start()
            let initial = ContinuousClock.now.advanced(by: .seconds(5))
            while subject.machines.first?.status != .connected && ContinuousClock.now < initial { try await Task.sleep(for: .milliseconds(10)) }
            try #require(subject.machines.first?.status == .connected)
            let statsFile = folder.appendingPathComponent("stats.json")
            func stats() throws -> [String: Int] {
                try #require(JSONSerialization.jsonObject(with: Data(contentsOf: statsFile)) as? [String: Int])
            }
            #expect(try stats()["rootAuth"] == 1, "The initially unpinned root really authenticated")
            let generation = try #require(subject.connectionGenerations[endpoint])
            let originalSocketOwner = try #require(subject.ownedConnectionID(endpoint))
            try input.fileHandleForWriting.write(contentsOf: Data((scenario == "legacy" ? "switch-legacy\n" : "switch-valid\n").utf8))
            let deadline = ContinuousClock.now.advanced(by: .seconds(8))
            while ContinuousClock.now < deadline {
                let entered = await reconnectGate.entered
                let opened = try stats()["rootOpens", default: 0]
                if entered && opened >= 2 { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            try #require(await reconnectGate.entered, "Store route retirement must be held for the same actor reconnect")
            try #require(subject.ownedConnectionID(endpoint) == originalSocketOwner, "Reconnect must use the original RemiConnection")
            while ContinuousClock.now < deadline {
                let current = try stats()
                if scenario == "legacy", current["rootHelloHeld", default: 0] > 0 { break }
                if scenario == "matching", current["rootHello", default: 0] >= 2 { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(try stats()["rootOpens", default: 0] >= 2)
            if scenario == "legacy" {
                try #require(try stats()["rootHelloHeld"] == 1)
                try input.fileHandleForWriting.write(contentsOf: Data("release-root\n".utf8))
            }
            else { #expect(try stats()["rootAuth", default: 0] >= 2) }
            try await Task.sleep(for: .milliseconds(100))
            let response = try JSONDecoder().decode(SessionListResponse.self, from: fixture("session_list_response", port: childPort))
            subject.receive(.sessions(response), from: endpoint, generation: generation)
            let end = ContinuousClock.now.advanced(by: .seconds(3))
            while ContinuousClock.now < end {
                let current = try stats()
                if current["childAuth", default: 0] > 0 || subject.connectionGenerations[endpoint] == nil { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(try stats()["childAuth"] == (scenario == "legacy" ? 0 : 1),
                "A learned root key must survive reconnect; the matching key remains usable")
            await reconnectGate.open()
            subject.stop()
        } catch {
            await reconnectGate.open()
            store?.stop()
            await cleanup()
            throw error
        }
        await cleanup()
    }
}
#endif
