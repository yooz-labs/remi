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

    @Test func sessionListDecodes() throws {
        let list = try JSONDecoder().decode(
            SessionListResponse.self, from: Self.fixture("session_list_response"))
        #expect(list.sessions.first?.sessionId == "fixture-session-id")
        #expect(list.daemonPorts == [19924, 19925])
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
