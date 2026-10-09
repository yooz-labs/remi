import CryptoKit
import Foundation
import Security
import RemiPush
import Testing
@testable import RemiKit

enum NativePushOracle {
    static func load(_ name: String) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: bytes(name)) as? [String: Any])
    }
    static func bytes(_ name: String) throws -> Data {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("shared/tests/fixtures/relay-v2/\(name)")
        return try Data(contentsOf: file)
    }
}

struct NativeAnswerIdentityPinTests {
    @Test func existingIdentitySignsEveryNativeAnswerOracleInput() throws {
        let vectors = try NativePushOracle.load("native-answer-vectors.json")
        let seed = try RelayOracle.hex(#require(vectors["deviceSeedHex"] as? String))
        let identity = try ClientIdentity(rawPrivateKey: seed)
        let cases = try #require(vectors["cases"] as? [[String: Any]])
        #expect(cases.count == 8)
        for vector in cases {
            let message = try #require(vector["message"] as? [String: Any])
            let expected = try RelayCrypto.unb64(#require(message["signature"] as? String))
            let input = try RelayOracle.hex(#require(vector["signingInputHex"] as? String))
            let publicKey = try RelayCrypto.unb64(#require(message["devicePublicKey"] as? String))
            #expect(identity.publicKeyRaw == publicKey)
            let signature = try identity.signature(for: input)
            let verifier = try Curve25519.Signing.PublicKey(rawRepresentation: publicKey)
            #expect(verifier.isValidSignature(expected, for: input))
            #expect(verifier.isValidSignature(signature, for: input))
        }
    }

    #if os(macOS)
    @Test func existingRawSeedSurvivesRepeatedOwnedKeychainReads() throws {
        let service = "live.yooz.remi.tests.identity-pin.\(UUID().uuidString)"
        let account = "owned-seed"
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account]
        defer { SecItemDelete(query as CFDictionary) }
        let vectors = try NativePushOracle.load("native-answer-vectors.json")
        let seed = try RelayOracle.hex(#require(vectors["deviceSeedHex"] as? String))
        var item = query
        item[kSecValueData as String] = seed
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        #expect(SecItemAdd(item as CFDictionary, nil) == errSecSuccess)
        let original = try ClientIdentity(rawPrivateKey: seed)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-x2-identity-pin-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let push = try RemiPushStore.ownedTestStore(file: directory.appendingPathComponent("public.sqlite"),
            service: "live.yooz.remi.tests.recipient-pin", account: UUID().uuidString)
        let store = ClientIdentityStore(service: service, account: account, pushStore: push)
        #expect(try store.loadOrCreate().publicKeyRaw == original.publicKeyRaw)
        #expect(try store.loadOrCreate().publicKeyRaw == original.publicKeyRaw)
    }
    #endif
}
