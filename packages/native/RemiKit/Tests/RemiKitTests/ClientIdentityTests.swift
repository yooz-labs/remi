import CryptoKit
import Foundation
import Testing
@testable import RemiKit

struct ClientIdentityTests {
    @Test func fingerprintMatchesSharedWireFormat() {
        let publicKey = Data(repeating: 0, count: 32)
        #expect(ClientIdentity.fingerprint(ofPublicKeyRaw: publicKey) == "66687aadf862bd77")
    }

    @Test func signatureVerifiesAgainstPublicKey() throws {
        let identity = ClientIdentity()
        let challenge = Data("decoded challenge bytes".utf8)
        let signature = try identity.signature(for: challenge)
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: identity.publicKeyRaw)

        #expect(signature.count == 64)
        #expect(publicKey.isValidSignature(signature, for: challenge))
    }

    @Test func identityUsesRawWireLengths() {
        let identity = ClientIdentity()
        #expect(identity.publicKeyRaw.count == 32)
        #expect(Data(base64Encoded: identity.publicKeyBase64)?.count == 32)
        #expect(identity.fingerprint.count == 16)
    }

    @Test func rejectsSharedSmallOrderKeyEncoding() {
        #expect(ClientIdentity.isSmallOrderPublicKey(Data(repeating: 0, count: 32)))
    }
}
