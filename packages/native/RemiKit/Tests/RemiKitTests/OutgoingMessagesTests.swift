import Foundation
import Testing
@testable import RemiKit

@Suite struct OutgoingMessagesTests {
    let origin = OutgoingOrigin(endpoint: MachineEndpoint(host: "127.0.0.1", port: 18790), connection: UUID(), socket: UUID())

    private func error(_ code: String, session: String? = "session", message: String? = "m1", partial: JSONValue? = nil) throws -> ErrorMessage {
        var value = try #require(try JSONSerialization.jsonObject(with: FixtureConformanceTests.fixture("error")) as? [String: Any])
        value["code"] = code
        var details: [String: JSONValue] = [:]
        if let session { details["sessionId"] = .string(session) }
        if let message { details["messageId"] = .string(message) }
        if let partial { details["inputMayBePartial"] = partial }
        value["details"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(details))
        return try JSONDecoder().decode(ErrorMessage.self, from: JSONSerialization.data(withJSONObject: value))
    }

    @Test func handoffNeverOverridesARefusalRacingTheSendReturn() throws {
        var messages = OutgoingMessages()
        messages.add(id: "m1", content: "hello", origin: origin)
        messages.receive(try error("PROMPT_WAITING"), sessionID: "session", origin: origin)
        messages.markHandedOff(id: "m1", origin: origin)
        messages.markUncertain(id: "m1", origin: origin)
        #expect(messages.items.map(\.delivery) == [.refused])
    }

    @Test(arguments: ["PROMPT_WAITING", "SESSION_NOT_FOUND", "STALE_BINDING"])
    func exactRefusalAfterHandoff(_ code: String) throws {
        var messages = OutgoingMessages()
        messages.add(id: "m1", content: "hello", origin: origin)
        messages.markHandedOff(id: "m1", origin: origin)
        messages.receive(try error(code), sessionID: "session", origin: origin)
        #expect(messages.items.map(\.delivery) == [.refused])
    }

    @Test(arguments: ["PROMPT_WAITING", "SESSION_NOT_FOUND", "STALE_BINDING", "INPUT_NOT_DELIVERED", "UNKNOWN"])
    func partialWritesAlwaysStayUncertain(_ code: String) throws {
        var messages = OutgoingMessages()
        messages.add(id: "m1", content: "hello", origin: origin)
        messages.receive(try error(code, partial: .bool(true)), sessionID: "session", origin: origin)
        #expect(messages.items.map(\.delivery) == [.uncertain])
    }

    @Test func missingMessageIDAndUnknownCodeCannotProveRefusal() throws {
        var messages = OutgoingMessages()
        messages.add(id: "m1", content: "hello", origin: origin)
        messages.receive(try error("PROMPT_WAITING", message: nil), sessionID: "session", origin: origin)
        #expect(messages.items.map(\.delivery) == [.sending])
        messages.receive(try error("INPUT_NOT_DELIVERED"), sessionID: "session", origin: origin)
        #expect(messages.items.map(\.delivery) == [.uncertain])
    }

    @Test func mismatchedSessionMessageOrSocketCannotMutateIntent() throws {
        var messages = OutgoingMessages()
        messages.add(id: "m1", content: "hello", origin: origin)
        messages.receive(try error("PROMPT_WAITING", session: "other"), sessionID: "session", origin: origin)
        messages.receive(try error("PROMPT_WAITING", message: "other"), sessionID: "session", origin: origin)
        messages.receive(try error("PROMPT_WAITING"), sessionID: "session", origin:
            OutgoingOrigin(endpoint: origin.endpoint, connection: origin.connection, socket: UUID()))
        messages.receive(try error("PROMPT_WAITING", session: nil), sessionID: "session", origin: origin)
        #expect(messages.items.map(\.delivery) == [.sending])
    }

    @Test func fiftyUnresolvedMessagesBlockNewIntentUntilExplicitDismissal() {
        var messages = OutgoingMessages()
        for index in 0..<OutgoingMessages.limit {
            let added = messages.add(id: "\(index)", content: "hello", origin: origin, now: .distantPast)
            #expect(added)
            messages.markUncertain(id: "\(index)", origin: origin)
        }
        let overflow = messages.add(id: "overflow", content: "draft", origin: origin)
        #expect(!overflow)
        #expect(messages.items.count == 50)
        #expect(messages.items.first?.id == "0")
        messages.dismiss(id: "0")
        let afterDismiss = messages.add(id: "new", content: "draft", origin: origin)
        #expect(afterDismiss)
        #expect(messages.items.last?.id == "new")
    }

    @Test func connectionLossNeverClearsOrReplaysAndPreservesRefusal() throws {
        var messages = OutgoingMessages()
        messages.add(id: "m1", content: "hello", origin: origin)
        messages.add(id: "m2", content: "hello", origin: origin)
        messages.receive(try error("PROMPT_WAITING"), sessionID: "session", origin: origin)
        messages.connectionLost(endpoint: origin.endpoint, connection: origin.connection)
        #expect(messages.items.map(\.delivery) == [.refused, .uncertain])
        #expect(messages.items.map(\.content) == ["hello", "hello"])
    }
}
