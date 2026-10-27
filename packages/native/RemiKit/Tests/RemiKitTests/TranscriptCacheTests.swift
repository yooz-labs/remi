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
        let generation = try #require(store.connectionGenerations[fixture.routes[0]])

        store.ensureTranscript(machineID: fixture.ids.a, sessionId: sid)
        store.ensureTranscript(machineID: fixture.ids.a, sessionId: sid)
        try await Task.sleep(for: .milliseconds(50))
        #expect(sent.count == 1, "a load already running is not started again")

        store.receive(.transcriptComplete(try complete(sessionID: sid)), from: fixture.routes[0], generation: generation)
        store.ensureTranscript(machineID: fixture.ids.a, sessionId: sid)
        try await Task.sleep(for: .milliseconds(50))
        #expect(sent.count == 1, "a loaded transcript is kept, not replayed on every selection")

        // loadTranscript is still an explicit refresh.
        store.loadTranscript(machineID: fixture.ids.a, sessionId: sid)
        try await Task.sleep(for: .milliseconds(50))
        #expect(sent.count == 2)
    }

    @Test func aLoadThatTimesOutPublishesWhatArrivedAndIsNotTreatedAsCached() async throws {
        let fixture = try twoMachines()
        defer { fixture.store.stop(); fixture.sockets.forEach { Darwin.close($0) } }
        let store = fixture.store, sid = fixture.sessionID
        let sent = SendCounter()
        store.ownedTranscriptSend = { _ in sent.bump() }
        store.transcriptLoadTimeoutOverride = .milliseconds(80)
        let key = MachineSessionKey(machineID: fixture.ids.a, sessionID: sid)
        let generation = try #require(store.connectionGenerations[fixture.routes[0]])

        store.ensureTranscript(machineID: fixture.ids.a, sessionId: sid)
        store.receive(.transcript(try entry(sessionID: sid, id: "e0", text: "partial")), from: fixture.routes[0], generation: generation)
        try await Task.sleep(for: .milliseconds(250))
        #expect(store.transcriptsBySession[key]?.map(\.content) == ["partial"])

        store.ensureTranscript(machineID: fixture.ids.a, sessionId: sid)
        try await Task.sleep(for: .milliseconds(50))
        #expect(sent.count == 2, "an incomplete load is retried")
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
