import CryptoKit
import Foundation
import Security
import UserNotifications
import XCTest

final class NativePushNotificationConsumerTests: XCTestCase {
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
        service = "live.yooz.remi.tests.consumer-" + UUID().uuidString
        account = "owned-p256-" + UUID().uuidString
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi1200-consumer-" + UUID().uuidString)
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
                "sealed": try XCTUnwrap(submit["sealed"])]
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
    private func terminalInfo() throws -> [AnyHashable: Any] {
        let original = try NativePushCodec.open(userInfo: info("question-yn"), state: state, keys: keys, now: clock)
        return ["remiPush": try reseal(vector("dismiss")) { fields in
            fields[5] = Data(original.record.collapseId.utf8)
            fields[6] = self.be64(UInt64(original.record.revision + 1))
        }]
    }
    private final class ReadProbe {
        let lock = NSLock()
        let activity: XCTestExpectation
        let completed = XCTestExpectation(description: "Native quiet dismiss completed")
        var callback: (([NativePushNotificationConsumer.DeliveredCard]) -> Void)?
        var outcome: NativePushNotificationConsumer.DismissOutcome?
        var removals: [[String]] = []
        var completionCount = 0
        var activitySent = false
        init(_ test: XCTestCase) { activity = test.expectation(description: "Native dismiss reached OS read or completion") }
        func read(_ callback: @escaping ([NativePushNotificationConsumer.DeliveredCard]) -> Void) {
            lock.lock(); self.callback = callback; let first = !activitySent; activitySent = true; lock.unlock()
            if first { activity.fulfill() }
        }
        func complete(_ outcome: NativePushNotificationConsumer.DismissOutcome) {
            lock.lock(); completionCount += 1; let firstCompletion = self.outcome == nil; self.outcome = outcome
            let first = !activitySent; activitySent = true; lock.unlock()
            if first { activity.fulfill() }; if firstCompletion { completed.fulfill() }
        }
        func remove(_ identifiers: [String]) { lock.lock(); removals.append(identifiers); lock.unlock() }
        func release(_ cards: [NativePushNotificationConsumer.DeliveredCard]) { lock.lock(); let callback = self.callback; lock.unlock(); callback?(cards) }
        func completions() -> Int { lock.lock(); defer { lock.unlock() }; return completionCount }
        func wasRead() -> Bool { lock.lock(); defer { lock.unlock() }; return callback != nil }
        func snapshot() -> (NativePushNotificationConsumer.DismissOutcome?, [[String]]) { lock.lock(); defer { lock.unlock() }; return (outcome, removals) }
    }
    private func beginDismiss() throws -> (NativePushNotificationConsumer, ReadProbe, [AnyHashable: Any]) {
        let probe = ReadProbe(self)
        let consumer = NativePushNotificationConsumer(state: state, keys: keys, now: { self.clock },
            readDelivered: probe.read, removeDelivered: probe.remove)
        _ = try effect().prepare(userInfo: info("question-yn"))
        let terminal = try terminalInfo()
        consumer.receiveDismiss(userInfo: terminal, completion: probe.complete)
        wait(for: [probe.activity], timeout: 3)
        return (consumer, probe, terminal)
    }
    func testActualQuietDismissCommitsBeforeWaitAndDeletesOnlyVerifiedNamespace() throws {
        let (consumer, probe, terminal) = try beginDismiss(); _ = consumer
        guard probe.wasRead() else { XCTFail("Actual signed dismiss must reach delivered-card read"); return }
        let opened = try NativePushCodec.open(userInfo: terminal, state: state, keys: keys, now: clock)
        let other = try NativePushState(file: directory.appendingPathComponent("public.sqlite"))
        XCTAssertNoThrow(try other.reverifyLatestDismiss(opened.record, trust: opened.trust, now: clock, generation: opened.authorityGeneration),
            "Quiet dismiss must durably commit its absorbing tombstone BEFORE the OS wait")
        probe.release([
            .init(identifier: "owned-signed-card", userInfo: try info("question-yn")),
            .init(identifier: "another-signed-collapse", userInfo: try info("question")),
            .init(identifier: "terminal-capsule-is-not-a-card", userInfo: terminal),
            .init(identifier: "forged-outer-routing", userInfo: ["questionId": "same", "collapseId": opened.record.collapseId, "verified": true])
        ])
        wait(for: [probe.completed], timeout: 3)
        XCTAssertEqual(probe.snapshot().0, .removed(1)); XCTAssertEqual(probe.snapshot().1, [["owned-signed-card"]])
    }
    func testActualQuietDismissFreshGenerationAfterWaitRefusesDeletion() throws {
        let (consumer, probe, _) = try beginDismiss(); _ = consumer
        guard probe.wasRead() else { XCTFail("Actual signed dismiss must reach delivered-card read"); return }
        let old = try XCTUnwrap(state.currentAuthority())
        let trust = try XCTUnwrap(state.machineTrust(rid: hex(XCTUnwrap((cases[0]["content"] as? [String: Any])?["rid"] as? String))))
        let lease = try state.acquireIdentityMutation(); let generation = try lease.invalidateIdentityAuthority()
        try lease.installIdentityAuthority(publicKey: old.publicKey, revision: old.revision, requiresAppUnlock: old.requiresAppUnlock, generation: generation)
        try state.installMachineTrust(trust, generation: generation); lease.release()
        XCTAssertEqual(try state.currentAuthority(), old)
        probe.release([.init(identifier: "owned-signed-card", userInfo: try info("question-yn"))])
        wait(for: [probe.completed], timeout: 3)
        XCTAssertEqual(probe.snapshot().0, .unavailable); XCTAssertTrue(probe.snapshot().1.isEmpty)
    }
    func testActualQuietDismissP256ReplacementAfterWaitRefusesDeletion() throws {
        let (consumer, probe, _) = try beginDismiss(); _ = consumer
        guard probe.wasRead() else { XCTFail("Actual signed dismiss must reach delivered-card read"); return }
        let next = P256.KeyAgreement.PrivateKey()
        struct Record: Encodable { let version: Int; let privateDER: Data; let publicKey: Data; let keyVersion: Int }
        let bytes = try JSONEncoder().encode(Record(version: 1, privateDER: next.derRepresentation, publicKey: next.publicKey.x963Representation, keyVersion: 3))
        XCTAssertEqual(SecItemUpdate(query as CFDictionary, [kSecValueData as String: bytes] as CFDictionary), errSecSuccess)
        probe.release([.init(identifier: "owned-signed-card", userInfo: try info("question-yn"))])
        wait(for: [probe.completed], timeout: 3)
        XCTAssertEqual(probe.snapshot().0, .unavailable); XCTAssertTrue(probe.snapshot().1.isEmpty)
    }
    func testActualQuietDismissRejectsUnsignedOuterFlagsWithoutOSRead() throws {
        let probe = ReadProbe(self)
        let consumer = NativePushNotificationConsumer(state: state, keys: keys, now: { self.clock }, readDelivered: probe.read, removeDelivered: probe.remove)
        consumer.receiveDismiss(userInfo: ["dismiss": true, "verified": true, "questionId": "forged"], completion: probe.complete)
        wait(for: [probe.activity, probe.completed], timeout: 3)
        XCTAssertEqual(probe.snapshot().0, .unavailable); XCTAssertFalse(probe.wasRead()); XCTAssertTrue(probe.snapshot().1.isEmpty)
    }
    func testActualQuietDismissDeliveredScanCapacityRefusesAllDeletion() throws {
        let (consumer, probe, _) = try beginDismiss(); _ = consumer
        guard probe.wasRead() else { XCTFail("Actual signed dismiss must reach delivered-card read"); return }
        let original = try info("question-yn")
        probe.release((0..<129).map { .init(identifier: "owned-card-\($0)", userInfo: original) })
        wait(for: [probe.completed], timeout: 3)
        XCTAssertEqual(probe.snapshot().0, .unavailable); XCTAssertTrue(probe.snapshot().1.isEmpty,
            "A bounded refusal must not partially delete a notification scan")
    }
    func testActualQuietDismissDeadlineSuppressesLateOSCallbackAndCompletesOnce() throws {
        let (consumer, probe, _) = try beginDismiss(); _ = consumer
        guard probe.wasRead() else { XCTFail("Actual signed dismiss must reach delivered-card read"); return }
        let original = try info("question-yn")
        let lateCallbackSent = expectation(description: "Actual OS boundary callback delivered after its two-second lifetime")
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.15) {
            probe.release([.init(identifier: "owned-signed-card", userInfo: original)])
            probe.release([.init(identifier: "owned-signed-card", userInfo: original)])
            // Observe the already enqueued callbacks, without touching a private
            // coordinator queue or bypassing its production lifetime checks.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { lateCallbackSent.fulfill() }
        }
        wait(for: [probe.completed, lateCallbackSent], timeout: 4)
        XCTAssertEqual(probe.snapshot().0, .unavailable, "An expired read cannot become a successful deletion")
        XCTAssertTrue(probe.snapshot().1.isEmpty, "Late OS callback cannot remove a notification")
        XCTAssertEqual(probe.completions(), 1, "Timeout and repeated late callback have one completion owner")
    }
    func testBackgroundQuestionCannotConsumeNonceOrSuppressItsNSE() throws {
        let probe = ReadProbe(self)
        let consumer = NativePushNotificationConsumer(state: state, keys: keys, now: { self.clock }, readDelivered: probe.read, removeDelivered: probe.remove)
        consumer.receiveDismiss(userInfo: try info("question-yn"), completion: probe.complete)
        wait(for: [probe.activity, probe.completed], timeout: 3)
        XCTAssertEqual(probe.snapshot().0, .ignored); XCTAssertFalse(probe.wasRead())
        XCTAssertEqual(try effect().prepare(userInfo: info("question-yn")).outcome, .publish,
            "A background question wake must not consume the notification's lifecycle nonce")
    }
    func testForegroundRefusesAnyCategoryOnASignedCard() throws {
        let prepared = try effect().prepare(userInfo: info("question-yn"))
        guard case .question(let question) = prepared.push.payload else { XCTFail("Shared fixture must be a real question"); return }
        let consumer = NativePushNotificationConsumer(state: state, keys: keys, now: { self.clock })
        let content = UNMutableNotificationContent()
        content.title = question.title; content.body = question.body; content.userInfo = try info("question-yn")
        XCTAssertTrue(consumer.allowsPresentation(content), "The signed text without actions is presentable")
        // The category a v2 card used to carry. No v2 card has actions before R6.
        let rid = try XCTUnwrap(carrierRid()), record = prepared.push.record
        content.categoryIdentifier = "REMI_SECURE_\(rid)_\(record.collapseId)_\(record.revision)"
        XCTAssertFalse(consumer.allowsPresentation(content), "A category on a signed card grants an action no native owner answers")
    }
    private func carrierRid() throws -> String? {
        (try info("question-yn")["remiPush"] as? [String: Any])?["rid"] as? String
    }
    func testV2ResponsesNeverReachTheLegacyOrWrappedSender() throws {
        var legacySends = 0
        // The default tap on a signed card, one with a forged outer route, a
        // stale action identifier, and a malformed carrier: all stay v2.
        var forged = try info("question-yn"); forged["opt_0"] = "FORGED ANSWER"; forged["questionId"] = "FORGED ROUTE"; forged["verified"] = false
        for userInfo in [try info("question-yn"), forged, ["remiPush": NSNull(), "opt_0": "forged", "verified": true],
                         ["remiPush": ["v": 2], "sessionId": "old-direct"]] as [[AnyHashable: Any]] {
            NativePushNotificationConsumer.routeResponse(userInfo: userInfo, legacy: { legacySends += 1 })
        }
        XCTAssertEqual(legacySends, 0, "A v2 marker never falls through to another answer owner")
        XCTAssertEqual(SecItemDelete(query as CFDictionary), errSecSuccess)
        NativePushNotificationConsumer.routeResponse(userInfo: try info("question-yn"), legacy: { legacySends += 1 })
        XCTAssertEqual(legacySends, 0, "A missing native key cannot fall through either")
    }
    func testLegacyNotificationRouteRemainsExplicitlySeparate() {
        var legacySends = 0
        NativePushNotificationConsumer.routeResponse(userInfo: ["sessionId": "old-direct"], legacy: { legacySends += 1 })
        XCTAssertEqual(legacySends, 1)
    }
}
