import Foundation
import Testing
@testable import RemiKit

#if os(macOS)
private actor ImageSocketObservations {
    private var admitted = false
    private var receivedLargeTranscript = false
    private var unsupportedImage = false
    private var rejected = false
    private var rejectionReason: String?
    private var reachabilityFallback = false
    private var receivedSessions = false

    func event(_ event: RemiInboundEvent) {
        if case .hello = event { admitted = true }
        if case .sessions = event { receivedSessions = true }
        if case .transcript(let message) = event, message.content.utf8.count > WireJSON.maxFrameBytes {
            receivedLargeTranscript = true
        }
        if case .unsupported(let type) = event, ImageIngressPreflight.isImageType(type) { unsupportedImage = true }
    }

    func state(_ state: RemiConnectionState) {
        if case .rejected(let reason) = state { rejected = true; rejectionReason = reason }
        if case .reachabilityFailed = state { reachabilityFallback = true }
        if case .retrying = state { reachabilityFallback = true }
    }

    func snapshot() -> (admitted: Bool, transcript: Bool, unsupported: Bool, rejected: Bool, reason: String?,
                        fallback: Bool, sessions: Bool) {
        (admitted, receivedLargeTranscript, unsupportedImage, rejected, rejectionReason, reachabilityFallback,
         receivedSessions)
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
    private let clock = ContinuousClock()
    // These post-start observations share the generous 30-second bound so a loaded
    // runner's scheduling delay cannot turn this into a later short-timeout failure (#1634).
    private let eventWaitTimeout = Duration.seconds(30)

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

    @Test func smallImageResultStaysUnsupportedAndConnectionContinues() async throws {
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
            let helloDeadline = clock.now.advanced(by: eventWaitTimeout)
            while clock.now < helloDeadline {
                if await observations.snapshot().admitted { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(await observations.snapshot().admitted)

            let payload = Data(#"{"type":"image_upload_result","id":"108a8a9e-912e-4d52-9fdd-913c16654f5c","timestamp":"2026-11-13T20:00:00.000Z"}"#.utf8)
            #expect(payload.count < WireJSON.maxFrameBytes)
            try #require(peer.sendImageIngressProbe(payload))

            let unsupportedDeadline = clock.now.advanced(by: eventWaitTimeout)
            while clock.now < unsupportedDeadline {
                let observed = await observations.snapshot()
                if observed.unsupported || observed.rejected { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(await observations.snapshot().unsupported)
            #expect(!(await observations.snapshot().rejected))

            try await client.send(SessionListRequestMessage(id: UUID().uuidString.lowercased(),
                timestamp: Date().ISO8601Format()))
            let sessionsDeadline = clock.now.advanced(by: eventWaitTimeout)
            while clock.now < sessionsDeadline {
                if await observations.snapshot().sessions { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(await observations.snapshot().sessions)
            #expect(!(await observations.snapshot().rejected))
            await client.stop()
        } catch {
            await connection?.stop(); #expect(await peer.stop()); throw error
        }
        #expect(await peer.stop())
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
            let helloDeadline = clock.now.advanced(by: eventWaitTimeout)
            while clock.now < helloDeadline {
                if await observations.snapshot().admitted { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(await observations.snapshot().admitted)
            let incorrectlyPermissivePolicy = PaneTransportPolicy(directSecureTransport: true, relaySemanticChild: true)
            for type in ["image_upload_begin", "image_insert_request"] {
                let frame = GenericImageFrame(type: type, id: UUID().uuidString.lowercased(), timestamp: Date().ISO8601Format())
                do {
                    try await client.send(frame)
                    Issue.record("An image-family generic send must be refused")
                } catch let blocked as PaneTransportBlocked {
                    #expect(blocked.reason == "Image frames cannot be sent through this connection.")
                }
                let encoded = try JSONEncoder().encode(frame)
                let text = try #require(String(data: encoded, encoding: .utf8))
                do {
                    try await client.sendEncodedFrame(text, policy: incorrectlyPermissivePolicy)
                    Issue.record("An image-family encoded frame must be refused")
                } catch let blocked as PaneTransportBlocked {
                    #expect(blocked.reason == "Image frames cannot be sent through this connection.")
                }
            }
            do {
                try await client.sendEncodedFrame(
                    #"{"type":"user_input","type":"image_upload_begin"}"#,
                    policy: incorrectlyPermissivePolicy)
                Issue.record("An ambiguous image type must be refused")
            } catch let blocked as PaneTransportBlocked {
                #expect(blocked.reason == "Cannot safely verify the outgoing message type.")
            }
            let chat = UserInputMessage(id: UUID().uuidString.lowercased(), timestamp: Date().ISO8601Format(),
                sessionId: peer.sessionID, content: #"A quoted "type":"image_upload_begin" is ordinary text"#)
            let chatOrigin = try #require(await client.chatOrigin())
            switch await client.sendChat(chat, origin: chatOrigin) {
            case .handedOff:
                break
            case .notInvoked:
                Issue.record("Ordinary user_input must not be refused as an image")
            case .uncertain:
                Issue.record("Ordinary user_input should be handed off to the peer")
            }
            let header = WireHeader(id: UUID().uuidString.lowercased(), timestamp: "2026-10-31T00:00:00.000Z",
                                    sessionId: peer.sessionID)
            let binding = AttachedBinding(harness: .claude, harnessSessionId: "09a9e195-b1af-4bd5-b9bf-e64855b16d36")
            let terminal = try TerminalViewMessage.open(SessionTerminalOpen(header: header, binding: binding)).encodedFrame()
            try await client.sendEncodedFrame(terminal, policy: PaneTransportPolicy(directSecureTransport: true, relaySemanticChild: false))
            try await client.send(SessionListRequestMessage(id: UUID().uuidString.lowercased(), timestamp: Date().ISO8601Format()))
            let deadline = clock.now.advanced(by: eventWaitTimeout)
            while clock.now < deadline {
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
            let helloDeadline = clock.now.advanced(by: eventWaitTimeout)
            while clock.now < helloDeadline {
                if await observations.snapshot().admitted { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(await observations.snapshot().admitted)
            try #require(peer.sendImageIngressProbe(payload))
            let deadline = clock.now.advanced(by: eventWaitTimeout)
            while clock.now < deadline {
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
                #expect(observed.reason == "The incoming frame was oversized or its type could not be verified safely.")
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
