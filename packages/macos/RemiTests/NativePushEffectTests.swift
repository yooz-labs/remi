import CryptoKit
import Foundation
import Security
import SQLite3
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
        outer["collapseId"] = try XCTUnwrap(String(data: fields[5], encoding: .utf8))
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
        guard let first = prepared(e, "question") else { return }
        let successor = try reseal(vector("question-reordered")) { $0[5] = Data(first.push.record.collapseId.utf8) }
        var later: NativePushEffect.Prepared?
        XCTAssertNoThrow(later = try e.prepare(userInfo: ["remiPush": successor]))
        guard let later else { return }
        XCTAssertEqual(first.push.record.collapseId, later.push.record.collapseId)
        XCTAssertNotEqual(first.push.record.digest, later.push.record.digest)
        XCTAssertThrowsError(try e.recheck(first), "An accepted older nonce cannot publish after a newer signed meaning")
        XCTAssertThrowsError(try e.prepare(userInfo: info("question")), "A retained old nonce is not an eligible duplicate once another digest is latest")
        XCTAssertNoThrow(try e.recheck(later))
    }
    func testActualSignedDismissIsAbsorbing() throws {
        let e = effect()
        guard let first = prepared(e, "question") else { return }
        let terminal = try reseal(vector("dismiss")) { $0[5] = Data(first.push.record.collapseId.utf8) }
        var dismiss: NativePushEffect.Prepared?
        XCTAssertNoThrow(dismiss = try e.prepare(userInfo: ["remiPush": terminal]))
        guard let dismiss else { return }
        XCTAssertEqual(first.push.record.collapseId, dismiss.push.record.collapseId)
        XCTAssertGreaterThan(dismiss.push.record.revision, first.push.record.revision)
        XCTAssertNotEqual(first.push.record.nonce, dismiss.push.record.nonce)
        XCTAssertEqual(dismiss.outcome, .dismiss)
        XCTAssertNoThrow(try e.recheck(dismiss), "Current signed terminal digest must authorize actual delayed dismiss after recheck")
        XCTAssertThrowsError(try e.recheck(first))
        let reopening = try reseal(vector("question-yn")) { $0[5] = Data(first.push.record.collapseId.utf8) }
        XCTAssertThrowsError(try e.prepare(userInfo: ["remiPush": reopening]), "A later question revision cannot reopen the signed terminal collapse")
    }
    func testDeadlineBoundaryInvalidatesPreparedEffect() throws {
        let e = effect()
        guard let p = prepared(e, "question-yn") else { return }
        clock = p.push.record.expiresAt
        XCTAssertThrowsError(try e.recheck(p), "Expiry is exclusive at the actual effect boundary")
    }
    func testUnsignedOuterFieldsCannotChangeTheSignedMeaning() throws {
        let e = effect()
        var outer = try info("informational-question-no-authority")
        outer["aps"] = ["category": "REMI_YNA"]
        outer["verified"] = true
        outer["questionId"] = "forged-outer-question"
        outer["opt_0"] = "allow"
        var p: NativePushEffect.Prepared?
        XCTAssertNoThrow(p = try e.prepare(userInfo: outer))
        guard let p else { return }
        if case .informational = p.push.payload {} else { XCTFail("Outer fields changed the signed informational meaning") }
    }
    func testActualSQLiteDigestOnlyChangeInvalidatesPreparedEffect() throws {
        let e = effect()
        guard let p = prepared(e, "question-yn") else { return }
        XCTAssertNoThrow(try e.recheck(p))
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open_v2(directory.appendingPathComponent("public.sqlite").path, &db,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil), SQLITE_OK)
        guard let db else { return }
        defer { sqlite3_close(db) }
        var stmt: OpaquePointer?
        XCTAssertEqual(sqlite3_prepare_v2(db, "UPDATE push_collapse SET digest=? WHERE rid=? AND collapse_id=? AND revision=?", -1, &stmt, nil), SQLITE_OK)
        guard let stmt else { return }
        defer { sqlite3_finalize(stmt) }
        let replacement = Data(repeating: 0x5a, count: 32)
        XCTAssertNotEqual(replacement, p.push.record.digest)
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        XCTAssertEqual(replacement.withUnsafeBytes { sqlite3_bind_blob(stmt, 1, $0.baseAddress, Int32($0.count), transient) }, SQLITE_OK)
        XCTAssertEqual(p.push.record.rid.withUnsafeBytes { sqlite3_bind_blob(stmt, 2, $0.baseAddress, Int32($0.count), transient) }, SQLITE_OK)
        XCTAssertEqual(p.push.record.collapseId.withCString { sqlite3_bind_text(stmt, 3, $0, -1, transient) }, SQLITE_OK)
        XCTAssertEqual(sqlite3_bind_int64(stmt, 4, p.push.record.revision), SQLITE_OK)
        XCTAssertEqual(sqlite3_step(stmt), SQLITE_DONE)
        XCTAssertEqual(sqlite3_changes(db), 1, "Owned real SQLite mutation must change exactly the selected latest digest")
        XCTAssertEqual(try state.authorityGeneration(), p.push.authorityGeneration)
        XCTAssertEqual(try state.currentAuthority(), p.push.trust.authority)
        XCTAssertEqual(try state.machineTrust(rid:p.push.record.rid), p.push.trust)
        XCTAssertEqual(try keys.load()?.publicKey, p.push.recipientPublicKey)
        XCTAssertEqual(try keys.load()?.keyVersion, p.push.keyVersion)
        XCTAssertThrowsError(try e.recheck(p), "Only latest digest changed: revision, nonce, generation and both public keys cannot mask the digest guard")
    }
}
