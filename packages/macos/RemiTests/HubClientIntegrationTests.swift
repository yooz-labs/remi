//
//  HubClientIntegrationTests.swift
//  RemiTests
//
//  Real-hub integration (#649, no mocks): spawns `REMI_TEST_BINARY serve`
//  with an isolated $HOME, then drives the ACTUAL discovery + handshake path
//  (HTTP probe -> ws hello -> hello_ack null-sessionId detection).
//
//  Skipped unless REMI_TEST_BINARY points at a remi binary. xcodebuild only
//  forwards env vars carrying the TEST_RUNNER_ prefix into the test process:
//    TEST_RUNNER_REMI_TEST_BINARY=$PWD/dist/remi xcodebuild test -project \
//      packages/macos/Remi.xcodeproj -scheme Remi
//  CI (macos-app.yml) builds the daemon binary and exports the variable so
//  these run for real.
//

import XCTest


final class HubClientIntegrationTests: XCTestCase {
    private var process: Process?
    private var homeDir: URL?

    override func tearDown() {
        process?.terminate()
        process?.waitUntilExit()
        if let homeDir { try? FileManager.default.removeItem(at: homeDir) }
        super.tearDown()
    }

    private func requireBinary() throws -> String {
        guard let binary = ProcessInfo.processInfo.environment["REMI_TEST_BINARY"],
            FileManager.default.isExecutableFile(atPath: binary)
        else {
            throw XCTSkip("REMI_TEST_BINARY not set; skipping real-hub integration test")
        }
        return binary
    }

    func testDiscoversRealHubAndDetectsSessionlessAck() async throws {
        let binary = try requireBinary()
        // Port inside the app's scan range but above the common live ones.
        let port = 18781

        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("remi-macos-it-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        homeDir = home

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: binary)
        proc.arguments = [
            "serve", "--port", String(port), "--bind", "127.0.0.1",
            "--no-mdns", "--no-relay", "--no-telegram", "--no-auth",
        ]
        var env = ProcessInfo.processInfo.environment
        env["HOME"] = home.path
        env.removeValue(forKey: "REMI_PORT")
        env.removeValue(forKey: "REMI_SPAWNED_CHILD")
        proc.environment = env
        proc.standardOutput = Pipe()
        proc.standardError = Pipe()
        try proc.run()
        process = proc

        // 1. The scanner finds the hub via the real HTTP probe.
        var responders: [Int] = []
        for _ in 0..<40 {  // up to ~10 s for the hub to boot
            responders = await HubClient.probe(ports: HubClient.scanOrder(hintPort: port))
            if responders.contains(port) { break }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        XCTAssertTrue(responders.contains(port), "scan never found the hub on \(port)")

        // 2. Real WS handshake: query hello -> hello_ack with LITERAL null
        //    sessionId (the hub marker), skipping unknown frames (e.g. ack).
        let ws = URLSession.shared.webSocketTask(
            with: URL(string: "ws://127.0.0.1:\(port)/ws")!)
        ws.resume()
        let hello = HelloFrame(clientVersion: "0.1.0-test", clientId: "it-client")
        let helloData = try JSONEncoder().encode(hello)
        try await ws.send(.string(String(data: helloData, encoding: .utf8)!))

        var sawHubAck = false
        var sawHubStatus = false
        for _ in 0..<10 {
            let message = try await ws.receive()
            guard case let .string(text) = message else { continue }
            let data = Data(text.utf8)
            guard
                let envelope = try? JSONDecoder().decode(IncomingFrameType.self, from: data)
            else { continue }
            if envelope.type == "hello_ack" {
                sawHubAck = HubClient.helloAckHasNullSessionId(data)
            }
            if envelope.type == "hub_status" {
                let status = try JSONDecoder().decode(HubStatusFrame.self, from: data)
                XCTAssertEqual(status.localClients, 0)  // query client never counts
                sawHubStatus = true
            }
            if sawHubAck && sawHubStatus { break }
        }
        XCTAssertTrue(sawHubAck, "never received a session-less hello_ack")
        XCTAssertTrue(sawHubStatus, "never received the hub_status census")
        ws.cancel(with: .goingAway, reason: nil)
    }
}
