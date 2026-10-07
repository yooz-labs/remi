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
}
