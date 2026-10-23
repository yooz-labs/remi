import CryptoKit
import Darwin
import Foundation
import Testing
@testable import RemiKit

/// #1601: two machines can hold the same session id; a request names its machine.
@MainActor
@Suite(.serialized)
struct SessionAddressingTests {
    private func decode<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: FixtureConformanceTests.fixture(name))
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

    private struct TwoMachines {
        let store: MachineStore
        let routes: [MachineEndpoint]
        let ids: (a: String, b: String)
        let sessionID: String
        let sockets: [Int32]
    }

    /// Two connected machines that both hold the fixture question's session id.
    private func twoMachines() throws -> TwoMachines {
        let first = try listener(), second = try listener()
        let keys = [Curve25519.Signing.PrivateKey().publicKey.rawRepresentation,
                    Curve25519.Signing.PrivateKey().publicKey.rawRepresentation]
        let profiles = try zip(keys, [first.1, second.1]).map { key, port in
            MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
                routes: [MachineEndpoint(host: "127.0.0.1", port: port)], machinePublicKey: RelayCrypto.b64(key))
        }
        let store = MachineStore(profiles: profiles, identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start()
        let hello = try decode("hello_ack_legacy", as: HelloAckMessage.self)
        let question = try decode("question", as: QuestionMessage.self)
        var routes: [MachineEndpoint] = []
        for (index, key) in keys.enumerated() {
            let machine = store.machines[index]
            let route = try #require(store.connectionGenerations.keys.first { machine.routingRoutes.contains($0) })
            let generation = try #require(store.connectionGenerations[route])
            store.receive(.hello(hello, authorityPublicKey: key), from: route, generation: generation)
            store.receive(.question(question), from: route, generation: generation)
            routes.append(route)
        }
        return TwoMachines(store: store, routes: routes, ids: (store.machines[0].id, store.machines[1].id),
            sessionID: question.sessionId, sockets: [first.0, second.0])
    }

    private func transcriptContent(sessionID: String, text: String) throws -> TranscriptContentMessage {
        var payload = try #require(try JSONSerialization.jsonObject(
            with: FixtureConformanceTests.fixture("transcript_content")) as? [String: Any])
        payload["sessionId"] = sessionID
        payload["content"] = text
        return try JSONDecoder().decode(TranscriptContentMessage.self,
            from: JSONSerialization.data(withJSONObject: payload))
    }

    @Test func transcriptsAreKeptPerMachine() throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        let keyA = MachineSessionKey(machineID: fixture.ids.a, sessionID: sid)
        let keyB = MachineSessionKey(machineID: fixture.ids.b, sessionID: sid)
        let generationA = try #require(store.connectionGenerations[fixture.routes[0]])
        store.receive(.transcript(try transcriptContent(sessionID: sid, text: "from A")),
            from: fixture.routes[0], generation: generationA)
        #expect(store.transcriptsBySession[keyA]?.map(\.content) == ["from A"])
        #expect(store.transcriptsBySession[keyB] == nil)

        let generationB = try #require(store.connectionGenerations[fixture.routes[1]])
        store.receive(.transcript(try transcriptContent(sessionID: sid, text: "from B")),
            from: fixture.routes[1], generation: generationB)
        #expect(store.transcriptsBySession[keyB]?.map(\.content) == ["from B"])
        #expect(store.transcriptsBySession[keyA]?.map(\.content) == ["from A"])

        // Forgetting machine A leaves machine B's transcript alone.
        #expect(store.removeMachine(fixture.routes[0]))
        #expect(store.transcriptsBySession[keyA] == nil)
        #expect(store.transcriptsBySession[keyB]?.map(\.content) == ["from B"])
    }

    @Test func sameSessionIDOnTwoMachinesIsAddressedIndependently() async throws {
        let first = try listener(), second = try listener()
        defer { Darwin.close(first.0); Darwin.close(second.0) }
        let keys = [Curve25519.Signing.PrivateKey().publicKey.rawRepresentation,
                    Curve25519.Signing.PrivateKey().publicKey.rawRepresentation]
        let profiles = try zip(keys, [first.1, second.1]).map { key, port in
            MachineRouteProfile(machineID: try MachineIdentityVerifier.machineID(forPublicKey: key),
                routes: [MachineEndpoint(host: "127.0.0.1", port: port)], machinePublicKey: RelayCrypto.b64(key))
        }
        let store = MachineStore(profiles: profiles, identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        store.start(); defer { store.stop() }
        #expect(store.machines.count == 2)

        // The same question fixture, so both machines hold the same session id.
        let hello = try decode("hello_ack_legacy", as: HelloAckMessage.self)
        let question = try decode("question", as: QuestionMessage.self)
        var routes: [MachineEndpoint] = []
        for (index, key) in keys.enumerated() {
            let machine = store.machines[index]
            let route = try #require(store.connectionGenerations.keys.first { machine.routingRoutes.contains($0) })
            let generation = try #require(store.connectionGenerations[route])
            store.receive(.hello(hello, authorityPublicKey: key), from: route, generation: generation)
            store.receive(.question(question), from: route, generation: generation)
            routes.append(route)
        }
        let sessionID = question.sessionId
        let (a, b) = (store.machines[0].id, store.machines[1].id)
        #expect(a != b)
        #expect(store.ownedSessionRoutes[MachineSessionKey(machineID: a, sessionID: sessionID)] == routes[0])
        #expect(store.ownedSessionRoutes[MachineSessionKey(machineID: b, sessionID: sessionID)] == routes[1])
        #expect(store.ownedSessionRoutes.count == 2)

        // Loading on one machine leaves the other idle.
        store.loadTranscript(machineID: a, sessionId: sessionID)
        #expect(store.isLoadingTranscript(machineID: a, sessionID: sessionID))
        #expect(!store.isLoadingTranscript(machineID: b, sessionID: sessionID))
        store.loadTranscript(machineID: b, sessionId: sessionID)
        #expect(store.isLoadingTranscript(machineID: b, sessionID: sessionID))

        // The first machine finishing does not end the second machine's load.
        var payload = try #require(try JSONSerialization.jsonObject(
            with: FixtureConformanceTests.fixture("transcript_load_complete")) as? [String: Any])
        payload["sessionId"] = sessionID
        let sessionComplete = try JSONDecoder().decode(TranscriptLoadCompleteMessage.self,
            from: JSONSerialization.data(withJSONObject: payload))
        let generation = try #require(store.connectionGenerations[routes[0]])
        store.receive(.transcriptComplete(sessionComplete), from: routes[0], generation: generation)
        #expect(!store.isLoadingTranscript(machineID: a, sessionID: sessionID))
        #expect(store.isLoadingTranscript(machineID: b, sessionID: sessionID))

        // A machine that does not hold the session cannot borrow another machine's route.
        store.loadTranscript(machineID: "unknown-machine", sessionId: sessionID)
        #expect(!store.isLoadingTranscript(machineID: "unknown-machine", sessionID: sessionID))
    }

    private func errorMessage(details: [String: Any]) throws -> ErrorMessage {
        var payload = try #require(try JSONSerialization.jsonObject(
            with: FixtureConformanceTests.fixture("error")) as? [String: Any])
        payload["details"] = details
        return try JSONDecoder().decode(ErrorMessage.self, from: JSONSerialization.data(withJSONObject: payload))
    }

    @Test func repeatedLoadIsNotEndedByTheOlderTimer() async throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        store.transcriptLoadTimeoutOverride = .milliseconds(300)
        store.ownedTranscriptSend = { _ in }
        store.loadTranscript(machineID: fixture.ids.a, sessionId: sid)
        try await Task.sleep(for: .milliseconds(200))
        store.loadTranscript(machineID: fixture.ids.a, sessionId: sid)
        // The first timer would have fired by now; the second load must still be running.
        try await Task.sleep(for: .milliseconds(200))
        #expect(store.isLoadingTranscript(machineID: fixture.ids.a, sessionID: sid))
        try await Task.sleep(for: .milliseconds(400))
        #expect(!store.isLoadingTranscript(machineID: fixture.ids.a, sessionID: sid))
    }

    @Test func anErrorNamingARequestOrSessionEndsOnlyThatLoad() throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        let requestA = try #require(store.loadTranscript(machineID: fixture.ids.a, sessionId: sid))
        store.loadTranscript(machineID: fixture.ids.b, sessionId: sid)
        let generationA = try #require(store.connectionGenerations[fixture.routes[0]])
        let generationB = try #require(store.connectionGenerations[fixture.routes[1]])

        store.receive(.error(try errorMessage(details: ["requestId": "unrelated"])),
            from: fixture.routes[0], generation: generationA)
        #expect(store.isLoadingTranscript(machineID: fixture.ids.a, sessionID: sid))
        store.receive(.error(try errorMessage(details: ["requestId": requestA])),
            from: fixture.routes[0], generation: generationA)
        #expect(!store.isLoadingTranscript(machineID: fixture.ids.a, sessionID: sid))
        #expect(store.isLoadingTranscript(machineID: fixture.ids.b, sessionID: sid))

        store.receive(.error(try errorMessage(details: ["sessionId": sid])),
            from: fixture.routes[1], generation: generationB)
        #expect(!store.isLoadingTranscript(machineID: fixture.ids.b, sessionID: sid))
    }

    @Test func removingAMachineEndsItsLoadAndKeepsTheOthers() throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        store.loadTranscript(machineID: fixture.ids.a, sessionId: sid)
        store.loadTranscript(machineID: fixture.ids.b, sessionId: sid)
        #expect(store.removeMachine(fixture.routes[0]))
        #expect(!store.isLoadingTranscript(machineID: fixture.ids.a, sessionID: sid))
        #expect(store.isLoadingTranscript(machineID: fixture.ids.b, sessionID: sid))
    }
}
