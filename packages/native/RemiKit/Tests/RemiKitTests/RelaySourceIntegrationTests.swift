import Foundation
import Testing
@testable import RemiKit

#if os(macOS)
@MainActor
struct RelaySourceIntegrationTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_RELAY_REFERENCE_ROOT"] != nil,
        "Requires a source composite containing relay 8fb5b88b and develop 1d800273; see docs/native-relay-x2.md."))
    func pairsResumesAndAnswersThroughSourceHubAndRealWorker() async throws {
        let reference = try #require(ProcessInfo.processInfo.environment["REMI_RELAY_REFERENCE_ROOT"])
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Integration/relay-fixture.ts")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["bun", script.path, reference]
        let output = Pipe()
        let input = Pipe()
        process.standardOutput = output
        process.standardInput = input
        process.standardError = FileHandle.standardError
        try process.run()
        defer { cleanupFixture(process, input: input) }
        let offer = try await next(from: output)
        #expect(offer["kind"] as? String == "offer")
        let token = try #require(offer["token"] as? String)
        let directory = try #require(offer["directory"] as? String)
        let identity = ClientIdentity()
        let endpoint = try MachineEndpoint.pairingOverRelay(token)
        let store = MachineStore(endpoints: [], identity: identity, clientVersion: "native-x2-test", clientId: "owned-swift-device")
        store.addMachine(endpoint)
        do {
            let comparison = try await next(from: output)
            #expect(comparison["kind"] as? String == "compare")
            let expected = try #require(comparison["fingerprint"] as? String)
            try await until("Swift confirmation fingerprint") {
                store.machines.first?.status == .waitingForRelayConfirmation(fingerprint: expected)
            }
            #expect(store.persistableEndpoints.isEmpty)
            try send(["kind": "confirm", "fingerprint": expected], to: input)
            try await until("paired source hello and session list") {
                store.machines.first?.status == .connected && store.machines.first?.hasLoadedSessions == true
            }
            #expect(store.persistableEndpoints.count == 1)
            let persisted = try JSONEncoder().encode(store.persistableEndpoints)
            #expect(!String(decoding: persisted, as: UTF8.self).contains(RelayCrypto.b64(try #require(endpoint.relayPairingSecret))))
            let restored = try JSONDecoder().decode([MachineEndpoint].self, from: persisted)
            #expect(restored.first?.relayPairingSecret == nil)
            store.stop()
            // Start a fresh connection with the persisted public authority, no ticket or old keys.
            let resumed = MachineStore(endpoints: restored, identity: identity,
                clientVersion: "native-x2-test", clientId: "owned-swift-resume")
            resumed.start()
            do {
                try await until("fresh resumed source hello") {
                    resumed.machines.first?.status == .connected && resumed.machines.first?.hasLoadedSessions == true
                }
                let saved = try #require(restored.first)
                // R2 admits one socket per device key. Stop the Store before the transport probe.
                resumed.stop()
                let probe = RelayConnectionProbe()
                let connection = RemiConnection(configuration: RemiConnectionConfiguration(
                    url: try #require(saved.webSocketURL), clientVersion: "native-x2-test",
                    clientId: "owned-swift-probe", relayPin: saved.relayPin), identity: identity,
                    stateHandler: { _ in }, eventHandler: { event in
                        Task { @MainActor in probe.receive(event) }
                    })
                await connection.start()
                do {
                    try await until("standalone native connection hello") { probe.helloCount == 1 }
                    do {
                        try await connection.send(HelloMessage(id: "owned-oversize", timestamp: "owned",
                            clientVersion: String(repeating: "x", count: RelayCrypto.maxPlaintext + 1), clientId: "owned"))
                        Issue.record("Oversize local send was accepted")
                    } catch { #expect(error as? RelayFailure == .oversize) }
                    try await connection.send(SessionListRequestMessage(id: "owned-after-refusal", timestamp: "owned", includeExternal: true))
                    try await until("valid request after local refusal") { probe.sessionCount == 1 }
                    try send(["kind": "restart"], to: input)
                    let restart = try await next(from: output)
                    #expect(restart["kind"] as? String == "restarted")
                    try await until("authenticated peer BYE and fresh worker resume") {
                        probe.cleanEndCount >= 1 && probe.helloCount == 2
                    }
                    #expect(probe.uncleanEndCount == 0)
                    await connection.stop()
                } catch { await connection.stop(); throw error }
                resumed.start()
                try await Task.sleep(for: .milliseconds(25))
                try await until("Store resumes after transport probe") {
                    resumed.machines.first?.status == .connected && resumed.machines.first?.hasLoadedSessions == true
                }
                resumed.createSession(on: saved, directory: directory, harness: "claude")
                try await until("actual source child session") { resumed.machines.first?.activeSessions.count == 1 }
                try send(["kind": "question"], to: input)
                let session = try #require(resumed.machines.first?.activeSessions.first)
                // Joining is semantic through the hub, never a dial of the advertised child port.
                resumed.loadTranscript(sessionId: session.sessionId)
                try await until("actual held permission card") { !(resumed.machines.first?.questions.isEmpty ?? true) }
                let card = try #require(resumed.machines.first?.questions.first)
                #expect(card.sessionId == session.sessionId)
                let negativeOption = card.question.options.first { $0.isNo }
                let no = try #require(negativeOption)
                resumed.answer(sessionId: card.sessionId, questionId: card.question.id,
                    answer: no.value, claudeSessionId: card.claudeSessionId)
                let effect = try await next(from: output)
                #expect(effect["kind"] as? String == "effect")
                let body = try #require(effect["body"] as? [String: Any])
                let hookOutput = try #require(body["hookSpecificOutput"] as? [String: Any])
                let decision = try #require(hookOutput["decision"] as? [String: Any])
                #expect(decision["behavior"] as? String == "deny")
                try await until("correlated delivered answer and resolved card") {
                    resumed.latestOperationNotice == "Answer delivered." && resumed.machines.first?.questions.isEmpty == true
                }
                resumed.stop()
            } catch { resumed.stop(); throw error }
            try send(["kind": "stop"], to: input)
            try await until("owned fixture cleanup") { !process.isRunning }
            #expect(process.terminationStatus == 0)
        } catch {
            Issue.record("Source interop state: \(String(describing: store.machines.first?.status)); saved count: \(store.persistableEndpoints.count); error code: \(store.latestError?.code ?? "none")")
            store.stop(); throw error
        }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_RELAY_REFERENCE_ROOT"] != nil,
        "Requires the source relay composite; see docs/native-relay-x2.md."))
    func survivesSourceHeartbeatWindowWithoutReconnect() async throws {
        let reference = try #require(ProcessInfo.processInfo.environment["REMI_RELAY_REFERENCE_ROOT"])
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Integration/relay-fixture.ts")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["bun", script.path, reference]
        let output = Pipe()
        let input = Pipe()
        process.standardOutput = output
        process.standardInput = input
        process.standardError = FileHandle.standardError
        try process.run()
        defer { cleanupFixture(process, input: input) }

        let offer = try await next(from: output)
        let token = try #require(offer["token"] as? String)
        let identity = ClientIdentity()
        let endpoint = try MachineEndpoint.pairingOverRelay(token)
        let store = MachineStore(
            endpoints: [],
            identity: identity,
            clientVersion: "native-x2-heartbeat",
            clientId: "owned-swift-heartbeat-pair"
        )
        store.addMachine(endpoint)
        let comparison = try await next(from: output)
        let fingerprint = try #require(comparison["fingerprint"] as? String)
        try await until("Swift heartbeat confirmation fingerprint") {
            store.machines.first?.status == .waitingForRelayConfirmation(fingerprint: fingerprint)
        }
        try send(["kind": "confirm", "fingerprint": fingerprint], to: input)
        try await until("paired heartbeat source connection") {
            store.machines.first?.status == .connected && store.machines.first?.hasLoadedSessions == true
        }
        let saved = try #require(store.persistableEndpoints.first)
        store.stop()

        let probe = RelayConnectionProbe()
        let connection = RemiConnection(
            configuration: RemiConnectionConfiguration(
                url: try #require(saved.webSocketURL),
                clientVersion: "native-x2-heartbeat",
                clientId: "owned-swift-heartbeat-probe",
                relayPin: saved.relayPin
            ),
            identity: identity,
            stateHandler: { _ in },
            eventHandler: { event in Task { @MainActor in probe.receive(event) } }
        )
        await connection.start()
        do {
            try await until("standalone heartbeat connection hello") { probe.helloCount == 1 }
            try await Task.sleep(for: .seconds(95))
            #expect(probe.helloCount == 1, "The daemon must not reap and reconnect a responsive client")
            try await connection.send(SessionListRequestMessage(
                id: "owned-after-heartbeat-window",
                timestamp: "owned",
                includeExternal: true
            ))
            try await until("request after daemon heartbeat window") { probe.sessionCount == 1 }
            await connection.stop()
        } catch {
            await connection.stop()
            throw error
        }
        try send(["kind": "stop"], to: input)
        try await until("owned heartbeat fixture cleanup") { !process.isRunning }
        #expect(process.terminationStatus == 0)
    }

    private func until(_ label: String, condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(25))
        while ContinuousClock.now < deadline {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        Issue.record("Timed out: \(label)")
        throw CocoaError(.fileReadUnknown)
    }

    private func send(_ message: [String: String], to pipe: Pipe) throws {
        try pipe.fileHandleForWriting.write(contentsOf: JSONSerialization.data(withJSONObject: message) + Data([10]))
    }

    private func cleanupFixture(_ process: Process, input: Pipe) {
        guard process.isRunning else { return }
        try? send(["kind": "stop"], to: input)
        let deadline = Date().addingTimeInterval(10)
        while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
        if process.isRunning {
            process.terminate()
            let terminationDeadline = Date().addingTimeInterval(10)
            while process.isRunning && Date() < terminationDeadline { Thread.sleep(forTimeInterval: 0.02) }
        }
        #expect(!process.isRunning, "Owned source fixture cleanup exceeded its bound")
    }

    private func next(from pipe: Pipe) async throws -> [String: Any] {
        let handle = pipe.fileHandleForReading
        let data = try await Task.detached {
            var result = Data()
            while result.count < 4096 {
                guard let byte = try handle.read(upToCount: 1), !byte.isEmpty else { throw CocoaError(.fileReadUnknown) }
                if byte == Data([10]) { return result }
                result.append(byte)
            }
            throw CocoaError(.fileReadTooLarge)
        }.value
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

@MainActor
private final class RelayConnectionProbe {
    var helloCount = 0
    var sessionCount = 0
    var cleanEndCount = 0
    var uncleanEndCount = 0
    func receive(_ event: RemiInboundEvent) {
        switch event {
        case .hello: helloCount += 1
        case .sessions: sessionCount += 1
        case .relayStreamEnded(let clean):
            if clean { cleanEndCount += 1 } else { uncleanEndCount += 1 }
        default: break
        }
    }
}
#endif
