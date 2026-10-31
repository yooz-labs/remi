import CryptoKit
import Foundation
import Network
import Testing
@testable import RemiKit

#if os(macOS)
private actor ImageSocketObservations {
    private(set) var receivedLargeTranscript = false
    private(set) var unsupportedImage = false
    private(set) var rejected = false

    func event(_ event: RemiInboundEvent) {
        if case .transcript(let message) = event, message.content.utf8.count > WireJSON.maxFrameBytes {
            receivedLargeTranscript = true
        }
        if case .unsupported(let type) = event, type.hasPrefix("image_upload_") { unsupportedImage = true }
    }

    func state(_ state: RemiConnectionState) {
        if case .rejected = state { rejected = true }
    }

    func snapshot() -> (transcript: Bool, unsupportedImage: Bool, rejected: Bool) {
        (receivedLargeTranscript, unsupportedImage, rejected)
    }
}

/// An owned loopback WebSocket peer. The client verifies a fresh pinned Ed25519 server key;
/// this fixture sends adversarial frames and is not a substitute for a real daemon.
private final class ImageIngressPeer: @unchecked Sendable {
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "remi.test.image-ingress-peer")
    private let listener: NWListener
    private let key = Curve25519.Signing.PrivateKey()
    private let challenge = Data(repeating: 0x39, count: 32)
    private let payload: Data
    private var connection: NWConnection?
    private var port: UInt16?
    private var stopped = false
    private var listenerEnded = false
    private var connectionEnded = true
    private var connections = 0

    init(payload: Data) throws {
        self.payload = payload
        let websocket = NWProtocolWebSocket.Options()
        websocket.maximumMessageSize = 262_144
        websocket.setClientRequestHandler(queue) { _, _ in .init(status: .accept, subprotocol: nil) }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
        listener = try NWListener(using: parameters)
    }

    var pinnedKey: String { key.publicKey.rawRepresentation.base64EncodedString() }

    func snapshot() -> (port: UInt16?, ended: Bool, connections: Int) {
        lock.lock(); defer { lock.unlock() }
        return (port, listenerEnded && connectionEnded, connections)
    }

    func start() {
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            self.lock.lock(); defer { self.lock.unlock() }
            switch state {
            case .ready: self.port = self.listener.port?.rawValue
            case .failed, .cancelled: self.listenerEnded = true
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] incoming in
            guard let self else { incoming.cancel(); return }
            self.accept(incoming)
        }
        listener.start(queue: queue)
    }

    func waitForPort() async throws -> UInt16 {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while ContinuousClock.now < deadline {
            if let port = snapshot().port { return port }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw URLError(.timedOut)
    }

    func stop() async -> Bool {
        let current = beginStop()
        current?.cancel()
        listener.cancel()
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if snapshot().ended { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return snapshot().ended
    }

    private func beginStop() -> NWConnection? {
        lock.lock(); defer { lock.unlock() }
        stopped = true
        return connection
    }

    private func accept(_ incoming: NWConnection) {
        lock.lock()
        guard !stopped, connection == nil else { lock.unlock(); incoming.cancel(); return }
        connection = incoming
        connectionEnded = false
        connections += 1
        lock.unlock()
        incoming.stateUpdateHandler = { [weak self, weak incoming] state in
            guard let self, let incoming else { return }
            switch state {
            case .ready:
                let fingerprint = SHA256.hash(data: self.key.publicKey.rawRepresentation)
                    .map { String(format: "%02x", $0) }.joined()
                self.send(type: "auth_challenge", fields: ["challenge": self.challenge.base64EncodedString(),
                    "serverPublicKey": self.pinnedKey, "serverFingerprint": String(fingerprint.prefix(16))], to: incoming)
                self.receive(on: incoming)
            case .failed, .cancelled:
                self.lock.lock(); self.connectionEnded = true; self.lock.unlock()
            default: break
            }
        }
        incoming.start(queue: queue)
    }

    private func receive(on connection: NWConnection) {
        connection.receiveMessage { [weak self, weak connection] data, _, complete, error in
            guard let self, let connection, error == nil, complete, let data,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = object["type"] as? String else { connection?.cancel(); return }
            if type == "auth_response" {
                guard let signature = try? self.key.signature(for: self.challenge),
                      let hello = try? FixtureConformanceTests.fixture("hello_ack_legacy") else { connection.cancel(); return }
                self.send(type: "auth_result", fields: ["success": true, "serverSignature": signature.base64EncodedString()], to: connection)
                self.sendData(hello, to: connection)
                self.sendData(self.payload, to: connection)
            }
            self.receive(on: connection)
        }
    }

    private func send(type: String, fields: [String: Any], to connection: NWConnection) {
        var object: [String: Any] = ["type": type, "id": UUID().uuidString.lowercased(), "timestamp": Date().ISO8601Format()]
        object.merge(fields) { _, value in value }
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { connection.cancel(); return }
        sendData(data, to: connection)
    }

    private func sendData(_ data: Data, to connection: NWConnection) {
        let context = NWConnection.ContentContext(identifier: "owned-image-frame",
            metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
    }
}

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

    private func exercise(_ payload: Data, expectTranscript: Bool) async throws {
        let peer = try ImageIngressPeer(payload: payload)
        peer.start()
        var connection: RemiConnection?
        do {
            let port = try await peer.waitForPort()
            let observations = ImageSocketObservations()
            let client = RemiConnection(configuration: .init(url: try #require(URL(string: "ws://127.0.0.1:\(port)/ws")),
                clientVersion: "owned", clientId: "owned", expectedServerPublicKey: peer.pinnedKey,
                directRetryPolicy: .runtime), identity: ClientIdentity(),
                stateHandler: { state in Task { await observations.state(state) } },
                eventHandler: { event in Task { await observations.event(event) } })
            connection = client
            await client.start()
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while ContinuousClock.now < deadline {
                let observed = await observations.snapshot()
                if observed.transcript || observed.rejected || observed.unsupportedImage { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            let observed = await observations.snapshot()
            if expectTranscript {
                #expect(observed.transcript)
                #expect(!observed.rejected)
            } else {
                #expect(observed.rejected)
                #expect(!observed.unsupportedImage)
            }
            await client.stop()
        } catch {
            await connection?.stop(); #expect(await peer.stop()); throw error
        }
        #expect(await peer.stop())
        #expect(peer.snapshot().connections == 1)
    }
}
#endif
