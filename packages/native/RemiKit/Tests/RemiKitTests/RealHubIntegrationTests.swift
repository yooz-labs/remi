import Foundation
import Testing
@testable import RemiKit

#if os(macOS)

private actor RealHubRecorder {
    var states: [RemiConnectionState] = []
    var events: [RemiInboundEvent] = []

    func record(_ state: RemiConnectionState) { states.append(state) }
    func record(_ event: RemiInboundEvent) { events.append(event) }

    func isWaiting(for fingerprint: String) -> Bool {
        states.contains(.awaitingLocalApproval(fingerprint: fingerprint))
    }

    var connected: Bool {
        states.contains { if case .connected = $0 { true } else { false } }
    }

    var errorCodes: [String] {
        events.compactMap { if case .error(let error) = $0 { error.code } else { nil } }
    }

    var receivedSessionList: Bool {
        events.contains { if case .sessions = $0 { true } else { false } }
    }
}

struct RealHubIntegrationTests {
    /// Opt-in because it launches no stand-in server: the source daemon must already be running.
    /// Run with REMI_E2E_URL, REMI_E2E_HOME and REMI_REPO_ROOT set.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_E2E_URL"] != nil &&
        ProcessInfo.processInfo.environment["REMI_E2E_HOME"] != nil &&
        ProcessInfo.processInfo.environment["REMI_REPO_ROOT"] != nil,
        "Requires an owned source hub; see RealHubIntegrationTests.swift."))
    func authenticatesAndListsSessionsFromRealSourceHub() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let urlString = environment["REMI_E2E_URL"],
              let url = URL(string: urlString),
              let remiHome = environment["REMI_E2E_HOME"],
              let repositoryRoot = environment["REMI_REPO_ROOT"]
        else { return }

        let identity = ClientIdentity()
        let recorder = RealHubRecorder()
        let connection = RemiConnection(
            configuration: RemiConnectionConfiguration(
                url: url,
                clientVersion: "native-e2e",
                clientId: "native-e2e-\(UUID().uuidString.lowercased())"
            ),
            identity: identity,
            stateHandler: { state in Task { await recorder.record(state) } },
            eventHandler: { event in Task { await recorder.record(event) } }
        )

        await connection.start()
        try await waitUntil { await recorder.isWaiting(for: identity.fingerprint) }
        try authorize(
            fingerprint: identity.fingerprint,
            remiHome: remiHome,
            repositoryRoot: repositoryRoot
        )
        await connection.retryAfterApproval()
        try await waitUntil { await recorder.connected }

        try await connection.send(SessionListRequestMessage(
            id: UUID().uuidString.lowercased(),
            timestamp: Date().ISO8601Format(),
            includeExternal: false
        ))
        try await waitUntil { await recorder.receivedSessionList }
        // The initial Hello is refused until the signed response succeeds (#1242).
        // That handshake response must not become a stale warning after connection.
        #expect(await !recorder.errorCodes.contains("AUTH_REQUIRED"))
        try await connection.send(UnknownClientMessage(
            id: UUID().uuidString.lowercased(), type: "owned-unknown-message"
        ))
        try await waitUntil { await recorder.errorCodes.contains("INVALID_MESSAGE") }
        #expect(await recorder.errorCodes.contains("INVALID_MESSAGE"))
        await connection.stop()
    }

    private struct UnknownClientMessage: Encodable, Sendable {
        let id: String
        let type: String
    }

    private func waitUntil(
        timeout: Duration = .seconds(10),
        condition: @escaping @Sendable () async -> Bool
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        Issue.record("Timed out waiting for real hub state")
    }

    private func authorize(
        fingerprint: String,
        remiHome: String,
        repositoryRoot: String
    ) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [
            "bun", "run", "packages/daemon/src/cli.ts",
            "authorize", fingerprint, "--label", "native-e2e",
        ]
        process.currentDirectoryURL = URL(fileURLWithPath: repositoryRoot)
        var environment = ProcessInfo.processInfo.environment
        environment["REMI_HOME"] = remiHome
        process.environment = environment
        try process.run()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0)
    }
}
#endif
