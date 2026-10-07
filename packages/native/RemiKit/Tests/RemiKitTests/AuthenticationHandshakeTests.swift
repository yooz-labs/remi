import CryptoKit
import Foundation
import Testing
@testable import RemiKit

struct AuthenticationHandshakeTests {
    @Test func signsDecodedChallengeAndVerifiesServer() throws {
        let client = ClientIdentity()
        let server = Curve25519.Signing.PrivateKey()
        let challenge = Data("challenge bytes".utf8)
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
            challenge: Data("challenge".utf8).base64EncodedString(),
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
}
