import CryptoKit
import Foundation
import Security
import XCTest

final class NativePushCodecTests: XCTestCase {
    private var directory: URL!
    private var service = ""
    private var account = ""
    private var state: NativePushState!
    private var keys: NativePushKeyStore!
    private var vectors: [String: Any] = [:]
    private var cases: [[String: Any]] = []
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    override func setUpWithError() throws {
        service = "live.yooz.remi.tests.codec-" + UUID().uuidString
        account = "owned-p256-" + UUID().uuidString
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi1200-codec-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        state = try NativePushState(file: directory.appendingPathComponent("public.sqlite"))
        keys = NativePushKeyStore(service: service, account: account, accessGroup: nil)
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/tests/fixtures/relay-v2/push-vectors.json")
        vectors = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any])
        cases = try XCTUnwrap(vectors["cases"] as? [[String: Any]])
        let recipient = try P256.KeyAgreement.PrivateKey(rawRepresentation: hex(try XCTUnwrap(vectors["recipientScalarHex"] as? String)))
        struct Record: Encodable { let version: Int; let privateDER: Data; let publicKey: Data; let keyVersion: Int }
        var item = query
        item[kSecValueData as String] = try JSONEncoder().encode(Record(version: 1, privateDER: recipient.derRepresentation,
                                                                      publicKey: recipient.publicKey.x963Representation, keyVersion: 3))
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        XCTAssertEqual(SecItemAdd(item as CFDictionary, nil), errSecSuccess)
        XCTAssertEqual(try keys.load()?.publicKey, recipient.publicKey.x963Representation)
        let content = try XCTUnwrap(cases.first?["content"] as? [String: Any])
        let lease = try state.acquireIdentityMutation()
        defer { lease.release() }
        let generation = try lease.invalidateIdentityAuthority()
        try lease.installIdentityAuthority(publicKey: b64(try XCTUnwrap(content["devicePublicKey"] as? String)),
            revision: UUID().uuidString, requiresAppUnlock: false, generation: generation)
        let trust = NativePushState.MachineTrust(rid: try hex(XCTUnwrap(content["rid"] as? String)),
            machinePublicKey: try b64(XCTUnwrap(content["machinePublicKey"] as? String)),
            endpoint: "https://relay.example.invalid", authority: try XCTUnwrap(state.currentAuthority()))
        try state.installMachineTrust(trust, generation: generation)
    }
    override func tearDownWithError() throws {
        SecItemDelete(query as CFDictionary)
        keys = nil; state = nil
        if let directory { try FileManager.default.removeItem(at: directory) }
    }
    private func hex(_ text: String) throws -> Data {
        var data = Data(); var at = text.startIndex
        while at < text.endIndex {
            let end = text.index(at, offsetBy: 2)
            data.append(try XCTUnwrap(UInt8(text[at..<end], radix: 16))); at = end
        }
        return data
    }
    private func b64(_ text: String) throws -> Data {
        let encoded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return try XCTUnwrap(Data(base64Encoded: encoded + String(repeating: "=", count: (4 - encoded.count % 4) % 4)))
    }
    private func carrier(_ vector: [String: Any]) throws -> [String: Any] {
        let submit = try XCTUnwrap(vector["submit"] as? [String: Any])
        return ["v": 2, "rid": try XCTUnwrap(submit["rid"]), "collapseId": try XCTUnwrap(submit["collapseId"]),
                "keyVersion": try XCTUnwrap(submit["keyVersion"]), "kind": try XCTUnwrap(submit["kind"]), "sealed": try XCTUnwrap(submit["sealed"])]
    }
    func testActualCryptoKitOpensAllSharedOriginalSignedVectors() throws {
        XCTAssertEqual(cases.count, 10)
        for vector in cases {
            var result: NativePushCodec.VerifiedPush?
            XCTAssertNoThrow(result = try NativePushCodec.open(userInfo: ["aps": ["category": "UNTRUSTED"], "remiPush": carrier(vector)],
                state: state, keys: keys, now: 1_700_000_000), "The actual native codec must open every committed shared capsule: \(vector["name"] ?? "")")
            guard let result else { continue }
            XCTAssertEqual(result.payloadBytes, try hex(XCTUnwrap(vector["payloadHex"] as? String)), "Verification must preserve original signed JSON bytes")
            let signingInput = try hex(XCTUnwrap(vector["contentInputHex"] as? String))
            XCTAssertEqual(result.record.digest, Data(signingInput.suffix(32)), "Lifecycle digest must bind the exact original content body")
            XCTAssertEqual(result.record.digest, Data(SHA256.hash(data: result.originalBody)))
            XCTAssertEqual(result.authorityGeneration, try state.authorityGeneration())
        }
    }
    func testActualCarrierParserAcceptsCanonicalObjectAndRefusesDuplicateAliases() throws {
        let object = try carrier(XCTUnwrap(cases.first))
        let bytes = try JSONSerialization.data(withJSONObject: object)
        XCTAssertNoThrow(try NativePushCodec.parseCarrier(bytes), "Actual carrier parser must admit the canonical shared shape")
        let text = try XCTUnwrap(String(data: bytes, encoding: .utf8))
        let duplicate = Data(("{\"\\u0076\":2," + text.dropFirst()).utf8)
        XCTAssertThrowsError(try NativePushCodec.parseCarrier(duplicate), "Escaped decoded duplicate names must refuse")
    }
    func testCodecCannotCreateMissingRecipientOrInstallForgottenTrust() throws {
        let object = try carrier(XCTUnwrap(cases.first))
        XCTAssertEqual(SecItemDelete(query as CFDictionary), errSecSuccess)
        XCTAssertThrowsError(try NativePushCodec.open(userInfo: ["remiPush": object], state: state, keys: keys, now: 1_700_000_000))
        XCTAssertNil(try keys.load(), "Decode must never create or repair a missing private recipient")
        let rid = try hex(XCTUnwrap(object["rid"] as? String))
        try state.forgetMachine(rid: rid)
        XCTAssertThrowsError(try NativePushCodec.open(userInfo: ["remiPush": object], state: state, keys: keys, now: 1_700_000_000))
        XCTAssertNil(try state.machineTrust(rid: rid), "Unsigned carrier must never install completed machine trust")
    }
}
