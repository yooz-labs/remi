import CryptoKit
import Foundation

/// A single-use client handshake; the host pin is checked before the device signs H2.
final class RelayHandshake {
    private enum Phase { case acknowledgment, ready, consumed }
    private var phase = Phase.acknowledgment
    private var ephemeral: P256.KeyAgreement.PrivateKey?
    private var secret: Data?
    private var keys: (SymmetricKey, SymmetricKey)?
    private let machine: Data
    private let identity: ClientIdentity
    private let nonce: Data
    private let name: Data
    private let started: ContinuousClock.Instant
    private let pair: Bool
    let hello: String

    static func start(machine: Data, identity: ClientIdentity, secret: Data?) throws -> RelayHandshake {
        try RelayHandshake(machine: machine, identity: identity, secret: secret,
            ephemeral: P256.KeyAgreement.PrivateKey(), nonce: RelayCrypto.random(32), name: "Remi")
    }

    // The deterministic initializer is internal for the shared oracle; production uses start().
    init(machine: Data, identity: ClientIdentity, secret: Data?, ephemeral: P256.KeyAgreement.PrivateKey,
         nonce: Data, name: String) throws {
        guard machine.count == 32, !ClientIdentity.isSmallOrderPublicKey(machine), nonce.count == 32,
              secret == nil || secret?.count == 32, name.utf8.count <= 64,
              !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
        else { throw RelayFailure.malformed }
        self.machine = machine
        self.identity = identity
        self.secret = secret
        self.ephemeral = ephemeral
        self.nonce = nonce
        self.name = RelayCrypto.text(name)
        pair = secret != nil
        started = .now
        hello = RelayCrypto.encodeControl("hello", fields: [
            ("m", secret == nil ? "resume" : "pair"),
            ("e", RelayCrypto.b64(ephemeral.publicKey.x963Representation)), ("n", RelayCrypto.b64(nonce)),
        ])
    }

    func acknowledge(_ frame: String) throws -> (auth: String, fingerprint: String) {
        guard phase == .acknowledgment else { throw RelayFailure.state }
        phase = .consumed
        do {
            guard started.duration(to: .now) <= .seconds(30), let ephemeral else { throw RelayFailure.expired }
            let ack = try RelayCrypto.control(frame, type: "hello_ack", fields: [("e", 65...65), ("n", 32...32), ("s", 64...64)])
            guard ack[0].first == 4 else { throw RelayFailure.malformed }
            let h1 = RelayCrypto.hash(try RelayCrypto.tuple(
                RelayCrypto.text("remi-relay-v2 H1"), RelayCrypto.room(machine), Data([2]), Data([pair ? 1 : 2]),
                ephemeral.publicKey.x963Representation, nonce, ack[0], ack[1]))
            guard RelayCrypto.verify(ack[2], input: try RelayCrypto.tuple(RelayCrypto.text("remi-relay-v2 host"), h1), key: machine)
            else { throw RelayFailure.signature }
            let host = try P256.KeyAgreement.PublicKey(x963Representation: ack[0])
            let shared = try ephemeral.sharedSecretFromKeyAgreement(with: host)
            let input = shared.withUnsafeBytes { Data($0) } + (secret ?? Data())
            let c2h = RelayCrypto.derive(input, salt: h1, label: "remi-relay-v2 c2h")
            let h2c = RelayCrypto.derive(input, salt: h1, label: "remi-relay-v2 h2c")
            let h2 = RelayCrypto.hash(try RelayCrypto.tuple(RelayCrypto.text("remi-relay-v2 H2"), h1, ack[2], identity.publicKeyRaw, name))
            let signature = try identity.signature(for: RelayCrypto.tuple(RelayCrypto.text("remi-relay-v2 client"), h2))
            let ciphertext = try RelayCrypto.seal(identity.publicKeyRaw + signature + name,
                key: c2h, type: 1, direction: 1, counter: 0)
            keys = (c2h, h2c)
            self.ephemeral = nil
            secret = nil
            phase = .ready
            let digest = RelayCrypto.hex(RelayCrypto.hash(try RelayCrypto.tuple(
                RelayCrypto.text("remi-relay-v2 fingerprint"), identity.publicKeyRaw, machine)).prefix(8))
            let fingerprint = stride(from: 0, to: 16, by: 4).map {
                String(digest.dropFirst($0).prefix(4))
            }.joined(separator: "-")
            return (RelayCrypto.encodeControl("auth", fields: [("c", RelayCrypto.b64(ciphertext))]), fingerprint)
        } catch { abort(); throw error }
    }

    func ready(_ frame: String) throws -> RelayChannel {
        guard phase == .ready else { throw RelayFailure.state }
        phase = .consumed
        defer { abort() }
        guard started.duration(to: .now) <= .seconds(pair ? 120 : 30), let keys else { throw RelayFailure.expired }
        let ciphertext = try RelayCrypto.control(frame, type: "ready", fields: [("c", 17...17)])[0]
        let echo = try RelayCrypto.open(ciphertext, key: keys.1, type: 2, direction: 2, counter: 0)
        guard echo == Data([pair ? 1 : 2]) else { throw RelayFailure.mode }
        return RelayChannel(send: keys.0, receive: keys.1)
    }

    func abort() { phase = .consumed; ephemeral = nil; secret = nil; keys = nil }
}

/// Synchronous CryptoKit operations owned by the connection actor; it serializes transport emission.
final class RelayChannel {
    private var sendKey: SymmetricKey?
    private var receiveKey: SymmetricKey?
    private var nextSend: UInt64 = 1
    private var nextReceive: UInt64 = 1
    private let sendDirection: UInt8
    private var sentBye = false
    private(set) var peerEnded = false
    private(set) var failed = false
    var closed: Bool { sendKey == nil }

    init(send: SymmetricKey, receive: SymmetricKey, direction: UInt8 = 1,
         nextSend: UInt64 = 1, nextReceive: UInt64 = 1) {
        sendKey = send; receiveKey = receive
        sendDirection = direction
        self.nextSend = nextSend
        self.nextReceive = nextReceive
    }

    func seal(_ plaintext: Data, bye: Bool = false) throws -> Data {
        guard !sentBye else { throw RelayFailure.ended }
        guard let sendKey else { throw RelayFailure.closed }
        guard bye || !plaintext.isEmpty else { throw RelayFailure.malformed }
        guard !bye || plaintext.isEmpty else { throw RelayFailure.malformed }
        guard plaintext.count <= RelayCrypto.maxPlaintext else { throw RelayFailure.oversize }
        guard nextSend < RelayCrypto.maxCounter || (bye && nextSend == RelayCrypto.maxCounter) else { throw RelayFailure.counter }
        do {
            let type: UInt8 = bye ? 4 : 3
            let sealed = try RelayCrypto.seal(plaintext, key: sendKey, type: type, direction: sendDirection, counter: nextSend)
            let frame = Data([type]) + RelayCrypto.be64(nextSend) + sealed
            nextSend += 1
            sentBye = bye
            return frame
        } catch { fail(); throw error }
    }

    func open(_ frame: Data) throws -> Data? {
        do {
            guard let receiveKey else { throw RelayFailure.closed }
            guard !peerEnded else { throw RelayFailure.ended }
            guard frame.count >= 25 else { throw RelayFailure.malformed }
            guard frame.count <= RelayCrypto.maxFrame else { throw RelayFailure.oversize }
            let type = frame[frame.startIndex]
            guard type == 3 || type == 4 else { throw RelayFailure.type }
            guard type == 4 ? frame.count == 25 : frame.count >= 26 else { throw RelayFailure.malformed }
            let counter = RelayCrypto.number(frame.dropFirst().prefix(8))
            guard counter <= RelayCrypto.maxCounter, counter == nextReceive else { throw RelayFailure.counter }
            let plaintext = try RelayCrypto.open(frame.dropFirst(9), key: receiveKey, type: type, direction: 3 - sendDirection, counter: counter)
            nextReceive += 1
            if type == 4 { peerEnded = true; return nil }
            return plaintext
        } catch { fail(); throw error }
    }

    var streamEnd: String { failed ? "failed" : peerEnded ? "clean" : "unclean" }
    func close() { sendKey = nil; receiveKey = nil }
    func fail() { failed = true; close() }
}
