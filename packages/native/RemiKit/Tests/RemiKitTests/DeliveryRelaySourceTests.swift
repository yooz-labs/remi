import Foundation
import Testing
@testable import RemiKit

#if os(macOS)
@MainActor
private final class DeliveryRelayProbe {
    var helloCount = 0
    var lists = 0
    var errorSessions: Set<String> = []
    func receive(_ event: RemiInboundEvent) {
        switch event {
        case .hello: helloCount += 1
        case .sessions: lists += 1
        case .error(let error, _):
            if case .string(let session)? = error.details?["sessionId"] { errorSessions.insert(session) }
        default: break
        }
    }
}

@MainActor
struct DeliveryRelaySourceTests {
    private enum Failure: Error { case deadline(String) }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_DELIVERY_RELAY_TESTS"] == "1",
        "Owned real Worker/HubRelay gate; run separately from native callback deadline tests."))
    func staleChatOriginCannotSealOrRetireAReplacementRelay() async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/delivery-relay-fixture.ts")
        let identity = ClientIdentity()
        let process = Process()
        let own = try OwnedRecoveryFixture.configure(process, script: script, arguments: [identity.publicKeyBase64],
            bunExecutable: ProcessInfo.processInfo.environment["REMI_DELIVERY_BUN"])
        let input = Pipe(), output = Pipe()
        let log = own.appendingPathComponent("source-relay.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        let errors = try FileHandle(forWritingTo: log)
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        try process.run()
        let watchdog = Task {
            try? await Task.sleep(for: .seconds(45))
            if !Task.isCancelled, process.isRunning { process.terminate() }
        }
        defer { watchdog.cancel() }
        var connection: RemiConnection?
        func stop() async {
            await connection?.stop()
            try? input.fileHandleForWriting.write(contentsOf: Data("stop\n".utf8))
            try? input.fileHandleForWriting.close()
            let deadline = ContinuousClock.now.advanced(by: .seconds(8))
            while process.isRunning, ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(20)) }
            if process.isRunning { process.terminate() }
            let terminated = ContinuousClock.now.advanced(by: .seconds(4))
            while process.isRunning, ContinuousClock.now < terminated { try? await Task.sleep(for: .milliseconds(20)) }
            #expect(!process.isRunning, "Owned workerd fixture did not stop before its cleanup deadline")
            try? errors.close()
        }
        do {
            func line() async throws -> [String: Any] {
                let data = try await Self.readLine(output.fileHandleForReading)
                return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            }
            let ready = try await line()
            #expect(ready["kind"] as? String == "ready")
            let pin = try RelayMachinePin(relayURL: #require(ready["relayURL"] as? String),
                machinePublicKey: #require(ready["machinePublicKey"] as? String))
            let probe = DeliveryRelayProbe()
            let active = RemiConnection(configuration: .init(url: try #require(pin.clientURL),
                clientVersion: "owned-delivery-relay", clientId: "owned-delivery-relay", relayPin: pin),
                identity: identity, stateHandler: { _ in },
                eventHandler: { event in Task { @MainActor in probe.receive(event) } })
            connection = active
            await active.start()
            try await until("original relay hello") { probe.helloCount == 1 }
            let oldOrigin = try #require(await active.chatOrigin())
            try input.fileHandleForWriting.write(contentsOf: Data("restart\n".utf8))
            #expect(try await line()["kind"] as? String == "restarted")
            try await until("replacement relay hello") { probe.helloCount == 2 }
            let replacement = try #require(await active.chatOrigin())
            #expect(replacement != oldOrigin)
            let stale = UserInputMessage(id: UUID().uuidString.lowercased(), timestamp: Date().ISO8601Format(),
                sessionId: UUID().uuidString.lowercased(), content: "must never reach relay ingress", claudeSessionId: nil)
            #expect(await active.sendChat(stale, origin: oldOrigin) == .notInvoked)
            #expect(await active.chatOrigin() == replacement)
            let current = UserInputMessage(id: UUID().uuidString.lowercased(), timestamp: Date().ISO8601Format(),
                sessionId: UUID().uuidString.lowercased(), content: "owned inert input to an absent session", claudeSessionId: nil)
            #expect(await active.sendChat(current, origin: replacement) == .handedOff)
            // The real hub refuses its absent child after admitting the frame. The replacement
            // must still decrypt the response and a later census, with no sequence gap or reset.
            try await until("current input reaches real relay") { probe.errorSessions.contains(current.sessionId) }
            let beforeLists = probe.lists
            try await active.send(SessionListRequestMessage(id: UUID().uuidString.lowercased(),
                timestamp: Date().ISO8601Format(), includeExternal: false))
            try await until("replacement relay remains usable") { probe.lists > beforeLists }
            #expect(await active.chatOrigin() == replacement)
            #expect(probe.helloCount == 2)
            #expect(!probe.errorSessions.contains(stale.sessionId))
            try input.fileHandleForWriting.write(contentsOf: Data("stats\n".utf8))
            let stats = try await line()
            #expect(stats["inputs"] as? [String] == [current.id])
            print("Owned relay stale-origin control: one current ingress, no stale ingress, unchanged replacement socket; log \(log.path)")
            await stop()
        } catch { await stop(); throw error }
    }

    private func until(_ label: String, _ condition: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(12))
        while ContinuousClock.now < deadline {
            if try await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw Failure.deadline(label)
    }

    private nonisolated static func readLine(_ handle: FileHandle) async throws -> Data {
        try await Task.detached {
            var data = Data()
            while data.count < 4096, let next = try handle.read(upToCount: 1), let byte = next.first {
                if byte == 10 { return data }
                data.append(byte)
            }
            throw Failure.deadline("owned relay metadata")
        }.value
    }
}
#endif
