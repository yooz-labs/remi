import Foundation
import Testing
@testable import RemiKit

/// The Swift models decode the same golden fixtures the TypeScript side checks (ADR 0014).
/// Real files, no stand-ins: a model is right when these pass.
struct FixtureConformanceTests {
    /// packages/shared/tests/fixtures/protocol, reached from this file:
    /// packages/native/RemiKit/Tests/RemiKitTests/ -> packages/.
    static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // RemiKitTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // RemiKit
        .deletingLastPathComponent()  // native
        .deletingLastPathComponent()  // packages
        .appendingPathComponent("shared/tests/fixtures/protocol")

    static func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: fixtures.appendingPathComponent("\(name).json"))
    }

    @Test func everyFixtureHasAnEnvelope() throws {
        let names = try FileManager.default.contentsOfDirectory(atPath: Self.fixtures.path)
            .filter { $0.hasSuffix(".json") }
        #expect(!names.isEmpty)
        for name in names {
            let data = try Data(contentsOf: Self.fixtures.appendingPathComponent(name))
            let envelope = try JSONDecoder().decode(Envelope.self, from: data)
            #expect(!envelope.type.isEmpty, "\(name) has no type")
        }
    }

    @Test func questionDecodes() throws {
        let message = try JSONDecoder().decode(QuestionMessage.self, from: Self.fixture("question"))
        #expect(message.type == "question")
        #expect(message.sessionId == "fixture-session-id")
        #expect(message.question.text == "Allow Bash: ls?")
        #expect(message.question.options.first?.isYes == true)
    }

    @Test(arguments: [
        "question_claude_permission",
        "question_claude_ask_user_question",
        "question_claude_plan_approval",
        "question_claude_terminal_prompt",
        "question_claude_terminal_only",
        "question_codex_command",
        "question_codex_terminal_only",
    ])
    func frozenDecisionFixturesDecode(_ name: String) throws {
        let message = try JSONDecoder().decode(QuestionMessage.self, from: Self.fixture(name))
        #expect(message.question.answerPath != nil)
    }

    @Test func resolvedByFixtureDecodes() throws {
        let message = try JSONDecoder().decode(
            QuestionResolvedMessage.self,
            from: Self.fixture("question_resolved_terminal")
        )
        #expect(message.resolvedBy == .terminal)
    }

    @Test func unknownDecisionEnumsDecodeAsUnknown() throws {
        let questionData = Data(#"""
        {
          "type":"question","id":"message","timestamp":"2026-10-08T12:00:00Z",
          "sessionId":"session","question":{
            "id":"question","text":"Future request","options":[],
            "allowsFreeText":false,"isAnswered":false,
            "kind":"future_kind","answerPath":"future_path"
          }
        }
        """#.utf8)
        let resolutionData = Data(#"""
        {
          "type":"question_resolved","id":"resolution","timestamp":"2026-10-08T12:00:01Z",
          "sessionId":"session","questionId":"question","reason":"cancelled",
          "resolvedBy":"future_source"
        }
        """#.utf8)

        let question = try JSONDecoder().decode(QuestionMessage.self, from: questionData)
        let resolution = try JSONDecoder().decode(QuestionResolvedMessage.self, from: resolutionData)
        #expect(question.question.kind == "future_kind")
        #expect(question.question.answerPath == nil)
        #expect(question.question.hasUnknownAnswerPath)
        #expect(resolution.resolvedBy == nil)
    }

    @Test func omittedAnswerPathRemainsLegacyRatherThanUnknown() throws {
        let message = try JSONDecoder().decode(QuestionMessage.self, from: Self.fixture("question"))
        #expect(message.question.answerPath == nil)
        #expect(!message.question.hasUnknownAnswerPath)
    }

    @Test func sessionListDecodes() throws {
        let list = try JSONDecoder().decode(
            SessionListResponse.self, from: Self.fixture("session_list_response"))
        #expect(list.sessions.first?.sessionId == "fixture-session-id")
        #expect(list.daemonPorts == [19924, 19925])
    }

    @Test(arguments: [
        "hello_ack", "hello_ack_legacy", "auth_challenge", "auth_result", "ping",
        "question_resolved", "question_snapshot", "transcript_content",
        "transcript_load_complete", "session_views", "create_session_response",
        "resume_session_response", "resume_session_response_child",
        "kill_session_response", "error", "session_update"
    ])
    func inboundLiveMessageDecodes(_ name: String) throws {
        let data = try Self.fixture(name)
        switch name {
        case "hello_ack", "hello_ack_legacy":
            _ = try JSONDecoder().decode(HelloAckMessage.self, from: data)
        case "auth_challenge":
            _ = try JSONDecoder().decode(AuthChallengeMessage.self, from: data)
        case "auth_result":
            _ = try JSONDecoder().decode(AuthResultMessage.self, from: data)
        case "ping":
            let message = try JSONDecoder().decode(PingMessage.self, from: data)
            #expect(message.id == "8fbe8fe0-81fd-480f-ba8b-813d63c9254e")
        case "question_resolved":
            _ = try JSONDecoder().decode(QuestionResolvedMessage.self, from: data)
        case "question_snapshot":
            _ = try JSONDecoder().decode(QuestionSnapshotMessage.self, from: data)
        case "transcript_content":
            let message = try JSONDecoder().decode(TranscriptContentMessage.self, from: data)
            #expect(message.usage?.inputTokens == 10)
            #expect(message.contentBlocks?.first?.text == "Fixture transcript text")
        case "transcript_load_complete":
            _ = try JSONDecoder().decode(TranscriptLoadCompleteMessage.self, from: data)
        case "session_views":
            let message = try JSONDecoder().decode(SessionViewsMessage.self, from: data)
            #expect(message.sessionId == "fixture-session-id")
            #expect(message.subagents.first?.agentId == "fixture-agent-id")
        case "create_session_response":
            _ = try JSONDecoder().decode(CreateSessionResponseMessage.self, from: data)
        case "resume_session_response", "resume_session_response_child":
            let message = try JSONDecoder().decode(ResumeSessionResponseMessage.self, from: data)
            #expect(message.sessionId == "fixture-session-id")
            #expect(message.port == (name == "resume_session_response_child" ? 19924 : nil))
        case "kill_session_response":
            _ = try JSONDecoder().decode(KillSessionResponseMessage.self, from: data)
        case "error":
            _ = try JSONDecoder().decode(ErrorMessage.self, from: data)
        case "session_update":
            _ = try JSONDecoder().decode(SessionUpdateMessage.self, from: data)
        default:
            Issue.record("Unhandled fixture \(name)")
        }
    }

    @Test(arguments: [
        "hello", "auth_response", "auth_response_pairing", "answer", "transcript_load_request", "session_list_request",
        "create_session_request", "create_session_request_plain", "resume_session_request",
        "kill_session_request", "user_input", "pong"
    ])
    func outboundLiveMessageRoundTrips(_ name: String) throws {
        let data = try Self.fixture(name)
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()

        switch name {
        case "hello":
            let decoded = try decoder.decode(HelloMessage.self, from: data)
            _ = try decoder.decode(HelloMessage.self, from: encoder.encode(decoded))
        case "auth_response", "auth_response_pairing":
            let decoded = try decoder.decode(AuthResponseMessage.self, from: data)
            _ = try decoder.decode(AuthResponseMessage.self, from: encoder.encode(decoded))
        case "answer":
            let decoded = try decoder.decode(AnswerMessage.self, from: data)
            _ = try decoder.decode(AnswerMessage.self, from: encoder.encode(decoded))
        case "transcript_load_request":
            let decoded = try decoder.decode(TranscriptLoadRequestMessage.self, from: data)
            _ = try decoder.decode(TranscriptLoadRequestMessage.self, from: encoder.encode(decoded))
        case "session_list_request":
            let decoded = try decoder.decode(SessionListRequestMessage.self, from: data)
            _ = try decoder.decode(SessionListRequestMessage.self, from: encoder.encode(decoded))
        case "create_session_request", "create_session_request_plain":
            let decoded = try decoder.decode(CreateSessionRequestMessage.self, from: data)
            _ = try decoder.decode(CreateSessionRequestMessage.self, from: encoder.encode(decoded))
        case "resume_session_request":
            let decoded = try decoder.decode(ResumeSessionRequestMessage.self, from: data)
            #expect(decoded.sessionId == "fixture-session-id")
            _ = try decoder.decode(ResumeSessionRequestMessage.self, from: encoder.encode(decoded))
        case "kill_session_request":
            let decoded = try decoder.decode(KillSessionRequestMessage.self, from: data)
            _ = try decoder.decode(KillSessionRequestMessage.self, from: encoder.encode(decoded))
        case "user_input":
            let decoded = try decoder.decode(UserInputMessage.self, from: data)
            _ = try decoder.decode(UserInputMessage.self, from: encoder.encode(decoded))
        case "pong":
            let fixture = try decoder.decode(PongMessage.self, from: data)
            #expect(fixture.pingId == "fixture-ping-id")
            let reply = PongMessage(
                id: "reply-id",
                timestamp: "2026-10-09T00:00:00Z",
                pingId: "source-ping"
            )
            let object = try #require(
                JSONSerialization.jsonObject(with: encoder.encode(reply)) as? [String: String]
            )
            #expect(object == [
                "type": "pong",
                "id": "reply-id",
                "timestamp": "2026-10-09T00:00:00Z",
                "pingId": "source-ping",
            ])
        default:
            Issue.record("Unhandled fixture \(name)")
        }
    }

    /// A session found from a Claude transcript on disk has no `name` (`name?` on the wire,
    /// `DiscoverableSession` in packages/shared/src/types.ts), and a hub lists such sessions
    /// whenever the request asks for external ones. The shape is what
    /// `TranscriptDiscovery` builds (packages/daemon/src/transcript/transcript-discovery.ts);
    /// the golden fixture has only a named session, so it cannot catch this.
    @Test func sessionFoundFromATranscriptDecodesWithoutAName() throws {
        let json = Data(
            """
            {
              "type": "session_list_response",
              "id": "fixture-id",
              "timestamp": "2026-10-07T00:00:00.000Z",
              "requestId": "fixture-request-id",
              "sessions": [
                {
                  "sessionId": "11111111-1111-4111-8111-111111111111",
                  "projectPath": "/Users/fixture/project",
                  "status": "completed",
                  "lastActivity": "2026-10-06T00:00:00.000Z",
                  "messageCount": 12,
                  "source": "transcript",
                  "canAttach": false,
                  "canResume": true,
                  "claudeSessionId": "11111111-1111-4111-8111-111111111111",
                  "transcriptPath": "/Users/fixture/.claude/projects/p/11111111-1111-4111-8111-111111111111.jsonl"
                }
              ]
            }
            """.utf8)
        let list = try JSONDecoder().decode(SessionListResponse.self, from: json)
        #expect(list.sessions.first?.name == nil)
        #expect(list.sessions.first?.source == "transcript")
    }
}
