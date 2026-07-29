//
//  HubFixtureConformanceTests.swift
//  RemiTests
//
//  #901 (epic #883): decodes the SAME checked-in golden fixtures the TS
//  side generates from its real protocol factories
//  (packages/shared/tests/fixtures/protocol/, #895), through the exact
//  decode calls HubClient.handleFrame makes in production. A wire-shape
//  change that drops a field HubClient needs now fails HERE instead of
//  handleFrame's `guard ... else { return }` silently dropping the frame
//  (HubClient.swift:355-357).
//
//  `HubClient.handleFrame`'s switch (HubClient.swift:359-406) handles
//  exactly 5 frame types: hello_ack, hub_status, pong, auth_challenge,
//  auth_result. That is the real, current set -- verified by reading the
//  switch, not by trusting the issue text.
//
//  Fixtures are read straight off disk via #filePath navigation to
//  packages/shared/tests/fixtures/protocol/, mirroring IconStateTests.swift's
//  Assets.xcassets lookup (see the comment there). They are NOT copied into
//  this package -- there is exactly one copy of each fixture in the repo,
//  and both the TS mirror test (packages/shared/tests/
//  macos-fixture-conformance.test.ts) and this file read it.
//
//  All fixture fields are FIXED literals from
//  packages/shared/tests/fixtures/protocol/builders.ts except the envelope
//  `id`/`timestamp`, which are regenerated (new random UUID / timestamp) on
//  every `generate.ts` run -- see that file's doc comment. Those two are
//  checked only for well-formedness below; everything else is asserted
//  exact, so a dropped or renamed field fails loudly here.
//

import XCTest


final class HubFixtureConformanceTests: XCTestCase {
    /// packages/shared/tests/fixtures/protocol, reached from this file's
    /// own on-disk location (RemiTests/ -> packages/macos/ -> packages/ ->
    /// shared/tests/fixtures/protocol). Same technique as
    /// IconStateTests.swift's Assets.xcassets lookup.
    private static let fixturesDir: URL =
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // RemiTests/
            .deletingLastPathComponent()  // packages/macos/
            .deletingLastPathComponent()  // packages/
            .appendingPathComponent("shared/tests/fixtures/protocol")

    private func loadFixture(_ name: String) throws -> Data {
        try Data(contentsOf: Self.fixturesDir.appendingPathComponent("\(name).json"))
    }

    /// Envelope fields every fixture carries (`type`, `id`, `timestamp`).
    /// `id`/`timestamp` are the only fields regenerated per `generate.ts`
    /// run, so they're checked for well-formedness only, never an exact
    /// value.
    private func assertEnvelope(_ data: Data, type: String) throws {
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, type)
        let id = try XCTUnwrap(object["id"] as? String, "\(type) fixture is missing id")
        XCTAssertNotNil(UUID(uuidString: id), "\(type) fixture id is not a UUID: \(id)")
        let timestamp = try XCTUnwrap(
            object["timestamp"] as? String, "\(type) fixture is missing timestamp")
        XCTAssertNotNil(
            ISO8601DateFormatter.withFractionalSeconds.date(from: timestamp),
            "\(type) fixture timestamp is not ISO8601: \(timestamp)")
    }

    // MARK: - hello_ack (HubClient.swift:360-382)

    func testHelloAckFixtureDecodesAsHubClientRequires() throws {
        let data = try loadFixture("hello_ack")
        try assertEnvelope(data, type: "hello_ack")

        // The exact decode handleFrame's "hello_ack" case performs to
        // validate the frame before accepting a handshake
        // (HubClient.swift:367).
        let ack = try JSONDecoder().decode(HelloAckFrame.self, from: data)
        XCTAssertEqual(ack.type, "hello_ack")
        XCTAssertEqual(ack.sessionId, "fixture-session-id")
        XCTAssertEqual(ack.serverVersion, "1.0.0")
        XCTAssertEqual(ack.daemonVersion, "0.7.4-dev.1")
    }

    // MARK: - hub_status (HubClient.swift:383-397)

    func testHubStatusFixtureDecodesAsHubClientRequires() throws {
        let data = try loadFixture("hub_status")
        try assertEnvelope(data, type: "hub_status")

        // The exact decode handleFrame's "hub_status" case performs
        // (HubClient.swift:384).
        let status = try JSONDecoder().decode(HubStatusFrame.self, from: data)
        XCTAssertEqual(status.localClients, 1)
        XCTAssertEqual(status.remoteClients, 0)
        XCTAssertEqual(status.sessions, 2)
        XCTAssertEqual(status.hubVersion, "0.7.4-dev.1")
        XCTAssertEqual(status.pendingQuestions, 1)
        XCTAssertEqual(status.autostart, "installed")

        // `questions` is optional on HubStatusFrame, but the fixture
        // carries a non-empty array and Swift decodes array elements
        // strictly: every HubPendingQuestionFrame field is required once
        // the array is present, or the WHOLE HubStatusFrame decode above
        // would already have thrown.
        let questions = try XCTUnwrap(status.questions)
        XCTAssertEqual(questions.count, 1)
        XCTAssertEqual(questions[0].id, "fixture-question-id")
        XCTAssertEqual(questions[0].sessionId, "fixture-session-id")
        XCTAssertEqual(questions[0].sessionName, "fixture-session")
        XCTAssertEqual(questions[0].label, "Permission: Bash")
        XCTAssertEqual(questions[0].createdAt, "2026-01-01T00:00:00.000Z")
    }

    // MARK: - pong (HubClient.swift:398-399)

    func testPongFixtureDecodesAsHubClientRequires() throws {
        let data = try loadFixture("pong")
        try assertEnvelope(data, type: "pong")

        // handleFrame's "pong" case reads nothing but the envelope `type`
        // (missedPongs = 0) -- there is no dedicated payload struct because
        // nothing else is read. IncomingFrameType decoding successfully
        // with type == "pong" IS the entire contract for this frame.
        let envelope = try JSONDecoder().decode(IncomingFrameType.self, from: data)
        XCTAssertEqual(envelope.type, "pong")
    }

    // MARK: - auth_challenge (HubClient.swift:400-401, handleAuthChallenge 417-436)

    func testAuthChallengeFixtureDecodesAsHubClientRequires() throws {
        let data = try loadFixture("auth_challenge")
        try assertEnvelope(data, type: "auth_challenge")

        // The exact decode handleAuthChallenge performs (HubClient.swift:418).
        let frame = try JSONDecoder().decode(AuthChallengeFrame.self, from: data)
        XCTAssertEqual(frame.challenge, "base64-challenge")
        XCTAssertEqual(frame.serverFingerprint, "AA:BB:CC:DD")
        XCTAssertEqual(frame.serverPublicKey, "base64-server-pubkey")
        // relayEphemeralKey/relayKexSignature/answerEncryptionKey are on
        // the fixture (relay-transport fields) but deliberately undeclared
        // on AuthChallengeFrame (HubProtocol.swift:82-87): this app only
        // ever uses the direct loopback socket, and Decodable silently
        // ignores keys it doesn't declare.
    }

    // MARK: - auth_result (HubClient.swift:402-403, handleAuthResult 446-466)

    func testAuthResultFixtureDecodesAsHubClientRequires() throws {
        let data = try loadFixture("auth_result")
        try assertEnvelope(data, type: "auth_result")

        // The exact decode handleAuthResult performs (HubClient.swift:447).
        let frame = try JSONDecoder().decode(AuthResultFrame.self, from: data)
        XCTAssertTrue(frame.success)
        XCTAssertNil(frame.error)
        XCTAssertEqual(frame.serverSignature, "base64-server-signature")
    }
}
