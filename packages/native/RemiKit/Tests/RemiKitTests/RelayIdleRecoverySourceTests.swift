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
    var rejectionReason: String?
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
        case .rejected(let reason): rejected = true; rejectionReason = reason; states.append("rejected")
        default: break
        }
    }
}

/// Real native actor, source HubRelay and Worker with injected drops, BYEs, malformed
/// frames, revocation and pairing refusal. Canned replies exercise real routing.
/// Bun 1.3.11: `REMI_IDLE_RELAY_TESTS=1 REMI_IDLE_BUN=/absolute/path/to/bun swift test --package-path packages/native/RemiKit --filter RelayIdleRecoverySourceTests`
/// REMI_IDLE_BUN may be omitted when the pinned Bun is on PATH.
@MainActor
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["REMI_IDLE_RELAY_TESTS"] == "1"))
struct RelayIdleRecoverySourceTests {
    private enum Failure: Error { case deadline(String) }

    @Test
    func transientLossesAfterAdmittedEpisodesRemainRetryable() async throws {
        try await withFixture { active, probe, command in
            try await until("initial admitted hello") { probe.hellos == 1 || probe.rejected }
            try #require(probe.hellos == 1 && !probe.rejected)
            for episode in 1...5 {
                try await Task.sleep(for: .seconds(30))
                let oldOrigin = try #require(await active.chatOrigin())
                // A correlated real encrypted census verifies each admitted episode before loss.
                let previousLists = probe.lists
                try await active.send(SessionListRequestMessage(id: UUID().uuidString.lowercased(),
                    timestamp: Date().ISO8601Format(), includeExternal: false))
                try await until("census episode \(episode)") { probe.lists > previousLists || probe.rejected }
                try #require(probe.lists > previousLists && !probe.rejected)
                #expect(try await command("drop")["kind"] as? String == "dropped")
                try await until("reconnect episode \(episode)") {
                    probe.hellos >= episode + 1 || probe.rejected
                }
                if !probe.rejected {
                    let stale = UserInputMessage(id: UUID().uuidString.lowercased(), timestamp: Date().ISO8601Format(),
                        sessionId: UUID().uuidString.lowercased(), content: "owned stale input", claudeSessionId: nil)
                    #expect(await active.sendChat(stale, origin: oldOrigin) == .notInvoked)
                }
                let stats = try await command("stats")
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
            let current = UserInputMessage(id: UUID().uuidString.lowercased(), timestamp: Date().ISO8601Format(),
                sessionId: UUID().uuidString.lowercased(), content: "owned trace input", claudeSessionId: nil)
            _ = await active.sendChat(current, origin: try #require(await active.chatOrigin()))
            try await until("route trace") { (try await command("stats")["inputs"] as? [String]) == [current.id] }
        }
    }

    @Test
    func freshPreHelloFailuresRemainBoundedAfterAdmission() async throws {
        try await withFixture { _, probe, command in
            try await until("initial hello") { probe.hellos == 1 || probe.rejected }
            try #require(probe.hellos == 1 && !probe.rejected)
            try await Task.sleep(for: .seconds(30))
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

    // Unlike the post-admission count above, this holds READY without hello_ack long
    // enough to distinguish a mistaken READY-based health clock from the Hello clock.
    @Test
    func readyWithoutHelloCannotRestartTheRetryBudget() async throws {
        try await withFixture { _, probe, command in
            try await until("initial hello") { probe.hellos == 1 || probe.rejected }
            try #require(probe.hellos == 1 && !probe.rejected)
            #expect(try await command("prehello-delayed")["kind"] as? String == "prehello-delayed")
            #expect(try await command("drop")["kind"] as? String == "dropped")
            try await until("terminal cap or extra connection", timeout: .seconds(70)) {
                probe.rejected || probe.states.filter { $0.hasPrefix("connecting:") }.count >= 7
            }
            #expect(probe.rejected)
            #expect(probe.states.filter { $0.hasPrefix("connecting:") }.count == 5)
            #expect(probe.hellos == 1)
            #expect((try await command("stats")["inputs"] as? [String]) == [])
        }
    }

    @Test
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

    @Test
    func oneShotReadyLossDoesNotReconnect() async throws {
        try await withFixture(oneShot: true) { active, probe, command in
            try await active.waitForRelayReady(until: .now.advanced(by: .seconds(10)))
            #expect(try await command("drop")["kind"] as? String == "dropped")
            try await until("one-shot terminal loss") { probe.rejected }
            try await Task.sleep(for: .milliseconds(1500))
            #expect(probe.hellos == 0)
            #expect(probe.states.filter { $0.hasPrefix("connecting:") }.count == 1)
            #expect((try await command("stats")["inputs"] as? [String]) == [])
        }
    }

    @Test
    func unadoptedRecoveryProbeLossDoesNotReconnect() async throws {
        try await withFixture(recoveryProbe: true) { _, probe, command in
            try await until("recovery probe hello") { probe.hellos == 1 || probe.rejected }
            try #require(probe.hellos == 1 && !probe.rejected)
            #expect(try await command("drop")["kind"] as? String == "dropped")
            try await until("recovery probe terminal loss") { probe.rejected }
            try await Task.sleep(for: .milliseconds(1500))
            #expect(probe.states.filter { $0.hasPrefix("connecting:") }.count == 1)
            #expect((try await command("stats")["inputs"] as? [String]) == [])
        }
    }

    @Test
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

    @Test
    func orderlyByeStartsFreshReconnectBudget() async throws {
        try await withFixture { active, probe, command in
            try await until("initial hello") { probe.hellos == 1 || probe.rejected }
            try #require(probe.hellos == 1 && !probe.rejected)
            for hello in 2...3 {
                try await Task.sleep(for: .seconds(30))
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

    @Test
    func expectedMachineIDMismatchIsTerminal() async throws {
        try await withFixture(wrongMachine: true) { _, probe, command in
            try await until("machine identity rejection") { probe.rejected }
            #expect(probe.rejectionReason == "The machine identity did not match its authenticated key.")
            #expect(probe.hellos == 0)
            try await Task.sleep(for: .milliseconds(1500))
            #expect(probe.states.filter { $0.hasPrefix("connecting:") }.count == 1)
            #expect((try await command("stats")["inputs"] as? [String]) == [])
        }
    }

    // The pairing Hello arrived with no offer and the client was closed without a hello_ack.
    @Test
    func pairingWithoutAnOfferIsTerminal() async throws {
        try await withFixture(pairWithoutOffer: true) { _, probe, command in
            try await until("pairing refusal") { probe.rejected }
            let stats = try await command("stats")
            #expect(stats["pairHellosWithoutOffer"] as? Int == 1)
            #expect(probe.rejectionReason == "The relay connection closed. Pair again if this machine has not been saved.")
            #expect(probe.hellos == 0)
            try await Task.sleep(for: .milliseconds(1500))
            #expect(probe.states.filter { $0.hasPrefix("connecting:") }.count == 1)
            #expect((stats["inputs"] as? [String]) == [])
        }
    }

    @Test
    func immediateDropsReachTheCap() async throws {
        try await withFixture { _, probe, command in
            for hello in 1...5 {
                try await until("short episode \(hello)") { probe.hellos >= hello || probe.rejected }
                try #require(probe.hellos == hello && !probe.rejected)
                #expect(try await command("drop")["kind"] as? String == "dropped")
            }
            try await until("short episode cap or extra Hello") { probe.rejected || probe.hellos >= 6 }
            try await Task.sleep(for: .milliseconds(1500))
            #expect(probe.rejected)
            #expect(probe.hellos == 5)
            #expect(probe.states.filter { $0.hasPrefix("retrying:") } == (1...4).map { "retrying:\($0)" })
            #expect((try await command("stats")["inputs"] as? [String]) == [])
        }
    }

    @Test
    func immediateByesBackOff() async throws {
        try await withFixture { _, probe, command in
            for hello in 1...3 {
                try await until("short BYE \(hello)") { probe.hellos >= hello || probe.rejected }
                try #require(probe.hellos == hello && !probe.rejected)
                #expect(try await command("bye")["kind"] as? String == "bye")
            }
            try await until("third BYE retry") {
                probe.states.filter { $0.hasPrefix("retrying:") }.count >= 3 || probe.rejected
            }
            #expect(!probe.rejected)
            #expect(probe.states.filter { $0.hasPrefix("retrying:") } == (1...3).map { "retrying:\($0)" })
            #expect((try await command("stats")["inputs"] as? [String]) == [])
        }
    }

    @Test
    func preHelloByesIncreaseRetryAttempts() async throws {
        try await withFixture { _, probe, command in
            try await until("initial hello") { probe.hellos == 1 || probe.rejected }
            try #require(probe.hellos == 1 && !probe.rejected)
            #expect(try await command("prehello-bye")["kind"] as? String == "prehello-bye")
            #expect(try await command("bye")["kind"] as? String == "bye")
            try await until("pre-Hello BYE retries", timeout: .seconds(30)) {
                probe.states.filter { $0.hasPrefix("retrying:") }.count >= 3 || probe.rejected
            }
            #expect(probe.states.filter { $0.hasPrefix("retrying:") }.prefix(3) == ["retrying:1", "retrying:2", "retrying:3"])
            #expect(probe.hellos == 1)
            #expect((try await command("stats")["inputs"] as? [String]) == [])
        }
    }

    @Test
    func textFrameAfterHelloIsTerminal() async throws {
        try await withFixture { _, probe, command in
            try await until("initial hello") { probe.hellos == 1 || probe.rejected }
            try #require(probe.hellos == 1 && !probe.rejected)
            #expect(try await command("text")["kind"] as? String == "text")
            try await until("text frame rejection or retry") {
                probe.rejected || probe.states.filter { $0.hasPrefix("connecting:") }.count > 1
            }
            try await Task.sleep(for: .milliseconds(1500))
            #expect(probe.rejected)
            #expect(probe.states.filter { $0.hasPrefix("connecting:") }.count == 1)
            #expect(probe.hellos == 1)
            #expect((try await command("stats")["inputs"] as? [String]) == [])
        }
    }

    @Test
    func revocationAfterHelloEndsWithinRetryCap() async throws {
        try await withFixture { _, probe, command in
            try await until("initial hello") { probe.hellos == 1 || probe.rejected }
            try #require(probe.hellos == 1 && !probe.rejected)
            #expect(try await command("revoke")["kind"] as? String == "revoke")
            try await until("revocation rejection", timeout: .seconds(40)) { probe.rejected }
            #expect(probe.states.filter { $0.hasPrefix("connecting:") }.count <= 5)
            #expect(probe.hellos == 1)
            #expect((try await command("stats")["inputs"] as? [String]) == [])
        }
    }

    private func withFixture(
        preHelloInitially: Bool = false,
        oneShot: Bool = false,
        recoveryProbe: Bool = false,
        wrongMachine: Bool = false,
        pairWithoutOffer: Bool = false,
        _ body: (RemiConnection, RelayIdleProbe, @MainActor (String) async throws -> [String: Any]) async throws -> Void
    ) async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/liveness-relay-fixture.ts")
        let identity = ClientIdentity()
        let process = Process()
        var arguments = [identity.publicKeyBase64]
        if preHelloInitially { arguments.append("prehello") }
        if pairWithoutOffer { arguments.append("pair-no-offer") }
        let own = try OwnedRecoveryFixture.configure(process, script: script, arguments: arguments,
            bunExecutable: ProcessInfo.processInfo.environment["REMI_IDLE_BUN"])
        let input = Pipe(), output = Pipe()
        let log = own.appendingPathComponent("source-relay.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        let errors = try FileHandle(forWritingTo: log)
        process.standardInput = input; process.standardOutput = output; process.standardError = errors
        try process.run()
        let watchdog = Task {
            try? await Task.sleep(for: .seconds(260))
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
                clientVersion: "owned-idle-relay", clientId: "owned-idle-relay",
                expectedMachineID: wrongMachine ? String(repeating: "0", count: 32) : nil, relayPin: pin,
                directRetryPolicy: recoveryProbe ? .recoveryProbe : .runtime),
                identity: identity,
                relayPairingSecret: pairWithoutOffer ? Data(repeating: 42, count: 32) : nil,
                stateHandler: { state in Task { @MainActor in probe.transition(state) } },
                eventHandler: { event in Task { @MainActor in probe.receive(event) } })
            connection = active
            if oneShot { try await active.configureOneShot() }
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
