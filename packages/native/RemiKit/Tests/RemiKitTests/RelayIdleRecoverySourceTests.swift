import Foundation
import Testing
@testable import RemiKit

#if os(macOS)
@MainActor
private final class RelayIdleProbe {
    var hellos = 0
    var lists = 0
    var cleanEnds = 0
    var rejected = false
    var states: [String] = []

    func receive(_ event: RemiInboundEvent) {
        switch event {
        case .hello: hellos += 1
        case .sessions: lists += 1
        case .relayStreamEnded(let clean): if clean { cleanEnds += 1 }
        default: break
        }
    }

    func transition(_ state: RemiConnectionState) {
        switch state {
        case .connecting(let attempt): states.append("connecting:\(attempt)")
        case .retrying(let attempt, _): states.append("retrying:\(attempt)")
        case .connected: states.append("connected")
        case .rejected: rejected = true; states.append("rejected")
        default: break
        }
    }
}

/// Real native actor + signed, encrypted source HubRelay + owned workerd Worker.
/// The fixture cuts its own READY pipe without a BYE; no user input is sent.
@MainActor
@Suite(.serialized)
struct RelayIdleRecoverySourceTests {
    private enum Failure: Error { case deadline(String) }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_IDLE_RELAY_TESTS"] == "1",
        "Owned real Worker/HubRelay test, run separately from timing-sensitive native suites."))
    func transientLossesAfterAdmittedEpisodesRemainRetryable() async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/liveness-relay-fixture.ts")
        let identity = ClientIdentity()
        let process = Process()
        let own = try OwnedRecoveryFixture.configure(process, script: script, arguments: [identity.publicKeyBase64],
            bunExecutable: ProcessInfo.processInfo.environment["REMI_IDLE_BUN"])
        let input = Pipe(), output = Pipe()
        let log = own.appendingPathComponent("source-relay.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        let errors = try FileHandle(forWritingTo: log)
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        try process.run()
        let watchdog = Task {
            try? await Task.sleep(for: .seconds(90))
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
            #expect(!process.isRunning, "Owned Worker fixture did not stop before its cleanup deadline")
            try? errors.close()
            print("Owned relay fixture log: \(log.path)")
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
            let probe = RelayIdleProbe()
            let active = RemiConnection(configuration: .init(url: try #require(pin.clientURL),
                clientVersion: "owned-idle-relay", clientId: "owned-idle-relay", relayPin: pin),
                identity: identity,
                stateHandler: { state in Task { @MainActor in probe.transition(state) } },
                eventHandler: { event in Task { @MainActor in probe.receive(event) } })
            connection = active
            await active.start()
            try await until("initial admitted hello") { probe.hellos == 1 || probe.rejected }
            try #require(probe.hellos == 1 && !probe.rejected)
            for episode in 1...5 {
                // A correlated real encrypted census verifies each admitted episode before loss.
                let previousLists = probe.lists
                try await active.send(SessionListRequestMessage(id: UUID().uuidString.lowercased(),
                    timestamp: Date().ISO8601Format(), includeExternal: false))
                try await until("census episode \(episode)") { probe.lists > previousLists || probe.rejected }
                try #require(probe.lists > previousLists && !probe.rejected)
                try input.fileHandleForWriting.write(contentsOf: Data("drop\n".utf8))
                #expect(try await line()["kind"] as? String == "dropped")
                try await until("reconnect episode \(episode)") {
                    probe.hellos >= episode + 1 || probe.rejected
                }
                try input.fileHandleForWriting.write(contentsOf: Data("stats\n".utf8))
                let stats = try await line()
                #expect((stats["inputs"] as? [String]) == [])
                print("Owned loss \(episode): hellos=\(probe.hellos) states=\(probe.states)")
                try #require(probe.hellos == episode + 1 && !probe.rejected,
                    "A fresh transient loss after an admitted episode should remain retryable")
            }
            let previousLists = probe.lists
            try await active.send(SessionListRequestMessage(id: UUID().uuidString.lowercased(),
                timestamp: Date().ISO8601Format(), includeExternal: false))
            try await until("final recovered census") { probe.lists > previousLists || probe.rejected }
            #expect(probe.lists > previousLists && !probe.rejected)
            await stop()
        } catch { await stop(); throw error }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_IDLE_RELAY_TESTS"] == "1"))
    func freshPreHelloFailuresRemainBoundedAfterAdmission() async throws {
        try await withFixture { _, probe, command in
            try await until("initial hello") { probe.hellos == 1 || probe.rejected }
            try #require(probe.hellos == 1 && !probe.rejected)
            #expect(try await command("prehello-on")["kind"] as? String == "prehello-on")
            #expect(try await command("drop")["kind"] as? String == "dropped")
            try await until("five unadmitted connections", timeout: .seconds(30)) { probe.rejected }
            let stats = try await command("stats")
            print("Post-admission pre-Hello controls: drops=\(stats["preHelloDrops"] ?? "?") states=\(probe.states)")
            #expect(stats["preHelloDrops"] as? Int == 5)
            #expect((stats["inputs"] as? [String]) == [])
            #expect(probe.hellos == 1)
        }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_IDLE_RELAY_TESTS"] == "1"))
    func coldPreHelloFailuresRemainBounded() async throws {
        try await withFixture(preHelloInitially: true) { _, probe, command in
            try await until("cold unadmitted connection cap", timeout: .seconds(30)) { probe.rejected }
            let stats = try await command("stats")
            print("Cold pre-Hello controls: drops=\(stats["preHelloDrops"] ?? "?") states=\(probe.states)")
            #expect(stats["preHelloDrops"] as? Int == 5)
            #expect(probe.hellos == 0)
            #expect((stats["inputs"] as? [String]) == [])
        }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_IDLE_RELAY_TESTS"] == "1"))
    func malformedEncryptedPayloadAfterHelloRemainsTerminal() async throws {
        try await withFixture { _, probe, command in
            try await until("initial hello") { probe.hellos == 1 || probe.rejected }
            try #require(probe.hellos == 1 && !probe.rejected)
            #expect(try await command("drop")["kind"] as? String == "dropped")
            try await until("replacement hello") { probe.hellos == 2 || probe.rejected }
            try #require(probe.hellos == 2 && !probe.rejected)
            let before = probe.states.filter { $0.hasPrefix("connecting:") }.count
            #expect(try await command("corrupt")["kind"] as? String == "corrupt")
            try await until("encrypted malformed rejection") { probe.rejected }
            try await Task.sleep(for: .milliseconds(1500))
            #expect(probe.states.filter { $0.hasPrefix("connecting:") }.count == before)
            #expect(probe.hellos == 2)
            #expect((try await command("stats")["inputs"] as? [String]) == [])
            print("Authenticated malformed control: states=\(probe.states)")
        }
    }

    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_IDLE_RELAY_TESTS"] == "1"))
    func orderlyByeStartsFreshReconnectBudget() async throws {
        try await withFixture { active, probe, command in
            try await until("initial hello") { probe.hellos == 1 || probe.rejected }
            try #require(probe.hellos == 1 && !probe.rejected)
            for hello in 2...3 {
                #expect(try await command("bye")["kind"] as? String == "bye")
                try await until("orderly replacement \(hello)") { probe.hellos >= hello || probe.rejected }
                try #require(probe.hellos == hello && !probe.rejected)
            }
            try await until("both authenticated stream-end events") { probe.cleanEnds >= 2 }
            #expect(probe.cleanEnds == 2)
            let retries = probe.states.filter { $0.hasPrefix("retrying:") }
            print("Orderly BYE controls: states=\(probe.states)")
            #expect(retries == ["retrying:1", "retrying:1"])
            let previousLists = probe.lists
            try await active.send(SessionListRequestMessage(id: UUID().uuidString.lowercased(),
                timestamp: Date().ISO8601Format(), includeExternal: false))
            try await until("orderly recovered census") { probe.lists > previousLists || probe.rejected }
            #expect(probe.lists > previousLists && !probe.rejected)
            #expect((try await command("stats")["inputs"] as? [String]) == [])
        }
    }

    private func withFixture(
        preHelloInitially: Bool = false,
        _ body: (RemiConnection, RelayIdleProbe, @MainActor (String) async throws -> [String: Any]) async throws -> Void
    ) async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/liveness-relay-fixture.ts")
        let identity = ClientIdentity()
        let process = Process()
        var arguments = [identity.publicKeyBase64]
        if preHelloInitially { arguments.append("prehello") }
        let own = try OwnedRecoveryFixture.configure(process, script: script, arguments: arguments,
            bunExecutable: ProcessInfo.processInfo.environment["REMI_IDLE_BUN"])
        let input = Pipe(), output = Pipe()
        let log = own.appendingPathComponent("source-relay.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        let errors = try FileHandle(forWritingTo: log)
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        try process.run()
        let watchdog = Task {
            try? await Task.sleep(for: .seconds(90))
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
            #expect(!process.isRunning, "Owned Worker fixture did not stop")
            try? errors.close()
            print("Owned relay fixture log: \(log.path)")
        }
        func line() async throws -> [String: Any] {
            let data = try await Self.readLine(output.fileHandleForReading)
            return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        }
        func command(_ name: String) async throws -> [String: Any] {
            try input.fileHandleForWriting.write(contentsOf: Data("\(name)\n".utf8))
            return try await line()
        }
        do {
            let ready = try await line()
            #expect(ready["kind"] as? String == "ready")
            let pin = try RelayMachinePin(relayURL: #require(ready["relayURL"] as? String),
                machinePublicKey: #require(ready["machinePublicKey"] as? String))
            let probe = RelayIdleProbe()
            let active = RemiConnection(configuration: .init(url: try #require(pin.clientURL),
                clientVersion: "owned-idle-relay", clientId: "owned-idle-relay", relayPin: pin),
                identity: identity,
                stateHandler: { state in Task { @MainActor in probe.transition(state) } },
                eventHandler: { event in Task { @MainActor in probe.receive(event) } })
            connection = active
            await active.start()
            try await body(active, probe, command)
            await stop()
        } catch { await stop(); throw error }
    }

    private func until(_ label: String, timeout: Duration = .seconds(16),
                       _ condition: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: timeout)
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
