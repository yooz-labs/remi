import Foundation
import Testing
@testable import RemiKit

#if os(macOS)
private actor DeliverySendGate {
    var entered = false
    var released = false
    func hold() async throws {
        entered = true
        while !released { try await Task.sleep(for: .milliseconds(5)) }
    }
    func release() { released = true }
}

@MainActor
@Suite(.serialized)
struct DeliverySourceTests {
    private enum Failure: Error { case deadline(String), afterInvocation }

    @Test(arguments: ["refuse", "allow", "partial"])
    func actualSourceInputOutcomesAreRetainedWithoutReplay(_ mode: String) async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/delivery-source-fixture.ts")
        let identity = ClientIdentity()
        let peer = Process()
        let own = try OwnedRecoveryFixture.configure(peer, script: script,
            arguments: [mode, identity.publicIdentity.publicKey],
            bunExecutable: ProcessInfo.processInfo.environment["REMI_DELIVERY_BUN"])
        let output = Pipe(), input = Pipe()
        let log = own.appendingPathComponent("source.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        let errors = try FileHandle(forWritingTo: log)
        peer.standardOutput = output; peer.standardInput = input; peer.standardError = errors
        try peer.run()
        let watchdog = Task {
            try? await Task.sleep(for: .seconds(30))
            if !Task.isCancelled, peer.isRunning { peer.terminate() }
        }
        defer { watchdog.cancel() }
        var store: MachineStore?
        func stop() async {
            store?.stop()
            try? input.fileHandleForWriting.write(contentsOf: Data("stop\n".utf8))
            try? input.fileHandleForWriting.close()
            let deadline = ContinuousClock.now.advanced(by: .seconds(4))
            while peer.isRunning, ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(20)) }
            if peer.isRunning { peer.terminate() }
            let terminated = ContinuousClock.now.advanced(by: .seconds(2))
            while peer.isRunning, ContinuousClock.now < terminated { try? await Task.sleep(for: .milliseconds(20)) }
            #expect(!peer.isRunning, "Owned delivery fixture cleanup deadline")
            try? errors.close()
        }
        do {
            func line() async throws -> [String: Any] {
                let data = try await Self.readLine(from: output.fileHandleForReading)
                return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            }
            let ready = try await line()
            let port = try #require(ready["port"] as? Int)
            let session = try #require(ready["sessionId"] as? String)
            #expect(port != 18765)
            let endpoint = MachineEndpoint(host: "127.0.0.1", port: port)
            let active = MachineStore(endpoints: [endpoint], identity: identity,
                clientVersion: "owned-delivery-test", clientId: UUID().uuidString)
            store = active
            active.outgoingUncertaintyDelay = .milliseconds(600)
            active.start()
            do { try await until("source session") { active.machines.first?.activeSessions.contains { $0.sessionId == session } == true } }
            catch {
                print("Owned delivery connection: \(String(describing: active.machines.first?.status)); source \(log.path)"); throw error }
            let machine = try #require(active.machines.first?.id)
            let key = active.sessionKey(machineID: machine, sessionID: session)
            let connection = try #require(active.connection(for: key))
            let gate = DeliverySendGate()
            // Hold after a real socket invocation so the daemon outcome can beat send return.
            await connection.ownedSetChatSendReturn {
                try await gate.hold()
                if mode == "allow" { throw Failure.afterInvocation }
            }
            let send = Task { await active.sendChat(machineID: machine, sessionId: session, content: "owned inert input") }
            try await until("outcome") { await gate.entered }
            if mode == "refuse" { try await until("outcome") { active.outgoingBySession[key]?.items.first?.delivery == .refused } }
            if mode == "partial" { try await until("outcome") { active.outgoingBySession[key]?.items.first?.delivery == .uncertain } }
            await gate.release()
            #expect(await send.value) // Draft now belongs to the retained row, including uncertainty.
            let expected: OutgoingMessage.Delivery = mode == "refuse" ? .refused : .uncertain
            #expect(active.outgoingBySession[key]?.items.first?.delivery == expected)
            let oldOrigin = try #require(await connection.chatOrigin())
            // A concurrent history refusal has session identity but no message identity.
            active.loadTranscript(machineID: machine, sessionId: session)
            try await until("outcome") { active.latestError?.code == "SESSION_NOT_FOUND" }
            #expect(active.outgoingBySession[key]?.items.first?.delivery == expected)
            await connection.stop()
            await connection.start()
            try await until("outcome") { await connection.chatOrigin() != nil }
            #expect(await connection.chatOrigin() != oldOrigin)
            let stale = UserInputMessage(id: UUID().uuidString.lowercased(), timestamp: Date().ISO8601Format(),
                sessionId: session, content: "must never invoke", claudeSessionId: nil)
            #expect(await connection.sendChat(stale, origin: oldOrigin) == .notInvoked)
            try await Task.sleep(for: .milliseconds(100))
            if mode == "allow" {
                let source = try #require(active.outgoingBySession[key]?.items.first?.origin)
                for index in 1..<OutgoingMessages.limit {
                    active.trackOutgoing(key: key, id: "capacity-\(index)", content: "retained", origin: source)
                }
                #expect(await !active.sendChat(machineID: machine, sessionId: session, content: "keep draft"))
                #expect(active.latestOperationError == MachineStore.outgoingCapacityMessage)
                #expect(active.outgoingBySession[key]?.items.count == 50)
            }
            try input.fileHandleForWriting.write(contentsOf: Data("stats\n".utf8))
            let stats = try await line()
            #expect(stats["inputs"] as? Int == 1) // Reconnect and stale origin never replay input.
            let outputBytes = try #require(stats["outputBytes"] as? Int)
            #expect(mode == "refuse" ? outputBytes == 0 : outputBytes > 0)
            #expect(active.outgoingBySession[key]?.items.count == (mode == "allow" ? 50 : 1))
            if mode == "allow" {
                active.terminateSession(machineID: machine, sessionId: session)
                try await until("source kill acknowledgement") { active.sessionByKillRequest.isEmpty }
                #expect(active.machines.first?.sessions.contains { $0.sessionId == session } == false)
                #expect(active.outgoingHistory.first?.messages.count == 50)
                #expect(active.removeMachine(endpoint))
                #expect(active.machines.isEmpty)
                #expect(active.outgoingHistory.first?.key == key)
                #expect(active.outgoingHistory.first?.messages.first?.content == "owned inert input")
                let retained = try #require(active.outgoingHistory.first)
                active.dismissOutgoing(groupID: retained.id,
                    messageID: try #require(retained.messages.first?.id))
                #expect(active.outgoingHistory.first?.messages.count == 49)
            }
            print("Owned delivery \(mode): one input; retained \(expected); log \(log.path)")
            await stop()
        } catch {
            await stop()
            throw error
        }
    }

    /// Pipe reads can block while the owned source starts. Keep those reads off MainActor so
    /// native notification callbacks and their deadlines continue to run in the full suite.
    private nonisolated static func readLine(from handle: FileHandle) async throws -> Data {
        try await Task.detached {
            var data = Data()
            while data.count < 4096, let next = try handle.read(upToCount: 1), let byte = next.first {
                if byte == 10 { return data }
                data.append(byte)
            }
            throw Failure.deadline("owned source metadata")
        }.value
    }

    private func until(_ label: String, _ condition: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while ContinuousClock.now < deadline {
            if try await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw Failure.deadline(label)
    }
}
#endif
