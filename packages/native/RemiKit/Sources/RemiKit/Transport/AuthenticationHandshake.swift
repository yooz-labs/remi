import CryptoKit
import Foundation

public enum AuthenticationHandshakeError: Error, Sendable, Equatable {
    case malformedChallenge
    case invalidServerKey
    case fingerprintMismatch
    case missingPendingChallenge
    case invalidServerSignature
}

public struct PendingAuthentication: Sendable, Equatable {
    public let challenge: Data
    public let serverPublicKey: Data
}

public enum AuthenticationHandshake {
    public static func response(
        to frame: AuthChallengeMessage,
        identity: ClientIdentity,
        id: String = UUID().uuidString.lowercased(),
        timestamp: String = ISO8601DateFormatter().string(from: Date()),
        expectedServerPublicKey: String? = nil,
        pairingNonce: String? = nil,
        pairingLabel: String? = nil
    ) throws -> (AuthResponseMessage, PendingAuthentication) {
        guard let challenge = Data(base64Encoded: frame.challenge),
              let serverKey = Data(base64Encoded: frame.serverPublicKey)
        else {
            throw AuthenticationHandshakeError.malformedChallenge
        }
        guard serverKey.count == 32,
              serverKey.base64EncodedString() == frame.serverPublicKey,
              !ClientIdentity.isSmallOrderPublicKey(serverKey)
        else {
            throw AuthenticationHandshakeError.invalidServerKey
        }
        guard expectedServerPublicKey == nil || frame.serverPublicKey == expectedServerPublicKey else {
            throw AuthenticationHandshakeError.fingerprintMismatch
        }
        guard ClientIdentity.fingerprint(ofPublicKeyRaw: serverKey) == frame.serverFingerprint else {
            throw AuthenticationHandshakeError.fingerprintMismatch
        }

        let response = AuthResponseMessage(
            id: id,
            timestamp: timestamp,
            clientPublicKey: identity.publicKeyBase64,
            signature: try identity.signatureBase64(for: challenge),
            clientFingerprint: identity.fingerprint,
            pairingNonce: pairingNonce,
            pairingLabel: pairingLabel
        )
        return (response, PendingAuthentication(challenge: challenge, serverPublicKey: serverKey))
    }

    public static func verify(
        _ frame: AuthResultMessage,
        pending: PendingAuthentication?
    ) throws {
        guard let pending else {
            throw AuthenticationHandshakeError.missingPendingChallenge
        }
        guard frame.success,
              let encodedSignature = frame.serverSignature,
              let signature = Data(base64Encoded: encodedSignature),
              let serverKey = try? Curve25519.Signing.PublicKey(
                rawRepresentation: pending.serverPublicKey
              ),
              serverKey.isValidSignature(signature, for: pending.challenge)
        else {
            throw AuthenticationHandshakeError.invalidServerSignature
        }
    }
}
