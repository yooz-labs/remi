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

    @Test(arguments: ["discovery-matching", "discovery-wrong", "create-matching", "create-wrong", "resume-matching", "resume-wrong", "discovery-legacy", "childfirst-legacy", "earlydiscovery-wrong", "earlycreate-wrong", "earlydiscovery-matching", "earlycreate-matching", "earlydiscovery-legacy"])
    func childUsesAuthenticatedParentKey(_ scenario: String) async throws {
        let pieces = scenario.split(separator: "-")
        let action = String(pieces[0]), mode = String(pieces[1])
        let early = action.hasPrefix("early")
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/direct-child-key-peer.ts")
        let peer = Process(), input = Pipe(), output = Pipe()
        let folder = try OwnedRecoveryFixture.configure(peer, script: script, arguments: [mode, "stats.json"])
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
            let rootDeadline = ContinuousClock.now.advanced(by: .seconds(5))
            while subject.machines.first?.status != .connected && ContinuousClock.now < rootDeadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            try #require(subject.machines.first?.status == .connected, "Real root must authenticate before dispatch")
            if early {
                while !(await parentHelloGate.entered) && ContinuousClock.now < rootDeadline { try await Task.sleep(for: .milliseconds(10)) }
                try #require(await parentHelloGate.entered, "Verified parent Hello must be held before Store processing")
            }
            let rootGeneration = try #require(subject.connectionGenerations[activeRoot])
            switch action {
            case "discovery", "childfirst", "earlydiscovery":
                let response = try JSONDecoder().decode(SessionListResponse.self, from: fixture("session_list_response", port: childPort))
                subject.receive(.sessions(response), from: activeRoot, generation: rootGeneration)
            case "create", "earlycreate":
                let response = try JSONDecoder().decode(CreateSessionResponseMessage.self, from: fixture("create_session_response", port: childPort))
                subject.receive(.createSessionResponse(response), from: activeRoot, generation: rootGeneration)
            case "resume":
                subject.resumeSession(on: activeRoot, sessionId: "fixture-session-id")
                let requestID = try #require(subject.ownedResumeRequestIDs.first)
                let response = try JSONDecoder().decode(ResumeSessionResponseMessage.self, from: fixture("resume_session_response_child", port: childPort, requestID: requestID))
                subject.receive(.resumeSessionResponse(response), from: activeRoot, generation: rootGeneration)
            default: Issue.record("Unknown scenario")
            }
            let statsFile = folder.appendingPathComponent("stats.json")
            func stats() throws -> [String: Int] {
                try #require(JSONSerialization.jsonObject(with: Data(contentsOf: statsFile)) as? [String: Int])
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

    @Test(arguments: ["discovery", "create", "resume"])
    func anotherParentCannotReuseChildSocket(_ action: String) async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/direct-child-key-peer.ts")
        let peer = Process(), input = Pipe(), output = Pipe()
        let folder = try OwnedRecoveryFixture.configure(peer, script: script, arguments: ["matching", "stats.json"])
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
            while subject.machines.filter({ $0.status == .connected }).count != 2 && ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            try #require(subject.machines.filter({ $0.status == .connected }).count == 2)
            let owner = try #require(subject.machines.first(where: { $0.endpoint.port == first.port })?.endpoint)
            let other = try #require(subject.machines.first(where: { $0.endpoint.port == second.port })?.endpoint)
            let ownerGeneration = try #require(subject.connectionGenerations[owner])
            let list = try JSONDecoder().decode(SessionListResponse.self, from: fixture("session_list_response", port: childPort))
            subject.receive(.sessions(list), from: owner, generation: ownerGeneration)
            while !subject.ownedSessionRoutes.values.contains(where: { $0.port == childPort }) && ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            let child = try #require(subject.ownedParentRoutes.keys.first(where: { $0.port == childPort }))
            #expect(subject.ownedParentRoutes[child] == owner)
            try #require(subject.ownedSessionRoutes.values.contains(child))
            let childGeneration = try #require(subject.connectionGenerations[child])
            let otherGeneration = try #require(subject.connectionGenerations[other])
            switch action {
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
}
#endif
