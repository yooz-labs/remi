import CryptoKit
import Foundation
import RemiPush
import Testing
@testable import RemiKit

struct NativeAnswerProofTests {
    @Test func exactTupleBodyDigestAndSigningInputMatchAllEightSourceVectors() throws {
        struct Vector: Decodable { let name: String; let message: NativeAnswerProof; let bodyHex: String; let signingInputHex: String; let requestDigest: String }
        struct Oracle: Decodable { let cases: [Vector] }
        let cases = try JSONDecoder().decode(Oracle.self, from: NativePushOracle.bytes("native-answer-vectors.json")).cases
        #expect(cases.count == 8)
        for vector in cases {
            let proof = vector.message
            #expect(try RelayCrypto.hex(proof.body()) == vector.bodyHex)
            #expect(try RelayCrypto.hex(proof.signingInput()) == vector.signingInputHex)
            #expect(try RelayCrypto.hex(Data(SHA256.hash(data: proof.body()))) == vector.requestDigest)
            let verifier = try Curve25519.Signing.PublicKey(rawRepresentation: RelayCrypto.unb64(proof.devicePublicKey))
            #expect(try verifier.isValidSignature(RelayCrypto.unb64(#require(proof.signature)), for: proof.signingInput()))
        }
    }

    @Test func registrationSuccessAndUnregisterHaveDifferentExactShapes() throws {
        let base: [String: Any] = ["type": "secure_push_unregister_response", "id": "own-ack", "requestId": "own-request", "timestamp": "own", "success": true]
        let value = try RelayPushResponse.decode(JSONSerialization.data(withJSONObject: base))
        #expect(value.success && value.keyVersion == nil && value.id != value.requestId)
        var register = base; register["type"] = "secure_push_register_response"
        #expect(throws: (any Error).self) { try RelayPushResponse.decode(JSONSerialization.data(withJSONObject: register)) }
        register["keyVersion"] = 1
        #expect(try RelayPushResponse.decode(JSONSerialization.data(withJSONObject: register)).keyVersion == 1)
        var extra = base; extra["keyVersion"] = 1
        #expect(throws: (any Error).self) { try RelayPushResponse.decode(JSONSerialization.data(withJSONObject: extra)) }
    }
}
