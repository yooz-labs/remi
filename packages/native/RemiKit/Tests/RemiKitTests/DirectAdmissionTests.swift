import Foundation
import Testing
@testable import RemiKit

#if os(macOS)
private actor AdmissionRecorder {
    var states: [RemiConnectionState] = []
    var events: [RemiInboundEvent] = []
    func record(_ value: RemiConnectionState) { states.append(value) }
    func record(_ value: RemiInboundEvent) { events.append(value) }
    var rejected: Bool { states.contains { if case .rejected = $0 { true } else { false } } }
    var receivedDomain: Bool { events.contains { if case .question = $0 { true } else if case .sessions = $0 { true } else { false } } }
    var complete: Bool { rejected || receivedDomain }
}

struct DirectAdmissionTests {
    @Test(arguments: ["preauth", "prehello", "prehello-list", "wrong-key", "admitted", "legacy", "silent", "retry-without-challenge"])
    func applicationFramesRequireVerifiedHello(mode: String) async throws {
        let script = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Integration/direct-admission-peer.ts")
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-admission-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let peer = Process()
        peer.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        peer.arguments = ["bun", script.path, mode]
        peer.currentDirectoryURL = directory
        peer.environment = ["PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"]
        let output = Pipe(), input = Pipe()
        peer.standardOutput = output; peer.standardInput = input; peer.standardError = FileHandle.standardError
        try peer.run()
        defer {
            try? input.fileHandleForWriting.close()
            if peer.isRunning { peer.terminate() }
            peer.waitUntilExit()
        }
        var line = Data()
        for try await byte in output.fileHandleForReading.bytes {
            if byte == 10 { break }; line.append(byte)
        }
        let metadata = try #require(JSONSerialization.jsonObject(with: line) as? [String: Any])
        let port = try #require(metadata["port"] as? Int)
        let machineID = try #require(metadata["machineID"] as? String)
        let recorder = AdmissionRecorder()
        let connection = RemiConnection(configuration: .init(url: try #require(URL(string: "ws://127.0.0.1:\(port)/ws")),
            clientVersion: "test", clientId: "test", expectedMachineID: mode == "legacy" ? nil : machineID,
            directConnectTimeout: .seconds(1), directAuthenticationTimeout: .milliseconds(200),
            directRetryPolicy: .coordinatedPairing),
            identity: ClientIdentity(), stateHandler: { value in Task { await recorder.record(value) } },
            eventHandler: { value in Task { await recorder.record(value) } })
        await connection.start()
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while ContinuousClock.now < deadline {
            if await recorder.complete { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let admitted = mode == "admitted" || mode == "legacy"
        #expect(await recorder.receivedDomain == admitted)
        #expect(await recorder.rejected == !admitted)
        if !admitted {
            do {
                try await connection.send(SessionListRequestMessage(id: "forbidden", timestamp: "test", includeExternal: false))
                Issue.record("Unadmitted socket accepted an application send")
            } catch { /* Refusal is required; no command may reach this peer. */ }
        }
        await connection.stop()
    }
}
#endif
