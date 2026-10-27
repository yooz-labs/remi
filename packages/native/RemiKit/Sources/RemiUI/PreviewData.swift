import Foundation
import RemiKit

public enum RemiPreviewData {
    public static let fixtureQuestion: RemiQuestionCardModel = {
        let message: QuestionMessage = decodeFixture("question")
        return RemiQuestionCardModel(
            id: message.question.id,
            kind: .permission,
            text: message.question.text,
            machineName: "fixture-host",
            sessionID: message.sessionId,
            sessionName: message.sessionId,
            options: message.question.options.map { option in
                RemiQuestionOption(
                    id: option.value,
                    label: option.label,
                    detail: option.description,
                    role: option.isYes ? .allow : option.isNo ? .deny : .neutral,
                    isRecommended: option.isRecommended
                )
            }
        )
    }()

    public static let fixtureSessions: [RemiSessionSummary] = {
        let response: SessionListResponse = decodeFixture("session_list_response")
        return response.sessions.map { session in
            RemiSessionSummary(
                id: session.sessionId,
                machineID: "fixture-host",
                machineName: "fixture-host",
                name: session.name ?? session.projectPath,
                harness: session.harness ?? "claude",
                project: URL(fileURLWithPath: session.projectPath).lastPathComponent,
                status: session.status == "active" ? .working : .idle,
                lastMessage: session.lastMessage
            )
        }
    }()

    public static let binaryQuestion = RemiQuestionCardModel(
        id: "question-binary",
        kind: .permission,
        text: "Allow Bash to run the test suite?",
        machineName: "Studio",
        sessionID: "native-app",
        sessionName: "native-app",
        options: [
            RemiQuestionOption(id: "yes", label: "Yes", role: .allow, isRecommended: true),
            RemiQuestionOption(id: "no", label: "No", role: .deny),
        ]
    )

    public static let standingGrantQuestion = RemiQuestionCardModel(
        id: "question-standing",
        kind: .permission,
        text: "Allow edits under packages/native?",
        machineName: "Studio",
        sessionID: "native-app",
        sessionName: "native-app",
        options: [
            RemiQuestionOption(id: "once", label: "Yes", role: .allow),
            RemiQuestionOption(id: "session", label: "Yes, allow edits under packages/native", role: .allow, grantsForSession: true, isRecommended: true),
            RemiQuestionOption(id: "no", label: "No", role: .deny),
        ]
    )

    public static let planQuestion = RemiQuestionCardModel(
        id: "question-plan",
        kind: .planApproval,
        text: "Ready to implement this plan?",
        detail: "1. Add semantic design tokens.\n2. Build the shared question card.\n3. Verify light, dark, and accessibility sizes.",
        machineName: "MacBook",
        sessionID: "design-pass",
        sessionName: "design-pass",
        options: [
            RemiQuestionOption(id: "auto", label: "Approve, auto-accept edits", role: .allow, grantsForSession: true),
            RemiQuestionOption(id: "manual", label: "Approve, review edits", role: .allow),
            RemiQuestionOption(id: "keep", label: "Keep planning", role: .deny),
        ]
    )

    public static let askUserQuestion = RemiQuestionCardModel(
        id: "question-ask-user",
        kind: .askUser,
        text: "Choose the first native app direction.",
        machineName: "Studio",
        sessionID: "native-app",
        sessionName: "native-app",
        steps: [
            RemiQuestionStep(id: "focus", header: "Focus", text: "Which surface should lead?", options: [
                RemiQuestionOption(id: "cards", label: "Question cards", detail: "Optimize the core approval loop first", isRecommended: true),
                RemiQuestionOption(id: "sessions", label: "Session browser", detail: "Lead with multi-machine navigation"),
            ])
        ]
    )

    public static let terminalOnlyQuestion = RemiQuestionCardModel(
        id: "question-terminal",
        kind: .askUser,
        text: "This question cannot be represented safely on this device.",
        machineName: "Studio",
        sessionID: "native-app",
        sessionName: "native-app",
        terminalOnly: true
    )

    public static let multipleChoiceQuestion = RemiQuestionCardModel(
        id: "question-choice",
        kind: .multipleChoice,
        text: "Which verification should run next?",
        machineName: "Studio",
        sessionID: "native-app",
        sessionName: "native-app",
        options: [
            RemiQuestionOption(id: "unit", label: "Package tests", detail: "Run the Swift Testing suite"),
            RemiQuestionOption(id: "device", label: "Simulator", detail: "Launch and inspect the native interface", isRecommended: true),
        ]
    )

    public static let genericQuestion = RemiQuestionCardModel(
        id: "question-generic",
        kind: .generic,
        text: "The agent has a request from a newer protocol version.",
        machineName: "Studio",
        sessionID: "native-app",
        sessionName: "native-app",
        options: [
            RemiQuestionOption(id: "continue", label: "Continue"),
            RemiQuestionOption(id: "stop", label: "Stop"),
        ]
    )

    public static let questionStates: [RemiQuestionCardModel] = [
        RemiQuestionCardModel(id: "sending", kind: .permission, text: "Allow Bash to run tests?", machineName: "Studio", sessionID: "native-app", sessionName: "native-app", state: .sending),
        RemiQuestionCardModel(id: "answered", kind: .permission, text: "Allow Bash to run tests?", machineName: "Studio", sessionID: "native-app", sessionName: "native-app", state: .answered("Yes")),
        RemiQuestionCardModel(id: "elsewhere", kind: .permission, text: "Allow Bash to run tests?", machineName: "Studio", sessionID: "native-app", sessionName: "native-app", state: .resolvedElsewhere(.terminal)),
        RemiQuestionCardModel(id: "stale", kind: .permission, text: "Allow Bash to run tests?", machineName: "Studio", sessionID: "native-app", sessionName: "native-app", state: .stale),
    ]

    public static let primarySession = RemiSessionSummary(
        id: "1",
        machineID: "studio",
        machineName: "Studio",
        name: "Native iOS",
        harness: "Claude",
        project: "remi",
        status: .needsYou,
        lastMessage: "Allow Bash to run the test suite?",
        openQuestionCount: 1,
        canTerminate: true
    )

    public static let sessions = [
        primarySession,
        RemiSessionSummary(id: "2", machineID: "studio", machineName: "Studio", name: "Protocol freeze", harness: "Codex", project: "remi", status: .working, lastMessage: "Reviewing the message registry"),
        RemiSessionSummary(
            id: "3",
            machineID: "studio",
            machineName: "Studio",
            name: "Notification polish",
            harness: "Claude",
            project: "remi",
            status: .offline,
            lastMessage: "Ready to continue from the saved transcript",
            canResume: true,
            resumeIdentity: "a47d831c"
        ),
    ]

    public static let machines = [
        RemiMachineSummary(id: "studio", name: "Studio", address: "127.0.0.1:18765", reachability: .connected, transport: .local, sessionCount: 2),
        RemiMachineSummary(id: "laptop", name: "Laptop", address: "100.72.14.8:18765", reachability: .waitingForApproval, transport: .direct, sessionCount: 0),
    ]

    public static let transcript: [RemiTranscriptEntry] = [
        .user(id: "u1", text: "Please inspect the session state and verify the interaction at large text sizes."),
        .agent(id: "a1", text: "I found **one approval** waiting on the Mac build. Review the [build notes](https://example.com) before continuing.\n\nThe spacing in this response is preserved."),
        .tool(id: "t1", name: "Build project", summary: "xcodebuild -scheme RemiPhone\n\nCompileSwift normal arm64\nLink RemiPhone\nBuild succeeded"),
    ]

    /// A session named as a hub names it, `<machine>:<project>/<branch>` (#1647).
    public static let hubNamedSession = RemiSessionSummary(
        id: "hub-1",
        machineID: "yahyas-mcm",
        machineName: "yahyas-mcm",
        name: "yahyas-mcm:transit/dev",
        harness: "Claude",
        project: "transit",
        status: .working,
        lastMessage: "Running the build",
        canTerminate: true
    )

    /// A conversation with a long run of tool calls between messages (#1647), the shape a
    /// real hub sends: many consecutive tool entries, then the reply.
    public static let toolRunTranscript: [RemiTranscriptEntry] = {
        let tools: [(String, String)] = [
            ("shell", "git status --short"), ("read", "Sources/App/Session.swift"),
            ("read", "Sources/App/Store.swift"), ("edit", "Sources/App/Store.swift"),
            ("shell", "swift build"), ("read", "Tests/StoreTests.swift"),
            ("edit", "Tests/StoreTests.swift"), ("shell", "swift test"),
            ("grep", "func reload"), ("read", "Sources/App/Reload.swift"),
            ("edit", "Sources/App/Reload.swift"), ("shell", "swift test --filter Reload"),
        ]
        return [
            .user(id: "run-u1", text: "Fix the reload bug and run the tests."),
            .agent(id: "run-a1", text: "On it. I will look at the store first."),
        ] + tools.enumerated().map { index, tool in
            .tool(id: "run-t\(index + 1)", name: tool.0, summary: tool.1)
        } + [
            .tool(id: "run-pair-1", name: "shell", summary: "git diff --stat"),
            .agent(id: "run-a2", text: "Fixed: the reload handler now clears the stale cache. All tests pass."),
            .tool(id: "run-pair-2", name: "shell", summary: "git status --short"),
            .tool(id: "run-pair-3", name: "read", summary: "CHANGELOG.md"),
        ]
    }()

    /// The golden `session_terminal_snapshot` frame, decoded by the strict codec.
    public static let fixtureTerminalSnapshot: SessionTerminalSnapshot = {
        guard let url = Bundle.module.url(forResource: "session_terminal_snapshot", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              case .snapshot(let snapshot)? = try? TerminalViewMessage.decode(data)
        else { preconditionFailure("Missing or invalid RemiUI preview fixture: session_terminal_snapshot.json") }
        return snapshot
    }()

    /// A full 80 by 24 screen, built through the strict codec so it cannot claim a shape the wire lacks.
    public static let wideTerminalSnapshot: SessionTerminalSnapshot = {
        var lines = [
            "~/remi $ bun test",
            "bun test v1.3.0",
            "",
            "packages/shared/tests/terminal-view.test.ts:",
            "(pass) strict frames > snapshot with wide characters 界é",
            "(pass) strict frames > refuses controls",
            "",
            "  4 pass",
            "  0 fail",
            "Ran 4 tests across 1 file. [0.12s]",
            "",
            "~/remi $ ",
        ]
        while lines.count < 24 { lines.append("") }
        let snapshot = SessionTerminalSnapshot(
            header: WireHeader(
                id: "00000000-0000-4000-8000-000000000001", timestamp: "2026-10-22T00:00:00.000Z",
                sessionId: "00000000-0000-4000-8000-000000000003"),
            requestId: "00000000-0000-4000-8000-000000000002", viewId: "AAECAwQFBgcICQoLDA0ODw", revision: 7,
            columns: 80, rows: 24, lines: lines, cursor: TerminalCursor(row: 11, column: 9))
        guard (try? TerminalViewMessage.snapshot(snapshot).encodedFrame()) != nil else {
            preconditionFailure("The wide terminal preview is not a valid snapshot")
        }
        return snapshot
    }()

    private static func decodeFixture<Value: Decodable>(_ name: String) -> Value {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json") else {
            preconditionFailure("Missing RemiUI preview fixture: \(name).json")
        }

        do {
            return try JSONDecoder().decode(Value.self, from: Data(contentsOf: url))
        } catch {
            preconditionFailure("Invalid RemiUI preview fixture \(name).json: \(error)")
        }
    }
}
