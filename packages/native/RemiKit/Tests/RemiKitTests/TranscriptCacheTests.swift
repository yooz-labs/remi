import Darwin
import Foundation
import Testing
@testable import RemiKit

/// A session's transcript is loaded once per connection and kept, and a load publishes once.
extension SessionAddressingTests {
    private func entry(sessionID: String, id: String, text: String) throws -> TranscriptContentMessage {
        var payload = try #require(try JSONSerialization.jsonObject(
            with: FixtureConformanceTests.fixture("transcript_content")) as? [String: Any])
        payload["sessionId"] = sessionID
        payload["entryUuid"] = id
        payload["content"] = text
        return try JSONDecoder().decode(
            TranscriptContentMessage.self, from: JSONSerialization.data(withJSONObject: payload))
    }

    private func complete(sessionID: String) throws -> TranscriptLoadCompleteMessage {
        var payload = try #require(try JSONSerialization.jsonObject(
            with: FixtureConformanceTests.fixture("transcript_load_complete")) as? [String: Any])
        payload["sessionId"] = sessionID
        return try JSONDecoder().decode(
            TranscriptLoadCompleteMessage.self, from: JSONSerialization.data(withJSONObject: payload))
    }

    private final class SendCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        func bump() { lock.lock(); value += 1; lock.unlock() }
        var count: Int { lock.lock(); defer { lock.unlock() }; return value }
    }

    /// Lists sessions on a machine as its daemon would, from the real session list fixture.
    private func listSessions(_ fixture: TwoMachines, machine: Int, ids: [String], source: String = "daemon") throws {
        var payload = try #require(try JSONSerialization.jsonObject(
            with: FixtureConformanceTests.fixture("session_list_response")) as? [String: Any])
        let template = try #require((payload["sessions"] as? [[String: Any]])?.first)
        payload["sessions"] = ids.map { id -> [String: Any] in
            var entry = template
            entry["sessionId"] = id
            entry["source"] = source
            return entry
        }
        payload["daemonPorts"] = [Int]()
        let response = try JSONDecoder().decode(
            SessionListResponse.self, from: JSONSerialization.data(withJSONObject: payload))
        let route = fixture.routes[machine]
        fixture.store.receive(.sessions(response), from: route, generation: try #require(fixture.store.connectionGenerations[route]))
    }

    /// Waits up to two seconds for an asynchronous send to be counted.
    private func waitForCount(_ counter: SendCounter, _ expected: Int) async {
        for _ in 0..<200 where counter.count < expected { try? await Task.sleep(for: .milliseconds(10)) }
    }

    @Test func aLoadPublishesOnceWhenItCompletesNotPerMessage() throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        store.ownedTranscriptSend = { _ in }
        let key = MachineSessionKey(machineID: fixture.ids.a, sessionID: sid)
        let generation = try #require(store.connectionGenerations[fixture.routes[0]])
        store.loadTranscript(machineID: fixture.ids.a, sessionId: sid)

        for index in 0..<3 {
            store.receive(.transcript(try entry(sessionID: sid, id: "e\(index)", text: "m\(index)")),
                from: fixture.routes[0], generation: generation)
        }
        #expect(store.transcriptsBySession[key] == nil, "nothing is published while the history replays")

        store.receive(.transcriptComplete(try complete(sessionID: sid)), from: fixture.routes[0], generation: generation)
        #expect(store.transcriptsBySession[key]?.map(\.content) == ["m0", "m1", "m2"])
        #expect(!store.isLoadingTranscript(machineID: fixture.ids.a, sessionID: sid))
    }

    @Test func aLiveEntryAfterTheLoadIsPublishedAtOnce() throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        store.ownedTranscriptSend = { _ in }
        let key = MachineSessionKey(machineID: fixture.ids.a, sessionID: sid)
        let generation = try #require(store.connectionGenerations[fixture.routes[0]])
        store.loadTranscript(machineID: fixture.ids.a, sessionId: sid)
        store.receive(.transcript(try entry(sessionID: sid, id: "e0", text: "old")), from: fixture.routes[0], generation: generation)
        store.receive(.transcriptComplete(try complete(sessionID: sid)), from: fixture.routes[0], generation: generation)

        store.receive(.transcript(try entry(sessionID: sid, id: "e1", text: "live")), from: fixture.routes[0], generation: generation)
        #expect(store.transcriptsBySession[key]?.map(\.content) == ["old", "live"])
    }

    @Test func aCachedTranscriptIsNotRequestedAgain() async throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        let sent = SendCounter()
        store.ownedTranscriptSend = { _ in sent.bump() }
        try listSessions(fixture, machine: 0, ids: [sid])
        let generation = try #require(store.connectionGenerations[fixture.routes[0]])

        #expect(store.ensureTranscript(machineID: fixture.ids.a, sessionId: sid))
        #expect(!store.ensureTranscript(machineID: fixture.ids.a, sessionId: sid))
        await waitForCount(sent, 1)
        #expect(sent.count == 1, "a load already running is not started again")

        store.receive(.transcriptComplete(try complete(sessionID: sid)), from: fixture.routes[0], generation: generation)
        #expect(!store.ensureTranscript(machineID: fixture.ids.a, sessionId: sid), "a loaded transcript is kept, not replayed on every selection")
        #expect(sent.count == 1)

        // loadTranscript is still an explicit refresh.
        store.loadTranscript(machineID: fixture.ids.a, sessionId: sid)
        await waitForCount(sent, 2)
        #expect(sent.count == 2)
    }

    @Test func aLoadFromBeforeAReconnectDoesNotBlockANewOne() async throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        let sent = SendCounter()
        store.ownedTranscriptSend = { _ in sent.bump() }
        try listSessions(fixture, machine: 0, ids: [sid])

        #expect(store.ensureTranscript(machineID: fixture.ids.a, sessionId: sid))
        store.ownedReplaceConnectionGeneration(fixture.routes[0])
        #expect(store.ensureTranscript(machineID: fixture.ids.a, sessionId: sid), "the old connection's load will never complete")
        await waitForCount(sent, 2)
        #expect(sent.count == 2)
    }

    @Test func aTranscriptLoadedBeforeAReconnectIsLoadedAgain() async throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        store.ownedTranscriptSend = { _ in }
        try listSessions(fixture, machine: 0, ids: [sid])
        let generation = try #require(store.connectionGenerations[fixture.routes[0]])
        store.ensureTranscript(machineID: fixture.ids.a, sessionId: sid)
        store.receive(.transcriptComplete(try complete(sessionID: sid)), from: fixture.routes[0], generation: generation)
        #expect(!store.ensureTranscript(machineID: fixture.ids.a, sessionId: sid))
        store.ownedReplaceConnectionGeneration(fixture.routes[0])
        #expect(store.ensureTranscript(machineID: fixture.ids.a, sessionId: sid))
    }

    @Test func aSessionThatIsNotLiveIsLoadedAgainOnEverySelection() throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store
        store.ownedTranscriptSend = { _ in }
        let subagent = "agent-not-a-session"
        let ended = "ended-session"
        try listSessions(fixture, machine: 0, ids: [ended], source: "transcript")
        for id in [subagent, ended] {
            // The route of a subagent comes from session_views; the ended one from its listing.
            store.routeBySession[MachineSessionKey(machineID: fixture.ids.a, sessionID: id)] = fixture.routes[0]
            let generation = try #require(store.connectionGenerations[fixture.routes[0]])
            #expect(store.ensureTranscript(machineID: fixture.ids.a, sessionId: id))
            store.receive(.transcriptComplete(try complete(sessionID: id)), from: fixture.routes[0], generation: generation)
            #expect(store.ensureTranscript(machineID: fixture.ids.a, sessionId: id), "\(id) has no live entries after a one-shot read")
        }
    }

    @Test func warmOrderTakesOneSessionFromEachMachineInTurn() {
        let order = MachineStore.warmOrder([("a", ["a1", "a2", "a3"]), ("b", ["b1"]), ("c", [])])
        #expect(order.map(\.sessionID) == ["a1", "b1", "a2", "a3"])
        #expect(order.map(\.machineID) == ["a", "b", "a", "a"])
    }

    @Test func warmingStartsOnlyTheLimitAndSkipsLoadedSessions() async throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store
        let sent = SendCounter()
        store.ownedTranscriptSend = { _ in sent.bump() }
        let limit = MachineStore.warmTranscriptLimit
        let ids = (0..<(limit + 6)).map { "warm-\($0)" }
        try listSessions(fixture, machine: 0, ids: ids)
        try listSessions(fixture, machine: 1, ids: ["other"])
        // Sessions already loading do not use up the limit.
        for id in ids.prefix(4) { store.loadTranscript(machineID: fixture.ids.a, sessionId: id) }
        await waitForCount(sent, 4)

        store.warmTranscripts(in: [(fixture.ids.a, ids), (fixture.ids.b, ["other"])])
        await waitForCount(sent, 4 + limit)
        try await Task.sleep(for: .milliseconds(50))
        #expect(sent.count == 4 + limit)
        #expect(store.isLoadingTranscript(machineID: fixture.ids.b, sessionID: "other"), "the first machine did not starve the second")
    }

    @Test func aLoadThatTimesOutPublishesWhatArrivedAndIsNotTreatedAsCached() async throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        let sent = SendCounter()
        store.ownedTranscriptSend = { _ in sent.bump() }
        store.transcriptLoadTimeoutOverride = .milliseconds(80)
        try listSessions(fixture, machine: 0, ids: [sid])
        let key = MachineSessionKey(machineID: fixture.ids.a, sessionID: sid)
        let generation = try #require(store.connectionGenerations[fixture.routes[0]])

        store.ensureTranscript(machineID: fixture.ids.a, sessionId: sid)
        store.receive(.transcript(try entry(sessionID: sid, id: "e0", text: "partial")), from: fixture.routes[0], generation: generation)
        try await Task.sleep(for: .milliseconds(250))
        #expect(store.transcriptsBySession[key]?.map(\.content) == ["partial"])

        store.ensureTranscript(machineID: fixture.ids.a, sessionId: sid)
        await waitForCount(sent, 2)
        #expect(sent.count == 2, "an incomplete load is retried")
    }

    @Test func anErrorNamingTheSessionEndsAStagedLoadAndPublishesWhatArrived() throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        store.ownedTranscriptSend = { _ in }
        let key = MachineSessionKey(machineID: fixture.ids.a, sessionID: sid)
        let generation = try #require(store.connectionGenerations[fixture.routes[0]])
        store.loadTranscript(machineID: fixture.ids.a, sessionId: sid)
        store.receive(.transcript(try entry(sessionID: sid, id: "e0", text: "partial")), from: fixture.routes[0], generation: generation)
        #expect(store.transcriptsBySession[key] == nil)

        var payload = try #require(try JSONSerialization.jsonObject(
            with: FixtureConformanceTests.fixture("error")) as? [String: Any])
        payload["details"] = ["sessionId": sid]
        let failure = try JSONDecoder().decode(ErrorMessage.self, from: JSONSerialization.data(withJSONObject: payload))
        store.receive(.error(failure), from: fixture.routes[0], generation: generation)

        #expect(!store.isLoadingTranscript(machineID: fixture.ids.a, sessionID: sid))
        #expect(!store.hasStagedTranscript(for: key))
        #expect(store.transcriptsBySession[key]?.map(\.content) == ["partial"])
    }

    @Test func removingAMachineDropsItsCachedAndStagedTranscripts() throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        store.ownedTranscriptSend = { _ in }
        let keyA = MachineSessionKey(machineID: fixture.ids.a, sessionID: sid)
        let generation = try #require(store.connectionGenerations[fixture.routes[0]])
        store.loadTranscript(machineID: fixture.ids.a, sessionId: sid)
        store.receive(.transcript(try entry(sessionID: sid, id: "e0", text: "x")), from: fixture.routes[0], generation: generation)
        #expect(store.removeMachine(fixture.routes[0]))
        #expect(store.transcriptsBySession[keyA] == nil)
        #expect(!store.hasStagedTranscript(for: keyA))
    }
}
