import CryptoKit
import Foundation
import Testing
@testable import RemiKit

private final class ChallengeSigningCount: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func record() { lock.lock(); defer { lock.unlock() }; count += 1 }
    func snapshot() -> Int { lock.lock(); defer { lock.unlock() }; return count }
}

struct AuthenticationHandshakeTests {
    @Test func signsDecodedChallengeAndVerifiesServer() throws {
        let client = ClientIdentity()
        let server = Curve25519.Signing.PrivateKey()
        let challenge = Data(repeating: 0x41, count: 32)
        let frame = AuthChallengeMessage(
            type: "auth_challenge",
            id: "challenge-id",
            timestamp: "2026-10-07T00:00:00Z",
            challenge: challenge.base64EncodedString(),
            serverFingerprint: ClientIdentity.fingerprint(
                ofPublicKeyRaw: server.publicKey.rawRepresentation
            ),
            serverPublicKey: server.publicKey.rawRepresentation.base64EncodedString(),
            relayEphemeralKey: nil,
            relayKexSignature: nil,
            answerEncryptionKey: nil
        )

        let (response, pending) = try AuthenticationHandshake.response(
            to: frame,
            identity: client,
            id: "response-id",
            timestamp: "2026-10-07T00:00:01Z"
        )
        let clientPublicKey = try Curve25519.Signing.PublicKey(
            rawRepresentation: Data(base64Encoded: response.clientPublicKey)!
        )
        #expect(clientPublicKey.isValidSignature(
            Data(base64Encoded: response.signature)!,
            for: challenge
        ))

        let result = AuthResultMessage(
            type: "auth_result",
            id: "result-id",
            timestamp: "2026-10-07T00:00:02Z",
            success: true,
            error: nil,
            serverSignature: try server.signature(for: challenge).base64EncodedString()
        )
        #expect(throws: Never.self) {
            try AuthenticationHandshake.verify(result, pending: pending)
        }
    }

    @Test func refusesFingerprintMismatchBeforeSigning() {
        let server = Curve25519.Signing.PrivateKey()
        let frame = AuthChallengeMessage(
            type: "auth_challenge",
            id: "challenge-id",
            timestamp: "2026-10-07T00:00:00Z",
            challenge: Data(repeating: 0x41, count: 32).base64EncodedString(),
            serverFingerprint: "0000000000000000",
            serverPublicKey: server.publicKey.rawRepresentation.base64EncodedString(),
            relayEphemeralKey: nil,
            relayKexSignature: nil,
            answerEncryptionKey: nil
        )

        #expect(throws: AuthenticationHandshakeError.fingerprintMismatch) {
            try AuthenticationHandshake.response(to: frame, identity: ClientIdentity())
        }
    }

    @Test func refusesScannedPublicKeyMismatchBeforeSigning() {
        let server = Curve25519.Signing.PrivateKey()
        let otherServer = Curve25519.Signing.PrivateKey()
        let frame = AuthChallengeMessage(
            type: "auth_challenge",
            id: "challenge-id",
            timestamp: "2026-10-07T00:00:00Z",
            challenge: Data(repeating: 0x41, count: 32).base64EncodedString(),
            serverFingerprint: ClientIdentity.fingerprint(ofPublicKeyRaw: server.publicKey.rawRepresentation),
            serverPublicKey: server.publicKey.rawRepresentation.base64EncodedString(),
            relayEphemeralKey: nil,
            relayKexSignature: nil,
            answerEncryptionKey: nil
        )

        #expect(throws: AuthenticationHandshakeError.fingerprintMismatch) {
            try AuthenticationHandshake.response(
                to: frame,
                identity: ClientIdentity(),
                expectedServerPublicKey: otherServer.publicKey.rawRepresentation.base64EncodedString()
            )
        }
    }

    @Test func pairingResponseCarriesNonceAndLabel() throws {
        let server = Curve25519.Signing.PrivateKey()
        let frame = AuthChallengeMessage(
            type: "auth_challenge",
            id: "challenge-id",
            timestamp: "2026-10-07T00:00:00Z",
            challenge: Data(repeating: 0x41, count: 32).base64EncodedString(),
            serverFingerprint: ClientIdentity.fingerprint(ofPublicKeyRaw: server.publicKey.rawRepresentation),
            serverPublicKey: server.publicKey.rawRepresentation.base64EncodedString(),
            relayEphemeralKey: nil,
            relayKexSignature: nil,
            answerEncryptionKey: nil
        )
        let (response, _) = try AuthenticationHandshake.response(
            to: frame,
            identity: ClientIdentity(),
            pairingNonce: "oKGio6SlpqeoqaqrrK2urw",
            pairingLabel: "Fixture phone"
        )
        #expect(response.pairingNonce == "oKGio6SlpqeoqaqrrK2urw")
        #expect(response.pairingLabel == "Fixture phone")
    }

    @Test(arguments: [0, 31, 33, 64])
    func refusesChallengeOfWrongLengthBeforeSigning(length: Int) {
        let server = Curve25519.Signing.PrivateKey()
        let count = ChallengeSigningCount()
        let client = ClientIdentity(privateKey: Curve25519.Signing.PrivateKey(),
                                    validateDurable: { count.record() })
        let frame = AuthChallengeMessage(
            type: "auth_challenge", id: "challenge-id", timestamp: "2026-10-07T00:00:00Z",
            challenge: Data(repeating: 0x41, count: length).base64EncodedString(),
            serverFingerprint: ClientIdentity.fingerprint(ofPublicKeyRaw: server.publicKey.rawRepresentation),
            serverPublicKey: server.publicKey.rawRepresentation.base64EncodedString(),
            relayEphemeralKey: nil, relayKexSignature: nil, answerEncryptionKey: nil
        )

        #expect(throws: AuthenticationHandshakeError.malformedChallenge) {
            try AuthenticationHandshake.response(to: frame, identity: client,
                expectedServerPublicKey: server.publicKey.rawRepresentation.base64EncodedString())
        }
        #expect(count.snapshot() == 0, "Malformed challenge must be refused before signing")
    }

    @Test func refusesMalformedChallengeBase64BeforeSigning() {
        let server = Curve25519.Signing.PrivateKey()
        let count = ChallengeSigningCount()
        let client = ClientIdentity(privateKey: Curve25519.Signing.PrivateKey(),
                                    validateDurable: { count.record() })
        let frame = AuthChallengeMessage(
            type: "auth_challenge", id: "challenge-id", timestamp: "2026-10-07T00:00:00Z",
            challenge: "!not-base64!",
            serverFingerprint: ClientIdentity.fingerprint(ofPublicKeyRaw: server.publicKey.rawRepresentation),
            serverPublicKey: server.publicKey.rawRepresentation.base64EncodedString(),
            relayEphemeralKey: nil, relayKexSignature: nil, answerEncryptionKey: nil
        )

        #expect(throws: AuthenticationHandshakeError.malformedChallenge) {
            try AuthenticationHandshake.response(to: frame, identity: client,
                expectedServerPublicKey: server.publicKey.rawRepresentation.base64EncodedString())
        }
        #expect(count.snapshot() == 0, "Malformed challenge must be refused before signing")
    }
}
