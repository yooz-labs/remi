import CryptoKit
import Darwin
import Foundation
import Testing
@testable import RemiKit

/// #1601: two machines can hold the same session id; a request names its machine.
@MainActor
@Suite(.serialized)
struct SessionAddressingTests {
    func decode<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: FixtureConformanceTests.fixture(name))
    }

    func listener() throws -> (Int32, Int) {
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

    struct TwoMachines {
        let store: MachineStore
        let routes: [MachineEndpoint]
        let ids: (a: String, b: String)
        let sessionID: String
        let sockets: [Int32]
    }

    /// Two connected machines that both hold the fixture question's session id.
    func twoMachines() throws -> TwoMachines {
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

    private func transcriptContent(
        sessionID: String, text: String, role: String? = nil, entryUuid: String? = nil
    ) throws -> TranscriptContentMessage {
        var payload = try #require(try JSONSerialization.jsonObject(
            with: FixtureConformanceTests.fixture("transcript_content")) as? [String: Any])
        payload["sessionId"] = sessionID
        payload["content"] = text
        if let role { payload["role"] = role }
        if let entryUuid { payload["entryUuid"] = entryUuid }
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

    // MARK: Correlated outgoing outcomes (#1710)

    private func origin(_ fixture: TwoMachines, index: Int = 0, socket: UUID = UUID()) throws -> OutgoingOrigin {
        OutgoingOrigin(endpoint: fixture.routes[index],
            connection: try #require(fixture.store.connectionGenerations[fixture.routes[index]]), socket: socket)
    }

    private func refusal(session: String, message: String? = "m1", code: String = "PROMPT_WAITING") throws -> ErrorMessage {
        var payload = try #require(try JSONSerialization.jsonObject(with: FixtureConformanceTests.fixture("error")) as? [String: Any])
        payload["code"] = code
        var details = ["sessionId": session]
        if let message { details["messageId"] = message }
        payload["details"] = details
        return try JSONDecoder().decode(ErrorMessage.self, from: JSONSerialization.data(withJSONObject: payload))
    }

    @Test func unavailableTransportPreservesDraftWithoutTrackingAnIntent() async throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        #expect(await !fixture.store.sendChat(machineID: fixture.ids.a, sessionId: fixture.sessionID, content: "hello"))
        #expect(fixture.store.outgoingMessages(machineID: fixture.ids.a, sessionID: fixture.sessionID).isEmpty)
        #expect(fixture.store.latestOperationError?.contains("unavailable") == true)
    }

    @Test func onlyAuthenticatedExactOriginMachineSessionAndMessageCanRefuse() throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        let a = store.sessionKey(machineID: fixture.ids.a, sessionID: sid)
        let b = store.sessionKey(machineID: fixture.ids.b, sessionID: sid)
        let source = try origin(fixture)
        let other = try origin(fixture, index: 1)
        store.trackOutgoing(key: a, id: "m1", content: "hello", origin: source)
        store.trackOutgoing(key: b, id: "m1", content: "hello", origin: other)
        let error = try refusal(session: sid)
        store.receive(.error(error), from: source.endpoint, generation: source.connection)
        store.receive(.error(error, chatOrigin: UUID()), from: source.endpoint, generation: source.connection)
        store.receive(.error(try refusal(session: "other"), chatOrigin: source.socket), from: source.endpoint, generation: source.connection)
        store.receive(.error(try refusal(session: sid, message: "other"), chatOrigin: source.socket), from: source.endpoint, generation: source.connection)
        #expect(store.outgoingBySession[a]?.items.first?.delivery == .sending)
        store.receive(.error(error, chatOrigin: source.socket), from: source.endpoint, generation: source.connection)
        #expect(store.outgoingBySession[a]?.items.first?.delivery == .refused)
        #expect(store.outgoingBySession[b]?.items.first?.delivery == .sending)
    }

    @Test func sessionOnlyErrorCannotAttributeOutcomeAndOldSocketCannotRefuseNewIntent() throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        let key = store.sessionKey(machineID: fixture.ids.a, sessionID: sid)
        let source = try origin(fixture), replacement = try origin(fixture)
        store.trackOutgoing(key: key, id: "m1", content: "hello", origin: source)
        store.receive(.error(try refusal(session: sid, message: nil, code: "RELAY_DELIVERY_FAILED"), chatOrigin: source.socket),
            from: source.endpoint, generation: source.connection)
        #expect(store.outgoingBySession[key]?.items.first?.delivery == .sending)
        #expect(store.latestError?.code == "RELAY_DELIVERY_FAILED")
        store.dismissOutgoing(presentationID: try #require(store.outgoingBySession[key]?.items.first?.presentationID))
        store.trackOutgoing(key: key, id: "m1", content: "new intent", origin: replacement)
        store.receive(.error(try refusal(session: sid), chatOrigin: source.socket), from: source.endpoint, generation: source.connection)
        #expect(store.outgoingBySession[key]?.items.first?.delivery == .sending)
    }

    @Test func matchingTranscriptTextNeverConfirmsAnIntent() throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        let key = store.sessionKey(machineID: fixture.ids.a, sessionID: sid)
        let source = try origin(fixture)
        store.trackOutgoing(key: key, id: "m1", content: "hello", origin: source)
        store.receive(.transcript(try transcriptContent(sessionID: sid, text: "hello", role: "user", entryUuid: "live")),
            from: source.endpoint, generation: source.connection)
        #expect(store.outgoingBySession[key]?.items.first?.content == "hello")
        #expect(store.outgoingBySession[key]?.items.first?.delivery == .sending)
    }

    @Test func missingReceiptBecomesUncertainWithoutEviction() async throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store
        store.outgoingUncertaintyDelay = .milliseconds(20)
        let key = store.sessionKey(machineID: fixture.ids.a, sessionID: fixture.sessionID)
        store.trackOutgoing(key: key, id: "m1", content: "hello", origin: try origin(fixture))
        try await Task.sleep(for: .milliseconds(60))
        #expect(store.outgoingBySession[key]?.items.first?.delivery == .uncertain)
        let groupID = try #require(store.outgoingBySession[key]?.items.first?.groupID)
        let wrong = OutgoingGroupID(profile: OutgoingProfileScope(profileLifetime: UUID(), authenticatedAuthority: nil), sessionID: fixture.sessionID)
        store.dismissOutgoing(groupID: wrong, messageID: "m1")
        #expect(store.outgoingBySession[key]?.items.count == 1)
        store.dismissOutgoing(groupID: groupID, messageID: "m1")
        #expect(store.outgoingBySession[key] == nil)
    }
    @Test func replayUpdatesAndRepeatedTextAllPreserveEveryIntent() throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        let key = store.sessionKey(machineID: fixture.ids.a, sessionID: sid)
        let source = try origin(fixture)
        store.ownedTranscriptSend = { _ in }
        store.trackOutgoing(key: key, id: "m1", content: "yes", origin: source)
        store.trackOutgoing(key: key, id: "m2", content: "yes", origin: source)
        store.loadTranscript(machineID: fixture.ids.a, sessionId: sid)
        for (entry, role) in [("old", "user"), ("old", "user"), ("reply", "assistant"), ("new", "user")] {
            store.receive(.transcript(try transcriptContent(sessionID: sid, text: " yes\n", role: role, entryUuid: entry)),
                from: source.endpoint, generation: source.connection)
        }
        #expect(store.outgoingBySession[key]?.items.map(\.id) == ["m1", "m2"])
    }

    @Test func sessionTerminationKeepsOutcomesUntilExplicitDismissal() throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        let key = store.sessionKey(machineID: fixture.ids.a, sessionID: sid)
        store.trackOutgoing(key: key, id: "m1", content: "hello", origin: try origin(fixture))
        store.sessionByKillRequest["kill-1"] = key
        var payload = try #require(try JSONSerialization.jsonObject(with: FixtureConformanceTests.fixture("kill_session_response")) as? [String: Any])
        payload["requestId"] = "kill-1"
        let result = try JSONDecoder().decode(KillSessionResponseMessage.self, from: JSONSerialization.data(withJSONObject: payload))
        let source = try origin(fixture)
        store.receive(.killSessionResponse(result), from: source.endpoint, generation: source.connection)
        #expect(store.outgoingBySession[key]?.items.first?.content == "hello")
    }

    @Test func removedMachineRetainsRecoverableTextAndDismissalIsMachineScoped() throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        let a = store.sessionKey(machineID: fixture.ids.a, sessionID: sid)
        let b = store.sessionKey(machineID: fixture.ids.b, sessionID: sid)
        store.trackOutgoing(key: a, id: "same-message", content: "A recovery", origin: try origin(fixture))
        store.trackOutgoing(key: b, id: "same-message", content: "B recovery", origin: try origin(fixture, index: 1))
        #expect(store.removeMachine(fixture.routes[0]))
        #expect(store.outgoingHistory.first { $0.key == a }?.messages.first?.content == "A recovery")
        #expect(store.outgoingHistory.first { $0.key == a }?.messages.first?.delivery == .uncertain)
        let groupB = try #require(store.outgoingHistory.first { $0.key == b })
        store.dismissOutgoing(groupID: groupB.id, messageID: "same-message")
        #expect(store.outgoingHistory.map(\.key) == [a])
        #expect(store.outgoingHistory.first?.messages.first?.content == "A recovery")
    }

    @Test func globalRowAndSessionLimitsRefuseWithoutEviction() throws {
        let store = MachineStore(endpoints: [], identity: ClientIdentity(), clientVersion: "test", clientId: "test")
        let source = OutgoingOrigin(endpoint: MachineEndpoint(host: "127.0.0.1", port: 18790), connection: UUID(), socket: UUID())
        let scope = OutgoingProfileScope(profileLifetime: UUID(), authenticatedAuthority: nil)
        for index in 0..<MachineStore.outgoingRowLimit {
            let key = MachineSessionKey(machineID: "owned-machine", sessionID: "session-\(index / 50)")
            let tracked = store.trackOutgoing(key: key, id: "m-\(index)", content: "retained", origin: source, scope: scope)
            #expect(tracked)
        }
        let overflow = store.trackOutgoing(key: MachineSessionKey(machineID: "owned-machine", sessionID: "new"),
            id: "overflow", content: "draft", origin: source, scope: scope)
        #expect(!overflow)
        #expect(store.outgoingCount == 512)
        #expect(store.outgoingHistory.flatMap(\.messages).contains { $0.id == "m-0" })
        for group in store.outgoingHistory {
            for message in group.messages {
                store.dismissOutgoing(groupID: group.id, messageID: message.id)
            }
        }
        for index in 0..<MachineStore.outgoingSessionLimit {
            let tracked = store.trackOutgoing(key: MachineSessionKey(machineID: "owned-machine", sessionID: "session-\(index)"),
                id: "m", content: "retained", origin: source, scope: scope)
            #expect(tracked)
        }
        let extra = MachineSessionKey(machineID: "owned-machine", sessionID: "session-65")
        let sessionOverflow = store.trackOutgoing(key: extra, id: "m", content: "draft", origin: source, scope: scope)
        #expect(!sessionOverflow)
        #expect(store.outgoingHistory.count == 64)
        store.dismissOutgoing(groupID: OutgoingGroupID(profile: scope, sessionID: "session-0"), messageID: "m")
        let afterDismiss = store.trackOutgoing(key: extra, id: "m", content: "explicit new intent", origin: source, scope: scope)
        #expect(afterDismiss)
        #expect(store.outgoingHistory.count == 64)
    }

}
