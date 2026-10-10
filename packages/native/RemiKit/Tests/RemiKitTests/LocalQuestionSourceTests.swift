import Foundation
import Testing
@testable import RemiKit

#if os(macOS)
private actor LocalSendGate {
    var entered = false
    var open = false
    func wait() async throws {
        entered = true
        while !open { try await Task.sleep(for: .milliseconds(10)) }
    }
    func release() { open = true }
}

struct LocalQuestionSourceTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMI_LOCAL_ACTION_HOME"] != nil,
        "Requires an explicitly marked inert source hub; see LocalQuestionSourceTests.swift."))
    @MainActor func localAnswersUseActualSourceReceiptsAndRespectCancellation() async throws {
        let environment = ProcessInfo.processInfo.environment
        let home = URL(fileURLWithPath: try #require(environment["REMI_LOCAL_ACTION_HOME"]))
        let repository = URL(fileURLWithPath: try #require(environment["REMI_LOCAL_ACTION_REPO"]))
        let marker = try #require(JSONSerialization.jsonObject(with: Data(contentsOf:
            home.appendingPathComponent("owned-local-action-test.json"))) as? [String: Any])
        #expect(marker["kind"] as? String == "inert-local-notification-test")
        guard marker["kind"] as? String == "inert-local-notification-test" else { return }
        let port = try #require(marker["port"] as? Int)
        #expect(home.path != FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".remi").path)
        guard port != 18765, home.lastPathComponent == "state" else { throw SourceFailure.invalidFixture }
        let endpoint = MachineEndpoint(host: "127.0.0.1", port: port)
        let identity = ClientIdentity()
        try authorize(identity, home: home, repository: repository)
        let initial = MachineStore(endpoints: [endpoint], identity: identity, clientVersion: "owned-local-actions", clientId: UUID().uuidString)
        initial.start()
        defer { initial.stop() }
        try await until { initial.machines.first?.status == .connected }
        let before = Set(try liveEntries(home).compactMap { $0["sessionId"] as? String })
        initial.createSession(on: endpoint, directory: home.deletingLastPathComponent().appendingPathComponent("work").path,
            harness: "claude", args: [], workspace: nil)
        try await until { try liveEntries(home).contains { !before.contains($0["sessionId"] as? String ?? "") } }
        let entry = try #require(liveEntries(home).first { !before.contains($0["sessionId"] as? String ?? "") })
        let session = try #require(entry["sessionId"] as? String)
        let hookPort = try #require(entry["hookPort"] as? Int)
        let directory = try #require(entry["projectPath"] as? String)
        let records = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: home.appendingPathComponent("sessions.json"))) as? [String: Any])
        let rows = try #require(records["sessions"] as? [[String: Any]])
        let claude = try #require(rows.first { $0["remiSessionId"] as? String == session }?["claudeSessionId"] as? String)
        initial.stop()

        // Every phase uses a real source child, real HTTP hold, real auth and real RPC.
        for phase in ["deny", "allow", "cancel-before", "cancel-pending", "stop", "remove"] {
            let store = MachineStore(endpoints: [endpoint], identity: identity, clientVersion: "owned-local-actions", clientId: UUID().uuidString)
            store.start()
            defer { store.stop() }
            try await until { store.machines.first?.activeSessions.contains { $0.sessionId == session } == true }
            var user = URLRequest(url: URL(string: "http://127.0.0.1:\(hookPort)/hooks")!)
            user.httpMethod = "POST"; user.setValue("application/json", forHTTPHeaderField: "Content-Type")
            user.httpBody = try JSONSerialization.data(withJSONObject: ["hook_event_name": "UserPromptSubmit",
                "session_id": claude, "cwd": directory, "prompt": "Owned local action \(phase)", "permission_mode": "default"])
            _ = try await URLSession.shared.data(for: user)
            var request = user
            request.timeoutInterval = 120
            request.httpBody = try JSONSerialization.data(withJSONObject: ["hook_event_name": "PermissionRequest",
                "session_id": claude, "cwd": directory, "permission_mode": "default", "tool_name": "Bash",
                "tool_input": ["command": "echo REMI_OWNED_LOCAL_\(phase)"], "permission_suggestions": []])
            let held = Task { try await URLSession.shared.data(for: request) }
            defer { held.cancel() }
            try await until { store.machines.first?.questions.contains { $0.sessionId == session } == true }
            let message = try #require(store.machines.first?.questions.first { $0.sessionId == session })
            let destination = RemiNavigationDestination(machineID: endpoint.id, sessionID: session,
                questionID: message.question.id, agentID: message.question.agentId)
            let plan = try #require(store.localQuestionNotification(for: destination))
            let identifier = phase == "allow" ? LocalQuestionNotificationPlan.yesIdentifier : LocalQuestionNotificationPlan.noIdentifier
            if phase == "deny" || phase == "allow" {
                #expect(await store.answerLocalNotification(plan, identifier: identifier) == .delivered)
                let (data, response) = try await held.value
                #expect((response as? HTTPURLResponse)?.statusCode == 200)
                let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                let output = try #require(object["hookSpecificOutput"] as? [String: Any])
                let decision = try #require(output["decision"] as? [String: Any])
                #expect(decision["behavior"] as? String == (phase == "allow" ? "allow" : "deny"))
                #expect(await store.answerLocalNotification(plan, identifier: identifier) == .refused)
            } else if phase == "cancel-before" {
                let answer = Task { await store.answerLocalNotification(plan, identifier: LocalQuestionNotificationPlan.yesIdentifier) }
                answer.cancel()
                #expect(await answer.value == .refused)
                #expect(store.machines.first?.questions.contains { $0.question.id == message.question.id } == true)
                #expect(await store.answerLocalNotification(plan, identifier: LocalQuestionNotificationPlan.noIdentifier) == .delivered)
                _ = try await held.value
            } else {
                let gate = LocalSendGate()
                store.ownedBeforeLocalAnswerSend = { try await gate.wait() }
                let answer = Task { await store.answerLocalNotification(plan, identifier: LocalQuestionNotificationPlan.yesIdentifier) }
                try await until { await gate.entered }
                if phase == "cancel-pending" { answer.cancel() }
                else if phase == "stop" { store.stop() }
                else { #expect(store.removeMachine(endpoint)) }
                await gate.release()
                #expect(await answer.value == .refused)
                store.ownedBeforeLocalAnswerSend = nil
                if phase == "cancel-pending" {
                    #expect(await store.answerLocalNotification(plan, identifier: LocalQuestionNotificationPlan.noIdentifier) == .delivered)
                    _ = try await held.value
                } else {
                    held.cancel()
                    _ = try? await held.value
                }
            }
            store.stop()
        }
    }

    private enum SourceFailure: Error { case invalidFixture, deadline, authorization }
    private func authorize(_ identity: ClientIdentity, home: URL, repository: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["bun", "packages/daemon/src/cli.ts", "authorize", identity.publicIdentity.exportJSON,
            "--label", "owned-local-notification-test"]
        process.currentDirectoryURL = repository
        var environment = ProcessInfo.processInfo.environment; environment["REMI_HOME"] = home.path
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        try process.run(); process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw SourceFailure.authorization }
    }
    private func liveEntries(_ home: URL) throws -> [[String: Any]] {
        try FileManager.default.contentsOfDirectory(at: home.appendingPathComponent("live-sessions"), includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.compactMap { try JSONSerialization.jsonObject(with: Data(contentsOf: $0)) as? [String: Any] }
    }
    @MainActor private func until(_ condition: () async throws -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(15))
        while .now < deadline {
            if try await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw SourceFailure.deadline
    }
}
#endif
