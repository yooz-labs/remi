import CryptoKit
import Foundation
import Testing
@testable import RemiKit

enum RelayOracle {
    static func load() throws -> [String: Any] {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("shared/tests/fixtures/relay-v2/vectors.json")
        return try #require(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
    }

    static func hex(_ text: String) throws -> Data {
        guard text.count.isMultiple(of: 2) else { throw CocoaError(.fileReadCorruptFile) }
        let bytes = Array(text.utf8)
        return try Data(stride(from: 0, to: bytes.count, by: 2).map {
            try #require(UInt8(String(decoding: bytes[$0..<$0 + 2], as: UTF8.self), radix: 16))
        })
    }

    static func bytes(_ object: [String: Any], _ key: String) throws -> Data {
        try hex(#require(object[key] as? String))
    }
}

struct RelayOracleTests {
    @Test func existingIdentitySignsTheReviewedRelayInputs() throws {
        let oracle = try RelayOracle.load()
        let identities = try #require(oracle["identities"] as? [String: [String: Any]])
        let device = try #require(identities["device"])
        let identity = try ClientIdentity(rawPrivateKey: RelayOracle.bytes(device, "seed"))
        #expect(identity.publicKeyRaw == (try RelayOracle.bytes(device, "publicKey")))
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: identity.publicKeyRaw)
        let sessions = try #require(oracle["sessions"] as? [String: [String: Any]])
        for session in sessions.values {
            let input = try RelayOracle.bytes(session, "clientSigningInput")
            #expect(publicKey.isValidSignature(try RelayOracle.bytes(session, "clientSignature"), for: input))
            #expect(publicKey.isValidSignature(try identity.signature(for: input), for: input))
        }
        let admission = try #require(oracle["admission"] as? [String: Any])
        let input = try RelayOracle.bytes(admission, "clientInput")
        #expect(publicKey.isValidSignature(try RelayOracle.bytes(admission, "clientSignature"), for: input))
        #expect(publicKey.isValidSignature(try identity.signature(for: input), for: input))
    }
}
