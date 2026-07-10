//
//  HubProtocolTests.swift
//  RemiTests
//
//  Decoding against REAL frames captured from a live hub (remi
//  0.6.19-dev.4, 2026-07-07) — not invented shapes. Capture method:
//  query-mode hello to `remi serve`, raw frames logged.
//

import XCTest


final class HubProtocolTests: XCTestCase {
    // Captured verbatim from a live hub session.
    private let helloAckFixture = """
        {"type":"hello_ack","id":"b165ec10-6d38-4fc1-b733-fcabd58d1430","timestamp":"2026-07-08T01:29:44.322Z","serverVersion":"1.0.0","sessionId":null,"daemonVersion":"0.6.19-dev.4"}
        """
    private let hubStatusFixture = """
        {"type":"hub_status","id":"fd070ecd-17da-4569-9509-55760a9b4ae5","timestamp":"2026-07-08T01:29:44.322Z","localClients":0,"remoteClients":0,"sessions":0,"hubVersion":"0.6.19-dev.4"}
        """
    /// A message-delivery ack (#663) arrives BEFORE hello_ack on a real
    /// connection; the client must skip unknown types without failing.
    private let ackFixture = """
        {"type":"ack","id":"68002817-a987-4df3-81fb-d5b9273c4878","timestamp":"2026-07-08T01:29:44.321Z","ack":{"messageId":"9f717fd0-b097-4457-9f3b-42cc40c9d3c2","state":"delivered","timestamp":"2026-07-08T01:29:44.321Z"}}
        """

    func testDecodesRealHelloAckWithNullSessionId() throws {
        let data = Data(helloAckFixture.utf8)
        // HelloAckFrame is production-wired (#766 review): handleFrame
        // decodes it to validate the frame shape before accepting a
        // handshake. A JSON `null` for sessionId MUST decode cleanly here,
        // not throw — decodeIfPresent collapses it to Swift `nil` same as an
        // absent key would, which is exactly why the hub/session distinction
        // is recovered separately below, from the raw JSON.
        let ack = try JSONDecoder().decode(HelloAckFrame.self, from: data)
        XCTAssertEqual(ack.type, "hello_ack")
        XCTAssertNil(ack.sessionId)
        XCTAssertEqual(ack.serverVersion, "1.0.0")
        XCTAssertEqual(ack.daemonVersion, "0.6.19-dev.4")
        // The hub marker: a LITERAL null, not an absent key.
        XCTAssertTrue(HubClient.helloAckHasNullSessionId(data))
    }

    func testAbsentSessionIdIsNotAHubMarker() {
        // A pre-#542 daemon or malformed frame without the key must not be
        // mistaken for a session-less hub.
        let noKey = Data(#"{"type":"hello_ack","serverVersion":"1.0.0"}"#.utf8)
        XCTAssertFalse(HubClient.helloAckHasNullSessionId(noKey))
        let nonNull = Data(
            #"{"type":"hello_ack","serverVersion":"1.0.0","sessionId":"abc"}"#.utf8)
        XCTAssertFalse(HubClient.helloAckHasNullSessionId(nonNull))
    }

    func testDecodesRealHubStatus() throws {
        let status = try JSONDecoder().decode(
            HubStatusFrame.self, from: Data(hubStatusFixture.utf8))
        XCTAssertEqual(status.localClients, 0)
        XCTAssertEqual(status.remoteClients, 0)
        XCTAssertEqual(status.sessions, 0)
        XCTAssertEqual(status.hubVersion, "0.6.19-dev.4")
    }

    func testUnknownFrameTypeOnlyNeedsTheEnvelope() throws {
        let envelope = try JSONDecoder().decode(
            IncomingFrameType.self, from: Data(ackFixture.utf8))
        XCTAssertEqual(envelope.type, "ack")
    }

    func testHelloFrameEncodesQueryModeAndWireBasics() throws {
        let hello = HelloFrame(clientVersion: "0.1.0", clientId: "client-1")
        let data = try JSONEncoder().encode(hello)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "hello")
        XCTAssertEqual(object["mode"] as? String, "query")
        XCTAssertEqual(object["clientVersion"] as? String, "0.1.0")
        // ISO8601 with fractional seconds, per protocol.ts now().
        let timestamp = try XCTUnwrap(object["timestamp"] as? String)
        XCTAssertNotNil(
            ISO8601DateFormatter.withFractionalSeconds.date(from: timestamp))
        // Lowercase UUID id.
        let id = try XCTUnwrap(object["id"] as? String)
        XCTAssertEqual(id, id.lowercased())
        XCTAssertNotNil(UUID(uuidString: id))
    }
}

extension ISO8601DateFormatter {
    static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
