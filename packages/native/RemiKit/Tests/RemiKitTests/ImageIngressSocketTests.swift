import Foundation
import Testing
@testable import RemiKit

#if os(macOS)
private actor ImageSocketObservations {
    private var admitted = false
    private var receivedLargeTranscript = false
    private var unsupportedImage = false
    private var rejected = false
    private var reachabilityFallback = false
    private var receivedSessions = false

    func event(_ event: RemiInboundEvent) {
        if case .hello = event { admitted = true }
        if case .sessions = event { receivedSessions = true }
        if case .transcript(let message) = event, message.content.utf8.count > WireJSON.maxFrameBytes {
            receivedLargeTranscript = true
        }
        if case .unsupported(let type) = event, type.hasPrefix("image_upload_") { unsupportedImage = true }
    }

    func state(_ state: RemiConnectionState) {
        if case .rejected = state { rejected = true }
        if case .reachabilityFailed = state { reachabilityFallback = true }
        if case .retrying = state { reachabilityFallback = true }
    }

    func snapshot() -> (admitted: Bool, transcript: Bool, unsupported: Bool, rejected: Bool, fallback: Bool, sessions: Bool) {
        (admitted, receivedLargeTranscript, unsupportedImage, rejected, reachabilityFallback, receivedSessions)
    }
}

private struct GenericImageFrame: Encodable, Sendable {
    let type: String
    let id: String
    let timestamp: String
}

/// Runs the actual native receive path against an authenticated-key-pinned, loopback-only
/// controlled peer. The peer is synthetic, not a daemon or a secure-route qualification.
@Suite(.serialized) struct ImageIngressSocketTests {
    @Test func largeTranscriptStillPassesTheRealConnection() async throws {
        var transcript = try #require(JSONSerialization.jsonObject(with: FixtureConformanceTests.fixture("transcript_content")) as? [String: Any])
        transcript["content"] = String(repeating: "x", count: WireJSON.maxFrameBytes + 2_048)
        try await exercise(JSONSerialization.data(withJSONObject: transcript), expectTranscript: true)
    }

    @Test func oversizedImageIsRejectedBeforeGeneralEnvelopeDispatch() async throws {
        let frame = #"{"padding":""# + String(repeating: "x", count: WireJSON.maxFrameBytes) +
            #"","ty\u0070e":"image_\u0075pload_result"}"#
        try await exercise(Data(frame.utf8), expectTranscript: false)
    }

    @Test func duplicateTopLevelTypesDoNotHideAnOversizedImage() async throws {
        let frame = #"{"type":"transcript_content","padding":""# + String(repeating: "x", count: WireJSON.maxFrameBytes) +
            #"","type":"image_upload_result"}"#
        try await exercise(Data(frame.utf8), expectTranscript: false)
    }

    @Test func genericSendCannotBypassTheImageRouteGuard() async throws {
        let peer = try OwnedAnswerPeer(mode: "image-ingress")
        peer.start()
        var connection: RemiConnection?
        do {
            let port = try await peer.waitForPort()
            let observations = ImageSocketObservations()
            let client = RemiConnection(configuration: .init(url: try #require(URL(string: "ws://127.0.0.1:\(port)/ws")),
                clientVersion: "owned", clientId: "owned", expectedServerPublicKey: peer.pinnedPublicKey),
                identity: ClientIdentity(), stateHandler: { state in Task { await observations.state(state) } },
                eventHandler: { event in Task { await observations.event(event) } })
            connection = client
            await client.start()
            let helloDeadline = ContinuousClock.now.advanced(by: .seconds(5))
            while ContinuousClock.now < helloDeadline {
                if await observations.snapshot().admitted { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(await observations.snapshot().admitted)
            let imageHeader = WireHeader(id: UUID().uuidString.lowercased(), timestamp: "2026-10-31T00:00:00.000Z",
                                         sessionId: peer.sessionID)
            let imageBinding = AttachedBinding(harness: .claude, harnessSessionId: "09a9e195-b1af-4bd5-b9bf-e64855b16d36")
            let imageBegin = ImageUploadBegin(header: imageHeader, binding: imageBinding, mediaType: .png,
                                              byteLength: 3, digest: WireGuards.encodeBase64URL(Data(repeating: 1, count: 32)))
            let pinnedMachineKey = try #require(Data(base64Encoded: peer.pinnedPublicKey))
            // An authenticated direct socket is still not a qualified WSS/child image route.
            #expect(await client.imageBeginAuthority(for: imageBegin, machineKey: pinnedMachineKey) == nil)
            for type in ["image_upload_begin", "image_insert_request"] {
                let frame = GenericImageFrame(type: type, id: UUID().uuidString.lowercased(), timestamp: Date().ISO8601Format())
                await #expect(throws: PaneTransportBlocked.self) { try await client.send(frame) }
                let encoded = try JSONEncoder().encode(frame)
                let text = try #require(String(data: encoded, encoding: .utf8))
                let incorrectlyPermissivePolicy = PaneTransportPolicy(directSecureTransport: true, relaySemanticChild: true)
                await #expect(throws: PaneTransportBlocked.self) {
                    try await client.sendEncodedFrame(text, policy: incorrectlyPermissivePolicy)
                }
            }
            let chat = UserInputMessage(id: UUID().uuidString.lowercased(), timestamp: Date().ISO8601Format(),
                sessionId: peer.sessionID, content: #"A quoted "type":"image_upload_begin" is ordinary text"#)
            try await client.send(chat)
            let header = WireHeader(id: UUID().uuidString.lowercased(), timestamp: "2026-10-31T00:00:00.000Z",
                                    sessionId: peer.sessionID)
            let binding = AttachedBinding(harness: .claude, harnessSessionId: "09a9e195-b1af-4bd5-b9bf-e64855b16d36")
            let terminal = try TerminalViewMessage.open(SessionTerminalOpen(header: header, binding: binding)).encodedFrame()
            try await client.sendEncodedFrame(terminal, policy: PaneTransportPolicy(directSecureTransport: true, relaySemanticChild: false))
            try await client.send(SessionListRequestMessage(id: UUID().uuidString.lowercased(), timestamp: Date().ISO8601Format()))
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while ContinuousClock.now < deadline {
                if await observations.snapshot().sessions { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(await observations.snapshot().sessions)
            #expect(peer.snapshot().images == 0)
            #expect(peer.snapshot().inputs == 1)
            #expect(peer.snapshot().terminals == 1)
            await client.stop()
        } catch {
            await connection?.stop(); #expect(await peer.stop()); throw error
        }
        #expect(await peer.stop())
    }

    private func exercise(_ payload: Data, expectTranscript: Bool) async throws {
        let peer = try OwnedAnswerPeer(mode: "image-ingress")
        peer.start()
        var connection: RemiConnection?
        do {
            let port = try await peer.waitForPort()
            let observations = ImageSocketObservations()
            let client = RemiConnection(configuration: .init(url: try #require(URL(string: "ws://127.0.0.1:\(port)/ws")),
                clientVersion: "owned", clientId: "owned", expectedServerPublicKey: peer.pinnedPublicKey,
                directRetryPolicy: .runtime), identity: ClientIdentity(),
                stateHandler: { state in Task { await observations.state(state) } },
                eventHandler: { event in Task { await observations.event(event) } })
            connection = client
            await client.start()
            let helloDeadline = ContinuousClock.now.advanced(by: .seconds(5))
            while ContinuousClock.now < helloDeadline {
                if await observations.snapshot().admitted { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(await observations.snapshot().admitted)
            try #require(peer.sendImageIngressProbe(payload))
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while ContinuousClock.now < deadline {
                let observed = await observations.snapshot()
                if observed.transcript || observed.rejected || observed.unsupported { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            let observed = await observations.snapshot()
            if expectTranscript {
                #expect(observed.transcript)
                #expect(!observed.rejected)
            } else {
                #expect(observed.rejected)
                #expect(!observed.unsupported)
                #expect(!observed.fallback, "A protocol violation must not trigger a reachability fallback")
            }
            await client.stop()
        } catch {
            await connection?.stop(); #expect(await peer.stop()); throw error
        }
        #expect(await peer.stop())
    }
}
#endif
