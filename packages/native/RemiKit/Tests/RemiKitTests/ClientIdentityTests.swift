import CryptoKit
import Foundation
import Testing
@testable import RemiKit

struct ClientIdentityTests {
    @Test func publicIdentityExportsCliCompatibleJSON() throws {
        let identity = ClientIdentity()
        let exported = identity.publicIdentity
        let object = try #require(
            JSONSerialization.jsonObject(with: Data(exported.exportJSON.utf8)) as? [String: String]
        )

        #expect(object == ["publicKey": identity.publicKeyBase64])
        #expect(exported.fingerprint == identity.fingerprint)
        #expect(exported.authorizeCommand(label: "Yahya's iPhone").contains("'Yahya'\\''s iPhone'"))
    }

    @Test func authorizationCommandNormalizesDeviceNamesToTheCliContract() {
        let identity = PublicClientIdentity(publicKey: "public", fingerprint: "6323efd4d1c6c63f")

        #expect(identity.authorizeCommand(label: "  Work\n iPhone\t ") ==
            "remi authorize 6323efd4d1c6c63f --label 'Work iPhone'")
        #expect(identity.authorizeCommand(label: "-n\u{001B}\u{202E}hidden") ==
            "remi authorize 6323efd4d1c6c63f --label 'device -n hidden'")
        #expect(identity.authorizeCommand(label: "'quoted' \\ device") ==
            "remi authorize 6323efd4d1c6c63f --label ''\\''quoted'\\'' \\ device'")
        #expect(identity.authorizeCommand(label: "\u{00AD}\u{2066}") ==
            "remi authorize 6323efd4d1c6c63f --label 'device'")
    }

    @Test func authorizationCommandCapsLabelsAtSixtyFourUnicodeCodePoints() {
        let identity = PublicClientIdentity(publicKey: "public", fingerprint: "6323efd4d1c6c63f")
        let label = String(repeating: "🧠", count: 70)
        let normalized = PublicClientIdentity.authorizationLabel(from: label)

        #expect(normalized.unicodeScalars.count == 64)
        #expect(identity.authorizeCommand(label: label) ==
            "remi authorize 6323efd4d1c6c63f --label '\(String(repeating: "🧠", count: 64))'")
    }

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
