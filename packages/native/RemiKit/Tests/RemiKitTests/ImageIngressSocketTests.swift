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

    func event(_ event: RemiInboundEvent) {
        if case .hello = event { admitted = true }
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

    func snapshot() -> (admitted: Bool, transcript: Bool, unsupported: Bool, rejected: Bool, fallback: Bool) {
        (admitted, receivedLargeTranscript, unsupportedImage, rejected, reachabilityFallback)
    }
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
