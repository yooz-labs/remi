import CryptoKit
import Foundation
import RemiPush
import Testing
@testable import RemiKit

struct NativeAnswerProofTests {
    @Test(arguments: ["capsule", "presentation", "lifetime"])
    func finalProofRestrictionChecksIndependentCurrentAuthorities(change: String) throws {
        let oracle = try NativePushOracle.load("push-vectors.json")
        let vector = try #require((oracle["cases"] as? [[String: Any]])?.first)
        let context = try OwnedPushContext(vector: vector, oracle: oracle)
        defer { try? context.cleanup() }
        var payload = try #require(JSONSerialization.jsonObject(with: RelayOracle.hex(vector["payloadHex"] as? String ?? "")) as? [String: Any])
        payload["category"] = "REMI_YN"
        payload["options"] = [
            ["value": "allow", "label": "Yes", "isYes": true, "isNo": false, "description": NSNull(), "standingGrant": NSNull()],
            ["value": "deny", "label": "No", "isYes": false, "isNo": true, "description": NSNull(), "standingGrant": NSNull()]
        ]
        let carrier = try OwnedPushContext.resealed(vector, oracle: oracle, payload: JSONSerialization.data(withJSONObject: payload))
        let opened = try context.store.open(carrier: carrier, now: 1_700_000_001)
        let presentation = RelayRegistrationEpoch(), lifetime = RelayRegistrationEpoch()
        let initialPresentation = presentation.capture(), initialLifetime = lifetime.capture()
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: RelayOracle.hex(oracle["deviceSeedHex"] as? String ?? ""))
        let identity = ClientIdentity(privateKey: key, revision: context.authority.revision).restrictingSignatures {
            guard presentation.matches(initialPresentation), lifetime.matches(initialLifetime) else { throw RemiPushError.changed }
            try context.store.recheck(opened, now: 1_700_000_001)
        }
        _ = try NativeAnswerProof.make(opened, choice: "deny", identity: identity, now: 1_700_000_001)
        if change == "capsule" { try context.store.forgetMachine(room: context.room) }
        if change == "presentation" { presentation.replace() }
        if change == "lifetime" { lifetime.replace() }
        #expect(throws: (any Error).self) { try NativeAnswerProof.make(opened, choice: "deny", identity: identity, now: 1_700_000_001) }
    }

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
        #expect(throws: (any Error).self) {
            try RelayPushResponse.decode(Data(#"{"type":"secure_push_unregister_response","id":"own","requestId":"own","timestamp":"own","success":false,"success":true}"#.utf8))
        }
    }

    @Test(arguments: [false, true])
    func signedOptionValuesUseExactBytesDespiteCanonicalEquivalence(bothOffered: Bool) throws {
        let composed = "\u{00e9}", decomposed = "e\u{0301}"
        #expect(composed == decomposed && Data(composed.utf8) != Data(decomposed.utf8))
        let oracle = try NativePushOracle.load("push-vectors.json")
        let vector = try #require((oracle["cases"] as? [[String: Any]])?.first)
        let context = try OwnedPushContext(vector: vector, oracle: oracle)
        defer { try? context.cleanup() }
        let originalPayload = try RelayOracle.hex(#require(vector["payloadHex"] as? String))
        var payload = try #require(JSONSerialization.jsonObject(with: originalPayload) as? [String: Any])
        payload["category"] = "REMI_YN"
        payload["options"] = [
            ["value": bothOffered ? composed : "allow", "label": "Yes", "isYes": true, "isNo": false, "description": NSNull(), "standingGrant": NSNull()],
            ["value": bothOffered ? decomposed : composed, "label": "No", "isYes": false, "isNo": true, "description": NSNull(), "standingGrant": NSNull()]
        ]
        let carrier = try OwnedPushContext.resealed(vector, oracle: oracle, payload: JSONSerialization.data(withJSONObject: payload))
        let opened = try context.store.open(carrier: carrier, now: 1_700_000_001)
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: RelayOracle.hex(#require(oracle["deviceSeedHex"] as? String)))
        let identity = ClientIdentity(privateKey: key, revision: context.authority.revision)
        if bothOffered {
            let proof = try NativeAnswerProof.make(opened, choice: decomposed, identity: identity, now: 1_700_000_001)
            #expect(Data(proof.answer.utf8) == Data(decomposed.utf8), "No's exact signed value cannot select the canonically equivalent Yes")
        } else {
            #expect(throws: (any Error).self) { try NativeAnswerProof.make(opened, choice: decomposed, identity: identity, now: 1_700_000_001) }
            let proof = try NativeAnswerProof.make(opened, choice: composed, identity: identity, now: 1_700_000_001)
            #expect(Data(proof.answer.utf8) == Data(composed.utf8))
        }
    }
}
