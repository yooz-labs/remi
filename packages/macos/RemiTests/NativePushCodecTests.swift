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
            endpoint: "https://relay.example.invalid", authority: try XCTUnwrap(state.currentAuthority()), relayUrl: "wss://relay.example.invalid")
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
    private func b64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private func parts(_ data: Data) -> [Data] {
        var out: [Data] = []; var at = 0
        while at < data.count {
            let size = Int(data[at]) * 256 + Int(data[at + 1]); at += 2
            out.append(data.subdata(in: at..<(at + size))); at += size
        }
        return out
    }
    private func lps(_ data: [Data]) -> Data {
        data.reduce(into: Data()) { out, p in out.append(contentsOf: [UInt8(p.count >> 8), UInt8(p.count & 255)]); out.append(p) }
    }
    private func be64(_ n: UInt64) -> Data { Data((0..<8).map { UInt8((n >> (56 - $0 * 8)) & 255) }) }
    /// Real CryptoKit producer at the independent test boundary, using only the
    /// committed synthetic scalars/seeds. No codec or policy implementation is replaced.
    private func reseal(_ vector: [String: Any], label: String = "remi-relay-v2 push content", resign: Bool = true,
                        change: (inout [Data]) -> Void) throws -> [String: Any] {
        let original = try hex(XCTUnwrap(vector["innerHex"] as? String))
        let signed = parts(original); var fields = parts(signed[0]); change(&fields)
        let body = lps(fields)
        let machine = try Curve25519.Signing.PrivateKey(rawRepresentation: hex(XCTUnwrap(vectors["machineSeedHex"] as? String)))
        let signature = resign ? try machine.signature(for: lps([Data(label.utf8), Data(SHA256.hash(data: body))])) : signed[1]
        let inner = lps([body, signature])
        let ephemeral = try P256.KeyAgreement.PrivateKey(rawRepresentation: hex(XCTUnwrap(vector["ephemeralScalarHex"] as? String)))
        let recipient = try XCTUnwrap(keys.load())
        let shared = try ephemeral.sharedSecretFromKeyAgreement(with: recipient.privateKey.publicKey)
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: ephemeral.publicKey.x963Representation,
            sharedInfo: lps([Data("remi-relay-v2 seal".utf8), recipient.publicKey]), outputByteCount: 32)
        var outer = try carrier(vector)
        let aad = try hex(XCTUnwrap(outer["rid"] as? String)) + Data(XCTUnwrap(outer["collapseId"] as? String).utf8)
        let box = try AES.GCM.seal(inner, using: key, nonce: AES.GCM.Nonce(data: hex(XCTUnwrap(vector["sealNonceHex"] as? String))), authenticating: aad)
        outer["sealed"] = b64url(ephemeral.publicKey.x963Representation + box.nonce.withUnsafeBytes { Data($0) } + box.ciphertext + box.tag)
        return outer
    }
    private func open(_ outer: [String: Any], now: Int64 = 1_700_000_000) throws -> NativePushCodec.VerifiedPush {
        try NativePushCodec.open(userInfo: ["remiPush": outer], state: state, keys: keys, now: now)
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
    func testForgottenTrustRefusesWithActualRecipientStillPresent() throws {
        let object = try carrier(XCTUnwrap(cases.first))
        XCTAssertNoThrow(try open(object), "Trust-removal pin requires a verified original capsule")
        XCTAssertNotNil(try keys.load())
        try state.forgetMachine(rid: hex(XCTUnwrap(object["rid"] as? String)))
        XCTAssertThrowsError(try open(object), "A present private P256 key never substitutes for completed machine trust")
        XCTAssertNotNil(try keys.load())
    }
    func testFinalActualKeychainReadCannotReturnInvalidatedAuthority() throws {
        let object = try carrier(XCTUnwrap(cases.first))
        XCTAssertNoThrow(try open(object))
        var operations = NativeKeychainOperations.system; var reads = 0
        operations.copyMatching = { request, result in
            reads += 1
            if reads == 2 {
                // Controlled OS-call boundary: actual Keychain reads continue;
                // another real SQLite connection commits invalidation during the
                // final key read. No codec/store/business policy is substituted.
                do {
                    let other = try NativePushState(file: self.directory.appendingPathComponent("public.sqlite"))
                    let lease = try other.acquireIdentityMutation(); defer { lease.release() }
                    _ = try lease.invalidateIdentityAuthority()
                } catch { XCTFail("Owned authority invalidation setup failed"); return errSecNotAvailable }
            }
            return SecItemCopyMatching(request, result)
        }
        let observed = NativePushKeyStore(service: service, account: account, accessGroup: nil, operations: operations)
        XCTAssertThrowsError(try NativePushCodec.open(userInfo: ["remiPush": object], state: state, keys: observed, now: 1_700_000_000),
                             "Final OS read must not publish a verified result after durable authority invalidation")
        XCTAssertEqual(reads, 2)
        XCTAssertNil(try state.currentAuthority())
    }
    func testRealResealingProducerMatchesFixtureAndEveryTupleBindingRefuses() throws {
        let vector = try XCTUnwrap(cases.first)
        // Retain the original shared signature for byte-for-byte encryption
        // parity; newly generated signatures need only verify, not repeat bytes.
        let unchanged = try reseal(vector, resign: false) { _ in }
        XCTAssertEqual(try XCTUnwrap(unchanged["sealed"] as? String), try XCTUnwrap(carrier(vector)["sealed"] as? String),
                       "Independent real CryptoKit producer must exactly reproduce the shared capsule before mutations")
        XCTAssertNoThrow(try open(unchanged))
        let replacements: [(Int, Data)] = [
            (0, Curve25519.Signing.PrivateKey().publicKey.rawRepresentation), (1, Data(repeating: 1, count: 16)),
            (2, Curve25519.Signing.PrivateKey().publicKey.rawRepresentation), (3, P256.KeyAgreement.PrivateKey().publicKey.x963Representation),
            (4, be64(4)), (5, Data("AgICAgICAgICAgICAgICAg".utf8)), (6, be64(0)), (7, Data([6])), (8, Data(repeating: 0, count: 31))]
        for (index, bytes) in replacements {
            let changed = try reseal(vector) { $0[index] = bytes }
            XCTAssertThrowsError(try open(changed), "Exact tuple field \(index) must refuse despite valid machine signing and real recipient sealing")
        }
    }
    func testExactOriginalBytesAndDomainSignatureAreMandatory() throws {
        let vector = try XCTUnwrap(cases.first)
        let changed = try reseal(vector, resign: false) { $0[11].append(32) }
        XCTAssertThrowsError(try open(changed), "Appending legal JSON whitespace still changes the authenticated ORIGINAL bytes")
        for label in ["remi-relay-v2 push submit", "remi-relay-v2 host", "remi-relay-v2 client"] {
            XCTAssertThrowsError(try open(reseal(vector, label: label) { _ in }), "Cross-purpose signature \(label) must refuse")
        }
        var corrupted = try carrier(vector)
        var sealed = try b64(XCTUnwrap(corrupted["sealed"] as? String)); sealed[sealed.count - 1] ^= 1
        corrupted["sealed"] = b64url(sealed)
        XCTAssertThrowsError(try open(corrupted), "Actual GCM tag tampering must refuse")
        corrupted = try carrier(vector); corrupted["collapseId"] = "AgICAgICAgICAgICAgICAg"
        XCTAssertThrowsError(try open(corrupted), "Outer collapse id is authenticated AAD, never a routing authority")
    }
    func testSignedPayloadStrictSchemaDuplicateAliasesAndFatalUTF8Refuse() throws {
        let vector = try XCTUnwrap(cases.first)
        let original = try XCTUnwrap(vector["payloadUtf8"] as? String)
        let payloads = [Data(("{\"unknown\":1," + original.dropFirst()).utf8),
            Data(("{\"type\":\"question\"," + original.dropFirst()).utf8),
            Data(("{\"\\u0074ype\":\"question\"," + original.dropFirst()).utf8),
            Data(original.replacingOccurrences(of: "\"actionable\":true", with: "\"actionable\":1").utf8),
            Data(original.replacingOccurrences(of: "\"standingGrant\":null", with: "\"standingGrant\":\"all\"").utf8),
            Data([0xff, 0xfe]), Data("{\"type\":\"dismiss\",\"actionable\":false}".utf8)]
        for (index, payload) in payloads.enumerated() {
            XCTAssertThrowsError(try open(reseal(vector) { $0[11] = payload }), "Actually signed invalid payload case \(index) must refuse")
        }
    }
    func testExactTimeAndWholeInnerMultibyteBoundaries() throws {
        let vector = try XCTUnwrap(cases.first)
        XCTAssertNoThrow(try open(try carrier(vector), now: 1_699_999_940), "Future issue at exactly60 seconds is valid")
        XCTAssertThrowsError(try open(try carrier(vector), now: 1_699_999_939), "Future issue beyond60 seconds refuses")
        XCTAssertNoThrow(try open(try carrier(vector), now: 1_700_000_119), "Expiry has no early cutoff")
        XCTAssertThrowsError(try open(try carrier(vector), now: 1_700_000_120), "Expiry has no grace")
        XCTAssertNoThrow(try open(reseal(vector) { $0[10] = self.be64(1_700_003_600) }), "Question TTL exactly3600 is valid")
        XCTAssertThrowsError(try open(reseal(vector) { $0[10] = self.be64(1_700_003_601) }), "Question TTL cannot extend beyond3600")
        let fields = parts(parts(try hex(XCTUnwrap(vector["innerHex"] as? String)))[0])
        var payload = try XCTUnwrap(JSONSerialization.jsonObject(with: fields[11]) as? [String: Any])
        var options = try XCTUnwrap(payload["options"] as? [[String: Any]])
        func resized(_ size: Int) throws -> [String: Any] {
            options[0]["description"] = ""; payload["options"] = options
            let empty = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .withoutEscapingSlashes])
            let envelope = lps([lps(fields.dropLast() + [empty]), Data(repeating: 0, count: 64)]).count
            let room = size - envelope
            options[0]["description"] = String(repeating: "é", count: room / 2) + (room % 2 == 1 ? "a" : "")
            payload["options"] = options
            let bytes = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys, .withoutEscapingSlashes])
            XCTAssertEqual(lps([lps(fields.dropLast() + [bytes]), Data(repeating: 0, count: 64)]).count, size)
            return try reseal(vector) { $0[11] = bytes }
        }
        XCTAssertNoThrow(try open(resized(2048)), "The WHOLE multibyte signed inner envelope exactly2048 bytes is valid")
        XCTAssertThrowsError(try open(resized(2049)), "The WHOLE envelope cap includes metadata, signature and multibyte text")
    }
    func testCarrierCanonicalEncodingsTypesAndUnknownFlagsCannotGrantAuthority() throws {
        let original = try carrier(XCTUnwrap(cases.first))
        XCTAssertNoThrow(try open(original))
        let mutations: [(String, Any)] = [("v", true), ("v", 3), ("keyVersion", true), ("keyVersion", 0), ("keyVersion", 3.5),
            ("keyVersion", 9_007_199_254_740_992 as Int64), ("keyVersion", 4), ("kind", "QUESTION"),
            ("rid", "94B442B3712A799934ED2BDEF943D321"), ("collapseId", "Yxc4uePYQ4cjMoWyFwSxOA=="),
            ("sealed", try XCTUnwrap(original["sealed"] as? String) + "=")]
        for (key, value) in mutations {
            var outer = original; outer[key] = value
            XCTAssertThrowsError(try open(outer), "Carrier canonical/type field \(key) must refuse")
        }
        var unknown = original; unknown["verified"] = true
        XCTAssertThrowsError(try open(unknown), "A supplied verified flag is never accepted")
        for key in original.keys {
            var missing = original; missing.removeValue(forKey: key)
            XCTAssertThrowsError(try open(missing), "Required carrier field \(key) cannot be omitted")
        }
        let untrusted = try NativePushCodec.open(userInfo: ["aps": ["category": "REMI_YN"], "verified": true,
            "sessionId": "untrusted", "options": ["forged"], "remiPush": original], state: state, keys: keys, now: 1_700_000_000)
        guard case .question(let question) = untrusted.payload else { XCTFail("Shared vector must remain a question"); return }
        XCTAssertEqual(question.sessionId, "synthetic-session")
        XCTAssertEqual(question.category, .yesNoAlways)
        XCTAssertEqual(question.options[1].standingGrant, .addRules)
        XCTAssertEqual(question.options[1].description, "Read only the synthetic fixture directory")
    }
    func testAllReviewedWeakPublicKeysAndMalformedTupleShapesRefuse() throws {
        let vector = try XCTUnwrap(cases.first)
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fixtures/ed25519-server-keys.json")
        let fixtures = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [[String: Any]])
        let weak = try fixtures.filter { ($0["smallOrder"] as? Bool) == true }.map { try XCTUnwrap($0["publicKey"] as? String) }
        XCTAssertEqual(weak.count, 14)
        for encoding in weak {
            let bytes = try XCTUnwrap(Data(base64Encoded: encoding))
            for index in [0, 2] {
                XCTAssertThrowsError(try open(reseal(vector) { $0[index] = bytes }), "Reviewed weak Ed25519 field \(index) must refuse")
            }
        }
        XCTAssertThrowsError(try open(reseal(vector) { $0.append(Data()) }), "Extra length-prefixed tuple field refuses")
        XCTAssertThrowsError(try open(reseal(vector) { $0.removeLast() }), "Missing length-prefixed tuple field refuses")
        XCTAssertThrowsError(try open(reseal(vector) { $0[3] = Data([4]) + Data(repeating: 0, count: 64) }), "Off-curve P256 recipient refuses")
        XCTAssertThrowsError(try open(reseal(vector) { $0[6] = self.be64(9_007_199_254_740_992) }), "Tuple integers cannot exceed JS safe range")
    }
    func testInformationalTTLAndCompleteUTF8DisplayCaps() throws {
        let information = try XCTUnwrap(cases.first { ($0["name"] as? String) == "turn_complete" })
        XCTAssertNoThrow(try open(reseal(information) { $0[10] = self.be64(1_700_000_300) }), "Informational TTL exactly300 is valid")
        XCTAssertThrowsError(try open(reseal(information) { $0[10] = self.be64(1_700_000_301) }), "Information cannot claim the question TTL")
        let vector = try XCTUnwrap(cases.first)
        var payload = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(XCTUnwrap(vector["payloadUtf8"] as? String).utf8)) as? [String: Any])
        for (key, maximum) in [("title", 128), ("body", 512)] {
            payload[key] = String(repeating: "é", count: maximum / 2)
            let exact = try JSONSerialization.data(withJSONObject: payload)
            XCTAssertNoThrow(try open(reseal(vector) { $0[11] = exact }), "Exact \(key) UTF8 cap is valid")
            payload[key] = String(repeating: "é", count: maximum / 2) + "a"
            let over = try JSONSerialization.data(withJSONObject: payload)
            XCTAssertThrowsError(try open(reseal(vector) { $0[11] = over }), "Complete \(key) is measured in UTF8 bytes, never silently truncated")
            payload[key] = "Synthetic"
        }
    }
    func testSameIdentityRecoveryAndRecipientRotationDuringFinalReadRefuse() throws {
        let original = try carrier(XCTUnwrap(cases.first))
        let verified = try open(original)
        var operations = NativeKeychainOperations.system; var reads = 0
        operations.copyMatching = { request, result in
            reads += 1
            if reads == 2 {
                do {
                    let other = try NativePushState(file: self.directory.appendingPathComponent("public.sqlite"))
                    let lease = try other.acquireIdentityMutation(); defer { lease.release() }
                    let next = try lease.invalidateIdentityAuthority()
                    try lease.installIdentityAuthority(publicKey: verified.trust.authority.publicKey, revision: verified.trust.authority.revision,
                        requiresAppUnlock: verified.trust.authority.requiresAppUnlock, generation: next)
                    try other.installMachineTrust(verified.trust, generation: next)
                } catch { XCTFail("Owned same-identity recovery setup failed"); return errSecNotAvailable }
            }
            return SecItemCopyMatching(request, result)
        }
        let observed = NativePushKeyStore(service: service, account: account, accessGroup: nil, operations: operations)
        XCTAssertThrowsError(try NativePushCodec.open(userInfo: ["remiPush": original], state: state, keys: observed, now: 1_700_000_000),
                             "A fresh durable generation invalidates decode even when recovered public identity/trust compare equal")
        XCTAssertEqual(try state.machineTrust(rid: verified.record.rid), verified.trust)
        XCTAssertNoThrow(try open(original), "The independently fresh current decode remains valid")
        reads = 0
        operations.copyMatching = { request, result in
            reads += 1
            if reads == 2 {
                do {
                    struct Record: Encodable { let version: Int; let privateDER: Data; let publicKey: Data; let keyVersion: Int }
                    let next = P256.KeyAgreement.PrivateKey()
                    let record = try JSONEncoder().encode(Record(version: 1, privateDER: next.derRepresentation,
                        publicKey: next.publicKey.x963Representation, keyVersion: 4))
                    XCTAssertEqual(SecItemUpdate(self.query as CFDictionary, [kSecValueData as String: record] as CFDictionary), errSecSuccess)
                } catch { XCTFail("Owned P256 rotation setup failed"); return errSecNotAvailable }
            }
            return SecItemCopyMatching(request, result)
        }
        let rotated = NativePushKeyStore(service: service, account: account, accessGroup: nil, operations: operations)
        XCTAssertThrowsError(try NativePushCodec.open(userInfo: ["remiPush": original], state: state, keys: rotated, now: 1_700_000_000),
                             "Actual recipient rotation during final read invalidates the original capsule")
        XCTAssertEqual(try keys.load()?.keyVersion, 4)
    }
    func testDiagnosticLegacyTrustCannotOpenSecureContent() throws {
        let original = try carrier(XCTUnwrap(cases.first))
        let verified = try open(original)
        XCTAssertEqual(verified.trust.relayUrl, "wss://relay.example.invalid")
        let legacy = NativePushState.MachineTrust(rid: verified.trust.rid, machinePublicKey: verified.trust.machinePublicKey,
            endpoint: verified.trust.endpoint, authority: verified.trust.authority)
        try state.installMachineTrust(legacy, generation: state.authorityGeneration())
        XCTAssertEqual(try state.machineTrust(rid: legacy.rid), legacy, "Diagnostic legacy row remains intact and readable")
        XCTAssertThrowsError(try open(original), "A nullable legacy route is not completed native pairing authority")
        XCTAssertEqual(try state.machineTrust(rid: legacy.rid), legacy, "Refusal cannot repair or delete old public state")
    }
    func testBooleanCannotAliasActualRecipientVersionOne() throws {
        let key = try XCTUnwrap(keys.load())
        struct Record: Encodable { let version: Int; let privateDER: Data; let publicKey: Data; let keyVersion: Int }
        let record = try JSONEncoder().encode(Record(version: 1, privateDER: key.privateKey.derRepresentation, publicKey: key.publicKey, keyVersion: 1))
        XCTAssertEqual(SecItemUpdate(query as CFDictionary, [kSecValueData as String: record] as CFDictionary), errSecSuccess)
        let vector = try XCTUnwrap(cases.first)
        var original = try reseal(vector) { $0[4] = self.be64(1) }
        original["keyVersion"] = 1
        XCTAssertNoThrow(try open(original), "Actual version-one recipient and signed tuple must have a passing baseline")
        original["keyVersion"] = true
        XCTAssertThrowsError(try open(original), "JSON true cannot alias the actual numeric recipient version1")
    }
}
