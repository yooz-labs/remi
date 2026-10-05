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

import CryptoKit
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

    private enum AuthMode {
        case stock
        /// Only unrelated legacy hub-status tests opt out explicitly.
        case disabled
    }

    /// Spawns a real hub (session-less `serve`) on `port` with an isolated
    /// $HOME, stored on `process`/`homeDir` for tearDown to clean up. When
    /// `withAutostartInstalled` is set, pre-creates the exact LaunchAgent
    /// artifact `remi --install` would have written (#788) — no
    /// launchctl/systemctl involved, just the fs marker the hub checks for.
    private func spawnHub(
        binary: String, port: Int, withAutostartInstalled: Bool = false,
        authMode: AuthMode = .stock
    ) throws {
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("remi-macos-it-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        homeDir = home

        if withAutostartInstalled {
            let launchAgentsDir = home.appendingPathComponent("Library/LaunchAgents")
            try FileManager.default.createDirectory(
                at: launchAgentsDir, withIntermediateDirectories: true)
            let plist = launchAgentsDir.appendingPathComponent("com.yooz.remi.plist")
            try "<plist/>".write(to: plist, atomically: true, encoding: .utf8)
        }

        var arguments = [
            "serve", "--port", String(port), "--bind", "127.0.0.1",
            "--no-mdns", "--no-relay", "--no-telegram",
        ]
        if authMode == .disabled { arguments.append("--no-auth") }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: binary)
        proc.arguments = arguments
        // Explicit private state; never inherit the developer's REMI_HOME or credentials.
        proc.environment = [
            "HOME": home.path,
            "REMI_HOME": home.appendingPathComponent(".remi").path,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        ]
        proc.standardOutput = Pipe()
        proc.standardError = Pipe()
        try proc.run()
        process = proc
    }

    func testDiscoversRealHubAndDetectsSessionlessAck() async throws {
        let binary = try requireBinary()
        // Port inside the app's scan range but above the common live ones.
        let port = 18781
        try spawnHub(binary: binary, port: port, authMode: .disabled)

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
                // #788: the isolated $HOME this test spawns the hub with
                // never had `remi --install` run against it.
                XCTAssertEqual(status.autostart, "none")
                sawHubStatus = true
            }
            if sawHubAck && sawHubStatus { break }
        }
        XCTAssertTrue(sawHubAck, "never received a session-less hello_ack")
        XCTAssertTrue(sawHubStatus, "never received the hub_status census")
        ws.cancel(with: .goingAway, reason: nil)

        // 3. End-to-end through the REAL HubClient (#745 review): scan ->
        //    connect -> handshake -> hub_status all the way to the published
        //    state the menu bar reads. scanPorts injected so the client
        //    cannot latch onto unrelated daemons on the standard range.
        let client = await MainActor.run { HubClient(scanPorts: [port], identity: ClientIdentity(privateKey: .init())) }
        await MainActor.run { client.start() }
        var connectedAsHub = false
        for _ in 0..<60 {  // up to ~15 s
            let phase = await MainActor.run { client.phase }
            if case .connected(let p, let isHub) = phase, isHub {
                XCTAssertEqual(p, port)
                connectedAsHub = true
                break
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        XCTAssertTrue(connectedAsHub, "HubClient never reached connected(isHub: true)")
        // hub_status published: a fresh hub has no sessions and this
        // query-mode client never counts itself.
        var censusSeen = false
        for _ in 0..<20 {
            let (sessions, local, version, autostart) = await MainActor.run {
                (client.sessions, client.localClients, client.hubVersion, client.autostart)
            }
            if version != nil {
                XCTAssertEqual(sessions, 0)
                XCTAssertEqual(local, 0)
                // #788: fresh isolated $HOME, never `remi --install`ed.
                XCTAssertEqual(autostart, "none")
                censusSeen = true
                break
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        XCTAssertTrue(censusSeen, "hub_status never reached the published state")
        let autostartMissing = await MainActor.run { client.autostartMissing }
        XCTAssertTrue(autostartMissing, "autostartMissing should be true for an uninstalled hub")
        let statusLine = await MainActor.run { client.menuStatusLine }
        XCTAssertTrue(statusLine.contains("running on \(port)"), statusLine)
    }

    /// #788: a hub whose $HOME already carries the LaunchAgent artifact
    /// (as if `remi --install` had run) reports "installed", and
    /// autostartMissing reads false — no false warning.
    func testHubWithAutostartInstalledReportsInstalled() async throws {
        let binary = try requireBinary()
        let port = 18784
        try spawnHub(binary: binary, port: port, withAutostartInstalled: true, authMode: .disabled)

        let client = await MainActor.run { HubClient(scanPorts: [port], identity: ClientIdentity(privateKey: .init())) }
        await MainActor.run { client.start() }
        var autostart: String?
        for _ in 0..<60 {  // up to ~15 s
            autostart = await MainActor.run { client.autostart }
            if autostart != nil { break }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        XCTAssertEqual(autostart, "installed")
        let autostartMissing = await MainActor.run { client.autostartMissing }
        XCTAssertFalse(autostartMissing, "autostartMissing must be false once installed")
    }

    /// #773: the onboarding panel's "Check Again" button calls rescanNow();
    /// it should connect promptly once a hub appears, not wait out the
    /// scheduled backoff (which caps at 30 s).
    ///
    /// The client is deliberately never start()ed (#777 review, finding
    /// 4): start() would run the real scan-failure path, which schedules
    /// its own natural backoff chain — a later natural retry could then
    /// land the connection on its own, making the rescanNow() assertions
    /// below pass vacuously (or, on a slow natural-retry cycle, flake).
    /// forceUnreachableForTesting() drives phase to .unreachable directly
    /// so rescanNow() is the ONLY thing that can possibly connect here.
    func testRescanNowConnectsPromptly() async throws {
        let binary = try requireBinary()
        let port = 18782

        let client = await MainActor.run { HubClient(scanPorts: [port], identity: ClientIdentity(privateKey: .init())) }
        await MainActor.run { client.forceUnreachableForTesting() }

        // Start the real hub on that port, and wait for it to actually
        // bind before rescanning — rescanNow() fires one scan pass, not
        // a retry loop.
        try spawnHub(binary: binary, port: port, authMode: .disabled)
        for _ in 0..<40 {  // up to ~10 s
            let responders = await HubClient.probe(ports: [port])
            if responders.contains(port) { break }
            try await Task.sleep(nanoseconds: 250_000_000)
        }

        // Manual rescan connects well under the ~30 s backoff cap — and
        // with no backoff chain running, it's the only thing that could.
        let rescanStart = Date()
        await MainActor.run { client.rescanNow() }
        var connectedAsHub = false
        for _ in 0..<40 {  // up to ~10 s
            let phase = await MainActor.run { client.phase }
            if case .connected(let p, let isHub) = phase, isHub {
                XCTAssertEqual(p, port)
                connectedAsHub = true
                break
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        XCTAssertTrue(connectedAsHub, "rescanNow never reached connected(isHub: true)")
        XCTAssertLessThan(
            Date().timeIntervalSince(rescanStart), 15,
            "rescanNow took long enough to suggest it fell back to the backoff timer")
    }

    /// #773: a manual rescan while already connected must be a no-op —
    /// otherwise it would race the scheduled backoff rescan into two
    /// sockets (the isScanning/phase guards in scanAndConnect exist for
    /// exactly this).
    func testRescanNowIsNoOpWhileConnected() async throws {
        let binary = try requireBinary()
        let port = 18783
        try spawnHub(binary: binary, port: port, authMode: .disabled)

        let client = await MainActor.run { HubClient(scanPorts: [port], identity: ClientIdentity(privateKey: .init())) }
        await MainActor.run { client.start() }
        var connectedAsHub = false
        for _ in 0..<60 {  // up to ~15 s
            let phase = await MainActor.run { client.phase }
            if case .connected(let p, let isHub) = phase, isHub {
                XCTAssertEqual(p, port)
                connectedAsHub = true
                break
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        XCTAssertTrue(connectedAsHub, "client never connected to the real hub")

        await MainActor.run { client.rescanNow() }
        try await Task.sleep(nanoseconds: 2_000_000_000)  // short settle window
        let phaseAfter = await MainActor.run { client.phase }
        XCTAssertEqual(phaseAfter, .connected(port: port, isHub: true))
    }

    /// Stock hub challenges an unknown app, records a candidate, and admits it
    /// only after a human's local CLI authorization (#873). Both endpoints are real.
    func testStockPendingLocalApprovalReconnectAndPersistence() async throws {
        let binary = try requireBinary()
        let port = 18787
        try spawnHub(binary: binary, port: port)
        let identity = ClientIdentity(privateKey: .init())
        let client = await MainActor.run { HubClient(scanPorts: [port], identity: identity) }
        await MainActor.run { client.start() }
        try await waitForApproval(client, port: port)
        let fingerprint = await MainActor.run { client.publicFingerprint }
        XCTAssertEqual(fingerprint, identity.fingerprint)
        let exported = await MainActor.run { client.publicIdentityJSON }
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(exported.utf8)) as? [String: String])
        XCTAssertEqual(Set(object.keys), Set(["publicKey", "fingerprint"]))
        XCTAssertEqual(object["publicKey"], identity.publicKeyRaw.base64EncodedString())
        XCTAssertTrue(try localCLI(binary, ["keys"]).contains(fingerprint))
        _ = try localCLI(binary, ["authorize", fingerprint, "--label", "macos-integration"])
        await MainActor.run { client.rescanNow() }
        try await waitForConnected(client, port: port)
        let approvalAfterSuccess = await MainActor.run { client.approvalErrorCode }
        XCTAssertNil(approvalAfterSuccess)
        await MainActor.run { client.stopForTesting() }

        // Restart the REAL hub using its same private auth store.
        let previous = try XCTUnwrap(process)
        previous.terminate()
        previous.waitUntilExit()
        let restarted = Process()
        restarted.executableURL = previous.executableURL
        restarted.arguments = previous.arguments
        restarted.environment = previous.environment
        restarted.standardOutput = Pipe()
        restarted.standardError = Pipe()
        try restarted.run()
        process = restarted
        let relaunched = await MainActor.run { HubClient(scanPorts: [port], identity: identity) }
        await MainActor.run { relaunched.start() }
        try await waitForConnected(relaunched, port: port)
        await MainActor.run { relaunched.stopForTesting() }
    }

    func testStockUnknownKeyRemainsRejectedWithoutLocalApproval() async throws {
        let binary = try requireBinary()
        let port = 18788
        try spawnHub(binary: binary, port: port)
        let identity = ClientIdentity(privateKey: .init())
        let client = await MainActor.run { HubClient(scanPorts: [port], identity: identity) }
        await MainActor.run { client.start() }
        try await waitForApproval(client, port: port)
        XCTAssertTrue(try localCLI(binary, ["keys"]).contains(identity.fingerprint))
        await MainActor.run { client.rescanNow() }
        try await waitForApproval(client, port: port)
        await MainActor.run { client.stopForTesting() }
    }

    private func localCLI(_ binary: String, _ arguments: [String]) throws -> String {
        let home = try XCTUnwrap(homeDir)
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: binary)
        proc.arguments = arguments
        proc.environment = ["HOME": home.path, "REMI_HOME": home.appendingPathComponent(".remi").path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        let output = Pipe()
        proc.standardOutput = output
        proc.standardError = output
        try proc.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertEqual(proc.terminationStatus, 0, text)
        return text
    }

    private func waitForApproval(_ client: HubClient, port: Int) async throws {
        for _ in 0..<60 {
            let phase = await MainActor.run { client.phase }
            if case .rejected(let actualPort, let reason) = phase {
                XCTAssertEqual(actualPort, port)
                XCTAssertTrue(reason.contains("waiting for local approval"), reason)
                let code = await MainActor.run { client.approvalErrorCode }
                XCTAssertEqual(code, "UNKNOWN_KEY")
                return
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        XCTFail("Stock hub never reported pending local approval")
    }

    private func waitForConnected(_ client: HubClient, port: Int) async throws {
        for _ in 0..<60 {
            let phase = await MainActor.run { client.phase }
            if case .connected(let actualPort, let isHub) = phase, isHub {
                XCTAssertEqual(actualPort, port)
                return
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        XCTFail("HubClient never connected after explicit local approval")
    }
}
