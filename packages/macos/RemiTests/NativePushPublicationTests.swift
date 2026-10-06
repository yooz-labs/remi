import CryptoKit
import Foundation
import Security
import XCTest
import UserNotifications

final class NativePushPublicationTests: XCTestCase {
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
        service = "live.yooz.remi.tests.publication-" + UUID().uuidString
        account = "owned-p256-" + UUID().uuidString
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi1200-publication-" + UUID().uuidString)
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
    private final class DeliveryProbe {
        let lock = NSLock()
        var callback: ((Bool) -> Void)?
        var category: UNNotificationCategory?
        var contents: [UNNotificationContent] = []
        var activitySent = false
        let activity: XCTestExpectation
        let completed: XCTestExpectation
        init(_ test: XCTestCase) {
            activity = test.expectation(description: "Actual NSE reached category or completion boundary")
            completed = XCTestExpectation(description: "Actual NSE completed its delivery")
        }
        func installed(_ category: UNNotificationCategory, callback: @escaping (Bool) -> Void) {
            lock.lock(); self.category = category; self.callback = callback
            let first = !activitySent; activitySent = true; lock.unlock()
            if first { activity.fulfill() }
        }
        func delivered(_ content: UNNotificationContent) {
            lock.lock(); contents.append(content); let firstDelivery = contents.count == 1
            let first = !activitySent; activitySent = true; lock.unlock()
            if first { activity.fulfill() }; if firstDelivery { completed.fulfill() }
        }
        func release(_ installed: Bool) { lock.lock(); let callback = self.callback; lock.unlock(); callback?(installed) }
        func snapshot() -> [UNNotificationContent] { lock.lock(); defer { lock.unlock() }; return contents }
        func installedCategory() -> UNNotificationCategory? { lock.lock(); defer { lock.unlock() }; return category }
    }
    private func begin(_ name: String = "question-yn") throws -> (NotificationService, DeliveryProbe) {
        let probe = DeliveryProbe(self)
        let service = NotificationService(effectFactory: { self.effect() }, installCategory: probe.installed)
        let content = UNMutableNotificationContent()
        content.title = "FORGED outer title"; content.body = "FORGED outer body"; content.categoryIdentifier = "REMI_YNA"
        content.userInfo = try info(name)
        content.userInfo["qid"] = "unverified-routing"; content.userInfo["verified"] = true
        service.didReceive(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil),
                           withContentHandler: probe.delivered)
        wait(for: [probe.activity], timeout: 3)
        return (service, probe)
    }
    func testActualNSECommitsBeforeCategoryWaitAndPublishesOnlySignedContent() throws {
        let (service, probe) = try begin()
        defer { service.serviceExtensionTimeWillExpire() }
        guard let category = probe.installedCategory() else { XCTFail("Actual signed YN must reach native category installation"); return }
        XCTAssertTrue(probe.snapshot().isEmpty, "No delivery before the asynchronous category boundary")
        let opened = try NativePushCodec.open(userInfo: info("question-yn"), state: state, keys: keys, now: clock)
        let other = try NativePushState(file: directory.appendingPathComponent("public.sqlite"))
        XCTAssertNoThrow(try other.reverifyLatestContent(opened.record, trust: opened.trust, now: clock), "NSE must durably commit before waiting")
        XCTAssertEqual(category.actions.map(\.identifier), ["OPT_0", "OPT_1"])
        XCTAssertTrue(category.actions.allSatisfy { $0.options.contains(.foreground) }, "R5 actions open app until R6 has a native submission owner")
        probe.release(true); wait(for: [probe.completed], timeout: 3)
        let result = try XCTUnwrap(probe.snapshot().first)
        guard case .question(let question) = opened.payload else { XCTFail("Shared fixture must be a real question"); return }
        XCTAssertEqual(result.title, question.title); XCTAssertEqual(result.body, question.body)
        XCTAssertEqual(result.categoryIdentifier, category.identifier)
        XCTAssertEqual(Set(result.userInfo.keys.compactMap { $0 as? String }), ["remiPush"])
        let consumer = NativePushNotificationConsumer(state: state, keys: keys, now: { self.clock })
        XCTAssertTrue(consumer.allowsPresentation(result), "The actual foreground consumer must verify the original NSE capsule and signed text")
        let forged = try XCTUnwrap(result.mutableCopy() as? UNMutableNotificationContent)
        forged.title = "Forged foreground title"
        XCTAssertFalse(consumer.allowsPresentation(forged))
        forged.title = result.title; forged.categoryIdentifier = "REMI_YNA"
        XCTAssertFalse(consumer.allowsPresentation(forged), "An unverified static category cannot grant native foreground actions")

    }
    func testActualNSECategoryRefusalPreservesVerifiedTextWithoutActions() throws {
        let (service, probe) = try begin(); defer { service.serviceExtensionTimeWillExpire() }
        guard probe.installedCategory() != nil else { XCTFail("Signed YN must reach the real category boundary"); return }
        probe.release(false); wait(for: [probe.completed], timeout: 3)
        let result = try XCTUnwrap(probe.snapshot().first)
        XCTAssertNotEqual(result.title, "FORGED outer title")
        XCTAssertNotEqual(result.title, "Remi needs your attention")
        XCTAssertEqual(result.categoryIdentifier, "")
    }
    func testActualNSEExpirationSuppressesLateCategoryCallback() throws {
        let (service, probe) = try begin()
        guard probe.installedCategory() != nil else { XCTFail("Signed YN must reach the real category boundary"); return }
        service.serviceExtensionTimeWillExpire(); wait(for: [probe.completed], timeout: 3)
        let result = try XCTUnwrap(probe.snapshot().first)
        probe.release(true); service.serviceExtensionTimeWillExpire()
        XCTAssertEqual(result.title, "Remi needs your attention"); XCTAssertEqual(result.categoryIdentifier, "")
        XCTAssertEqual(probe.snapshot().count, 1, "Late callback cannot deliver a second notification")
    }
    func testActualNSESamePublicRecoveryAfterWaitRefusesPublication() throws {
        let (service, probe) = try begin(); defer { service.serviceExtensionTimeWillExpire() }
        guard probe.installedCategory() != nil else { XCTFail("Signed YN must reach the real category boundary"); return }
        let old = try XCTUnwrap(state.currentAuthority())
        let trust = try XCTUnwrap(state.machineTrust(rid: hex(XCTUnwrap((cases[0]["content"] as? [String: Any])?["rid"] as? String))))
        let lease = try state.acquireIdentityMutation()
        let generation = try lease.invalidateIdentityAuthority()
        try lease.installIdentityAuthority(publicKey: old.publicKey, revision: old.revision,
            requiresAppUnlock: old.requiresAppUnlock, generation: generation)
        try state.installMachineTrust(trust, generation: generation); lease.release()
        XCTAssertEqual(try state.currentAuthority(), old)
        probe.release(true); wait(for: [probe.completed], timeout: 3)
        let result = try XCTUnwrap(probe.snapshot().first)
        XCTAssertEqual(result.title, "Remi needs your attention"); XCTAssertEqual(result.categoryIdentifier, "")
    }
    func testActualNSERecipientRotationAfterWaitRefusesPublication() throws {
        let (service, probe) = try begin(); defer { service.serviceExtensionTimeWillExpire() }
        guard probe.installedCategory() != nil else { XCTFail("Signed YN must reach the real category boundary"); return }
        let next = P256.KeyAgreement.PrivateKey()
        struct Record: Encodable { let version: Int; let privateDER: Data; let publicKey: Data; let keyVersion: Int }
        let bytes = try JSONEncoder().encode(Record(version: 1, privateDER: next.derRepresentation,
            publicKey: next.publicKey.x963Representation, keyVersion: 3))
        XCTAssertEqual(SecItemUpdate(query as CFDictionary, [kSecValueData as String: bytes] as CFDictionary), errSecSuccess)
        probe.release(true); wait(for: [probe.completed], timeout: 3)
        let result = try XCTUnwrap(probe.snapshot().first)
        XCTAssertEqual(result.title, "Remi needs your attention"); XCTAssertEqual(result.categoryIdentifier, "")
    }
    func testActualNSESignedDismissDuringWaitRefusesOldCard() throws {
        let (service, probe) = try begin(); defer { service.serviceExtensionTimeWillExpire() }
        guard probe.installedCategory() != nil else { XCTFail("Signed YN must reach the real category boundary"); return }
        let original = try NativePushCodec.open(userInfo: info("question-yn"), state: state, keys: keys, now: clock)
        let dismiss = try reseal(vector("dismiss")) { fields in
            fields[5] = Data(original.record.collapseId.utf8); fields[6] = self.be64(UInt64(original.record.revision + 1))
        }
        let terminal = try effect().prepare(userInfo: ["remiPush": dismiss])
        XCTAssertEqual(terminal.outcome, .dismiss)
        probe.release(true); wait(for: [probe.completed], timeout: 3)
        let result = try XCTUnwrap(probe.snapshot().first)
        XCTAssertEqual(result.title, "Remi needs your attention"); XCTAssertEqual(result.categoryIdentifier, "")
    }
    func testActualNSEDuplicateCannotReinstallPermissionCard() throws {
        var prepared: NativePushEffect.Prepared?
        XCTAssertNoThrow(prepared = try effect().prepare(userInfo: info("question-yn")), "Actual signed content must prepare before testing duplicate publication")
        guard let prepared else { return }
        XCTAssertEqual(prepared.outcome, .publish)
        let (service, probe) = try begin(); defer { service.serviceExtensionTimeWillExpire() }
        wait(for: [probe.completed], timeout: 3)
        let result = try XCTUnwrap(probe.snapshot().first)
        XCTAssertEqual(result.title, ""); XCTAssertEqual(result.body, ""); XCTAssertEqual(result.categoryIdentifier, "")
        XCTAssertNil(probe.installedCategory())
    }
}
