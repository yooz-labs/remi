import Foundation
import Testing
@testable import RemiKit

#if os(macOS)
/// An adversarial local peer tests the real direct connection and Store; it does
/// not replace daemon business logic or claim a device/relay qualification.
@MainActor @Suite(.serialized)
struct AnswerOutcomeWireTests {
    @Test(arguments: [
        ("delivered", "delivered"), ("stale", "stale"),
        ("stale-binding", "stale"), ("session-not-found", "stale"),
        ("conflict", "conflict"), ("busy", "busy"), ("uncertain", "uncertain"),
        ("future-outcome", "uncertain"), ("STALE-BINDING", "uncertain"), ("refused", "uncertain"),
    ])
    func secureNotificationOutcomeUsesTheSharedWireVocabulary(input: String, expected: String) {
        #expect(RelayNotificationAnswerOutcome.fromWire(input).rawValue == expected)
    }

    @Test(arguments: ["delivered", "stale", "stale-binding", "session-not-found", "conflict", "busy", "uncertain", "future-outcome", "STALE-BINDING", "non-string", "mismatch-request", "mismatch-session", "mismatch-question"])
    func localNotificationClassifiesCorrelatedWireOutcome(_ wireOutcome: String) async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Integration/answer-outcome-peer.ts")
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-answer-outcome-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let peer = Process()
        peer.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        peer.arguments = ["bun", script.path, wireOutcome]
        peer.currentDirectoryURL = directory
        peer.environment = ["PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"]
        let output = Pipe(), input = Pipe()
        peer.standardOutput = output; peer.standardInput = input; peer.standardError = FileHandle.standardError
        try peer.run()
        func stopPeer() async {
            try? input.fileHandleForWriting.close()
            let deadline = ContinuousClock.now.advanced(by: .seconds(3))
            while peer.isRunning, ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(20)) }
            if peer.isRunning { peer.terminate() }
            let final = ContinuousClock.now.advanced(by: .seconds(2))
            while peer.isRunning, ContinuousClock.now < final { try? await Task.sleep(for: .milliseconds(20)) }
            #expect(!peer.isRunning, "Owned peer did not stop")
        }
        var store: MachineStore?
        do {
            var line = Data()
            for try await byte in output.fileHandleForReading.bytes { if byte == 10 { break }; line.append(byte) }
            let metadata = try #require(JSONSerialization.jsonObject(with: line) as? [String: Any])
            let port = try #require(metadata["port"] as? Int)
            let publicKey = try #require(metadata["publicKey"] as? String)
            let sessionId = try #require(metadata["sessionId"] as? String)
            let questionId = try #require(metadata["questionId"] as? String)
            let endpoint = MachineEndpoint(host: "127.0.0.1", port: port, expectedPublicKey: publicKey)
            let current = MachineStore(endpoints: [endpoint], identity: ClientIdentity(), clientVersion: "owned", clientId: "owned")
            store = current
            current.start()
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while ContinuousClock.now < deadline {
                if current.machines.first?.status == .connected, current.machines.first?.questions.count == 1 { break }
                try await Task.sleep(for: .milliseconds(20))
            }
            let machine = try #require(current.machines.first)
            #expect(machine.status == .connected)
            let destination = RemiNavigationDestination(machineID: machine.id, sessionID: sessionId, questionID: questionId)
            let plan = try #require(current.localQuestionNotification(for: destination))
            let outcome = await current.answerLocalNotification(plan, identifier: LocalQuestionNotificationPlan.noIdentifier)
            switch wireOutcome {
            case "delivered": #expect(outcome == .delivered)
            case "stale", "stale-binding", "session-not-found", "mismatch-request", "mismatch-session", "mismatch-question": #expect(outcome == .stale)
            case "busy": #expect(outcome == .busy)
            default: #expect(outcome == .uncertain)
            }
            // A receipt alone is not authoritative question removal or permission to replay.
            #expect(current.machines.first?.questions.count == 1)
            current.stop()
        } catch {
            store?.stop(); await stopPeer(); throw error
        }
        await stopPeer()
        let peerResult = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("peer-result.json"))) as? [String: Int])
        #expect(peerResult["answerCount"] == 1, "The native client must not replay the answer")
    }
}
#endif
