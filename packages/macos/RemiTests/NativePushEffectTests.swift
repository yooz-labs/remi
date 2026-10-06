import CryptoKit
import Foundation
import Security
import XCTest

final class NativePushEffectTests: XCTestCase {
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
        service = "live.yooz.remi.tests.effect-" + UUID().uuidString
        account = "owned-p256-" + UUID().uuidString
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi1200-effect-" + UUID().uuidString)
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
    private var clock: Int64 = 1_700_000_000
    private func effect() -> NativePushEffect { NativePushEffect(state: state, keys: keys, now: { self.clock }) }
    private func vector(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(cases.first { $0["name"] as? String == name })
    }
    private func info(_ name: String) throws -> [AnyHashable: Any] { ["remiPush": try carrier(vector(name))] }
    private func prepared(_ effect: NativePushEffect, _ name: String) -> NativePushEffect.Prepared? {
        var result: NativePushEffect.Prepared?
        XCTAssertNoThrow(result = try effect.prepare(userInfo: info(name)), "Actual signed fixture must prepare before testing later invalidation")
        return result
    }
    func testActualSignedPreparationCommitsOriginalLifecycle() throws {
        let e = effect()
        guard let p = prepared(e, "question-yn") else { return }
        XCTAssertEqual(p.outcome, .publish)
        XCTAssertEqual(p.actions.map(\.value), ["allow", "deny"])
        XCTAssertEqual(p.push.payloadBytes, try hex(XCTUnwrap(vector("question-yn")["payloadHex"] as? String)))
        XCTAssertNoThrow(try e.recheck(p))
        let other = try NativePushState(file: directory.appendingPathComponent("public.sqlite"))
        XCTAssertNoThrow(try other.reverifyLatestContent(p.push.record, trust: p.push.trust, now: clock), "Preparation must durably commit before publication")
        guard let duplicate = prepared(e, "question-yn") else { return }
        XCTAssertEqual(duplicate.outcome, .duplicate)
    }
    func testSamePublicIdentityFreshGenerationInvalidatesPreparedEffect() throws {
        let e = effect()
        guard let p = prepared(e, "question-yn") else { return }
        let other = try NativePushState(file: directory.appendingPathComponent("public.sqlite"))
        let old = try XCTUnwrap(other.currentAuthority())
        let lease = try other.acquireIdentityMutation()
        defer { lease.release() }
        let generation = try lease.invalidateIdentityAuthority()
        try lease.installIdentityAuthority(publicKey: old.publicKey, revision: old.revision,
            requiresAppUnlock: old.requiresAppUnlock, generation: generation)
        try other.installMachineTrust(p.push.trust, generation: generation)
        lease.release()
        XCTAssertEqual(try other.currentAuthority(), old, "Same public fields cannot reveal a lifetime replacement")
        XCTAssertNotEqual(generation, p.push.authorityGeneration)
        XCTAssertThrowsError(try e.recheck(p), "Captured authority generation must survive identical public-field recovery")
    }
    func testActualRecipientReplacementInvalidatesPreparedEffect() throws {
        let e = effect()
        guard let p = prepared(e, "question-yn") else { return }
        let next = P256.KeyAgreement.PrivateKey()
        struct Record: Encodable { let version: Int; let privateDER: Data; let publicKey: Data; let keyVersion: Int }
        let bytes = try JSONEncoder().encode(Record(version: 1, privateDER: next.derRepresentation,
            publicKey: next.publicKey.x963Representation, keyVersion: 3))
        XCTAssertEqual(SecItemUpdate(query as CFDictionary, [kSecValueData as String: bytes] as CFDictionary), errSecSuccess)
        XCTAssertEqual(try keys.load()?.keyVersion, p.push.keyVersion, "Same keyVersion cannot substitute for exact captured P256 bytes")
        XCTAssertNotEqual(try keys.load()?.publicKey, p.push.recipientPublicKey)
        XCTAssertThrowsError(try e.recheck(p))
    }
    func testLatestSignedDigestSupersedesOldPreparedEffect() throws {
        let e = effect()
        guard let first = prepared(e, "question"), let later = prepared(e, "question-reordered") else { return }
        XCTAssertEqual(first.push.record.collapseId, later.push.record.collapseId)
        XCTAssertNotEqual(first.push.record.digest, later.push.record.digest)
        XCTAssertThrowsError(try e.recheck(first), "An accepted older nonce cannot publish after a newer signed meaning")
        XCTAssertNoThrow(try e.recheck(later))
    }
    func testActualSignedDismissIsAbsorbingAndCarriesNoActions() throws {
        let e = effect()
        guard let first = prepared(e, "question"), let dismiss = prepared(e, "dismiss") else { return }
        XCTAssertEqual(dismiss.outcome, .dismiss)
        XCTAssertTrue(dismiss.actions.isEmpty)
        XCTAssertThrowsError(try e.recheck(first))
        XCTAssertThrowsError(try e.prepare(userInfo: info("question-yn")), "A later question revision cannot reopen the signed terminal collapse")
    }
    func testDeadlineBoundaryInvalidatesPreparedEffect() throws {
        let e = effect()
        guard let p = prepared(e, "question-yn") else { return }
        clock = p.push.record.expiresAt
        XCTAssertThrowsError(try e.recheck(p), "Expiry is exclusive at the actual effect boundary")
    }
    func testUnsignedOuterCategoryAndOptionsCannotGrantActions() throws {
        let e = effect()
        var outer = try info("informational-question-no-authority")
        outer["aps"] = ["category": "REMI_YNA"]
        outer["verified"] = true
        outer["questionId"] = "forged-outer-question"
        outer["opt_0"] = "allow"
        var p: NativePushEffect.Prepared?
        XCTAssertNoThrow(p = try e.prepare(userInfo: outer))
        guard let p else { return }
        XCTAssertTrue(p.actions.isEmpty, "Only the ORIGINAL signed payload can authorize options")
        if case .informational = p.push.payload {} else { XCTFail("Outer fields changed the signed informational meaning") }
    }
    func testActualSignedMultiChoiceAlwaysRequiresOpeningApp() throws {
        let e = effect()
        let v = try vector("question-yn")
        let original = try reseal(v, resign: false) { _ in }
        XCTAssertEqual(original["sealed"] as? String, try carrier(v)["sealed"] as? String,
            "Real independent CryptoKit producer must reproduce the shared capsule before edits")
        var payload = try XCTUnwrap(JSONSerialization.jsonObject(with: hex(XCTUnwrap(v["payloadHex"] as? String))) as? [String: Any])
        payload["category"] = "REMI_MULTI"
        let payloadBytes = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        let multi = try reseal(v) { $0[11] = payloadBytes }
        var p: NativePushEffect.Prepared?
        XCTAssertNoThrow(p = try e.prepare(userInfo: ["remiPush": multi]))
        guard let p else { return }
        XCTAssertTrue(p.actions.isEmpty, "ALL MULTI cards are app-only even when complete options are signed")
        for id in ["OPT_0", "OPT_1"] {
            XCTAssertThrowsError(try e.action(userInfo: ["remiPush": multi], identifier: id), "Signed MULTI must not reach a native answer")
        }
    }
    func testActionsIndependentlyVerifyOriginalCapsuleAndCanonicalOptionIndex() throws {
        let e = effect()
        let signed = try info("question-yn")
        XCTAssertThrowsError(try e.action(userInfo: signed, identifier: "OPT_0"), "Cryptographic authenticity without committed latest state is insufficient")
        guard let p = prepared(e, "question-yn") else { return }
        XCTAssertEqual(p.actions.map(\.value), ["allow", "deny"])
        for (id, value) in [("OPT_0", "allow"), ("OPT_1", "deny")] {
            var result: NativePushEffect.Action?
            XCTAssertNoThrow(result = try e.action(userInfo: signed, identifier: id))
            XCTAssertEqual(result?.option.value, value, "Native action must select ORIGINAL signed meaning")
            XCTAssertEqual(result?.question.questionId, "synthetic-question")
        }
        for id in ["OPT_00", "OPT_-1", "OPT_2", "OPT_3", "OPT_99999999999999999999999", "YES", "allow", "opt_0", "OPT_0x"] {
            XCTAssertThrowsError(try e.action(userInfo: signed, identifier: id), "Only exact canonical signed option indices may act")
        }
        var forged = signed
        forged["questionId"] = "foreign-question"
        forged["sessionId"] = "foreign-session"
        forged["opt_0"] = "deny"
        forged["verified"] = true
        let result = try e.action(userInfo: forged, identifier: "OPT_0")
        XCTAssertEqual(result.option.value, "allow")
        XCTAssertEqual(result.question.questionId, "synthetic-question")
        let later = prepared(e, "dismiss")
        XCTAssertNotNil(later)
        XCTAssertThrowsError(try e.action(userInfo: signed, identifier: "OPT_0"), "An old signed card cannot act after durable dismiss")
    }
    func testActionsRefuseExpiryAndUnsignedCapsule() throws {
        let e = effect()
        guard let p = prepared(e, "question-yn") else { return }
        XCTAssertNoThrow(try e.action(userInfo: info("question-yn"), identifier: "OPT_0"))
        clock = p.push.record.expiresAt
        XCTAssertThrowsError(try e.action(userInfo: info("question-yn"), identifier: "OPT_0"))
        XCTAssertThrowsError(try e.action(userInfo: ["verified":true,"opt_0":"allow","aps":["category":"REMI_YN"]], identifier:"OPT_0"))
    }
    func testProtectedAuthorityAndAppOnlySignedChoicesGrantNoNativeActions() throws {
        let e = effect()
        let old = try XCTUnwrap(state.currentAuthority())
        let content = try XCTUnwrap(vector("question")["content"] as? [String:Any])
        let rid = try hex(XCTUnwrap(content["rid"] as? String))
        let trust = try XCTUnwrap(state.machineTrust(rid: rid))
        let lease = try state.acquireIdentityMutation()
        defer { lease.release() }
        let generation = try lease.invalidateIdentityAuthority()
        try lease.installIdentityAuthority(publicKey:old.publicKey,revision:old.revision,requiresAppUnlock:true,generation:generation)
        let protected = NativePushState.MachineTrust(rid:trust.rid,machinePublicKey:trust.machinePublicKey,endpoint:trust.endpoint,
            authority:try XCTUnwrap(state.currentAuthority()),relayUrl:trust.relayUrl)
        try state.installMachineTrust(protected,generation:generation)
        guard let p = prepared(e,"question-yn") else { return }
        XCTAssertTrue(p.actions.isEmpty, "Protected Dpk policy requires foreground app unlock before answering")
        XCTAssertThrowsError(try e.action(userInfo:info("question-yn"),identifier:"OPT_0"))
    }
    func testOriginalLongSignedStandingScopeRequiresOpeningApp() throws {
        let e = effect()
        guard let p = prepared(e, "question") else { return }
        XCTAssertTrue(p.actions.isEmpty, "Original addRules scope must not be truncated or hidden to fit a native title")
        for id in ["OPT_0", "OPT_1", "OPT_2"] {
            XCTAssertThrowsError(try e.action(userInfo: info("question"), identifier: id), "A native action cannot bypass a complete standing scope that requires opening the app")
        }
    }

}
