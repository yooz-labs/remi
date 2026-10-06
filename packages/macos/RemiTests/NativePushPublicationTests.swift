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
    func testActualNSECommitsLifecycleBeforePublishingOnlySignedContent() throws {
        let (service, probe) = try begin()
        defer { service.serviceExtensionTimeWillExpire() }
        wait(for: [probe.completed], timeout: 3)
        let opened = try NativePushCodec.open(userInfo: info("question-yn"), state: state, keys: keys, now: clock)
        let other = try NativePushState(file: directory.appendingPathComponent("public.sqlite"))
        XCTAssertNoThrow(try other.reverifyLatestContent(opened.record, trust: opened.trust, now: clock), "NSE must durably commit before publishing")
        let result = try XCTUnwrap(probe.snapshot().first)
        guard case .question(let question) = opened.payload else { XCTFail("Shared fixture must be a real question"); return }
        XCTAssertEqual(result.title, question.title); XCTAssertEqual(result.body, question.body)
        XCTAssertEqual(result.categoryIdentifier, "")
        XCTAssertEqual(Set(result.userInfo.keys.compactMap { $0 as? String }), ["remiPush"])
        let consumer = NativePushNotificationConsumer(state: state, keys: keys, now: { self.clock })
        XCTAssertTrue(consumer.allowsPresentation(result), "The actual foreground consumer must verify the original NSE capsule and signed text")
        let forged = try XCTUnwrap(result.mutableCopy() as? UNMutableNotificationContent)
        forged.title = "Forged foreground title"
        XCTAssertFalse(consumer.allowsPresentation(forged))
        forged.title = result.title; forged.categoryIdentifier = "REMI_YNA"
        XCTAssertFalse(consumer.allowsPresentation(forged), "An unverified static category cannot grant native foreground actions")
    }
    func testActualNSEForegroundRejectsUnsignedSubtitleOnVerifiedAndFallbackContent() throws {
        let (service, probe) = try begin()
        defer { service.serviceExtensionTimeWillExpire() }
        wait(for: [probe.completed], timeout: 3)
        let content = try XCTUnwrap(probe.snapshot().first)
        let consumer = NativePushNotificationConsumer(state: state, keys: keys, now: { self.clock })
        XCTAssertTrue(consumer.allowsPresentation(content), "Unaltered actual NSE result remains presentable")
        let altered = try XCTUnwrap(content.mutableCopy() as? UNMutableNotificationContent)
        altered.subtitle = "Unsigned instruction outside the original capsule"
        XCTAssertFalse(consumer.allowsPresentation(altered), "Foreground signed content must not admit unsigned subtitle text")

        XCTAssertEqual(SecItemDelete(query as CFDictionary), errSecSuccess)
        let (fallbackService, fallbackProbe) = try begin()
        defer { fallbackService.serviceExtensionTimeWillExpire() }
        wait(for: [fallbackProbe.completed], timeout: 3)
        let fallback = try XCTUnwrap(fallbackProbe.snapshot().first)
        XCTAssertTrue(NativePushNotificationConsumer.isGenericFallback(fallback))
        XCTAssertTrue(consumer.allowsPresentation(fallback), "Actual missing-key fallback remains generic and presentable")
        let alteredFallback = try XCTUnwrap(fallback.mutableCopy() as? UNMutableNotificationContent)
        alteredFallback.subtitle = "Unsigned instruction beside the generic fallback"
        XCTAssertFalse(NativePushNotificationConsumer.isGenericFallback(alteredFallback), "Generic fallback must contain only its fixed text")
        XCTAssertFalse(consumer.allowsPresentation(alteredFallback), "Missing keys cannot authenticate an extra subtitle")
    }
    func testActualNSEExpiryBeforePreparationDeliversTheFallbackAndLateWorkCannotPublish() throws {
        let release = DispatchSemaphore(value: 0)
        let probe = DeliveryProbe(self)
        let service = NotificationService(effectFactory: { release.wait(); return self.effect() }, installCategory: probe.installed)
        let content = UNMutableNotificationContent()
        content.userInfo = try info("question-yn")
        service.didReceive(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil),
                           withContentHandler: probe.delivered)
        service.serviceExtensionTimeWillExpire()
        wait(for: [probe.activity, probe.completed], timeout: 3)
        release.signal()
        service.serviceExtensionTimeWillExpire()
        Thread.sleep(forTimeInterval: 0.3)
        let result = try XCTUnwrap(probe.snapshot().first)
        XCTAssertEqual(result.title, "Remi needs your attention"); XCTAssertEqual(result.categoryIdentifier, "")
        XCTAssertEqual(probe.snapshot().count, 1, "Late preparation cannot deliver a second notification")
    }
    // #1200 D2: apns-collapse-id makes the delivered notification's identifier the
    // collapse id, so whatever the extension returns REPLACES the live card.
    func testActualNSEExactDuplicateOfTheLiveCardRendersTheSameVerifiedContent() throws {
        let (service, probe) = try begin(); defer { service.serviceExtensionTimeWillExpire() }
        wait(for: [probe.completed], timeout: 3)
        let live = try XCTUnwrap(probe.snapshot().first)
        XCTAssertNotEqual(live.title, "")
        let (again, repeated) = try begin(); defer { again.serviceExtensionTimeWillExpire() }
        wait(for: [repeated.completed], timeout: 3)
        let duplicate = try XCTUnwrap(repeated.snapshot().first)
        XCTAssertEqual(duplicate.title, live.title, "A redelivered capsule must not blank the live card")
        XCTAssertEqual(duplicate.body, live.body)
        XCTAssertEqual(duplicate.categoryIdentifier, "")
        XCTAssertEqual(NSDictionary(dictionary: duplicate.userInfo), NSDictionary(dictionary: live.userInfo))
        XCTAssertNil(repeated.installedCategory())
    }
    /// An extension cannot drop a notification without the filtering entitlement,
    /// so a capsule that is no longer the latest live revision can only be shown as
    /// the generic alert: it opens the app, which holds the real state, and it
    /// grants nothing. It never renders the stale text and never touches the
    /// newer revision's lifecycle record.
    func testActualNSEStaleRevisionShowsOnlyTheGenericAlertAndLeavesTheNewerRevisionLive() throws {
        let first = try NativePushCodec.open(userInfo: info("question-yn"), state: state, keys: keys, now: clock)
        func capsule(revision: Int64, nonce: UInt8) throws -> [AnyHashable: Any] {
            ["remiPush": try reseal(vector("question-yn")) {
                $0[5] = Data(first.record.collapseId.utf8); $0[6] = self.be64(UInt64(revision)); $0[8] = Data(repeating: nonce, count: 32)
            }]
        }
        func deliver(_ userInfo: [AnyHashable: Any]) throws -> UNNotificationContent {
            let probe = DeliveryProbe(self)
            let service = NotificationService(effectFactory: { self.effect() }, installCategory: probe.installed)
            let content = UNMutableNotificationContent(); content.userInfo = userInfo
            service.didReceive(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil), withContentHandler: probe.delivered)
            wait(for: [probe.activity, probe.completed], timeout: 3)
            return try XCTUnwrap(probe.snapshot().first)
        }
        let newer = try deliver(capsule(revision: first.record.revision + 1, nonce: 0x51))
        XCTAssertNotEqual(newer.title, "Remi needs your attention", "The newer revision is verified and live")
        let stale = try deliver(capsule(revision: first.record.revision - 1, nonce: 0x52))
        XCTAssertTrue(NativePushNotificationConsumer.isGenericFallback(stale), "A stale revision cannot render its own text")
        let replay = try deliver(info("question-yn"))
        XCTAssertTrue(NativePushNotificationConsumer.isGenericFallback(replay), "A replay of a superseded capsule is stale too")
        let latest = try NativePushCodec.open(userInfo: capsule(revision: first.record.revision + 1, nonce: 0x51), state: state, keys: keys, now: clock)
        XCTAssertNoThrow(try state.reverifyLatestContent(latest.record, trust: latest.trust, now: clock),
                         "The refused stale deliveries leave the newer revision's lifecycle record intact")
    }

    // #1200 D3: no native owner answers a v2 action until R6, and iOS dismisses the
    // card after an action tap, so a Yes/No button would silently drop the choice.
    func testSecurePushOffersNoAnswerActionsAndOpensTheApp() throws {
        let (service, probe) = try begin(); defer { service.serviceExtensionTimeWillExpire() }
        XCTAssertNil(probe.installedCategory(), "A secure push must not register answer-labeled actions before R6")
        wait(for: [probe.completed], timeout: 3)
        let result = try XCTUnwrap(probe.snapshot().first)
        let opened = try NativePushCodec.open(userInfo: info("question-yn"), state: state, keys: keys, now: clock)
        guard case .question(let question) = opened.payload else { XCTFail("Shared fixture must be a real question"); return }
        XCTAssertEqual(result.title, question.title); XCTAssertEqual(result.body, question.body)
        XCTAssertEqual(result.categoryIdentifier, "", "The signed text opens the app; it carries no action buttons")
        XCTAssertEqual(Set(result.userInfo.keys.compactMap { $0 as? String }), ["remiPush"])
    }

    // MARK: Legacy plaintext pushes (no remiPush carrier), #1200 D1
    private func legacyInfo(dynamic: Bool = true) -> [AnyHashable: Any] {
        var info: [AnyHashable: Any] = ["sessionId": "s-1", "questionId": "q-123", "claudeSessionId": "c-1",
                                       "opt_0": "PostgreSQL", "opt_1": "MySQL", "opt_2": "No, thanks", "kind": "question"]
        if dynamic { info["dynCategory"] = "1" }
        return info
    }
    private func beginLegacy(_ info: [AnyHashable: Any], effects: @escaping () -> Void = {}) -> (NotificationService, DeliveryProbe) {
        let probe = DeliveryProbe(self)
        let service = NotificationService(effectFactory: { effects(); return self.effect() }, installCategory: probe.installed)
        let content = UNMutableNotificationContent()
        content.title = "Claude needs your input"; content.body = "Pick a database"
        content.categoryIdentifier = "REMI_MULTI"; content.userInfo = info
        service.didReceive(UNNotificationRequest(identifier: "q-123", content: content, trigger: nil),
                           withContentHandler: probe.delivered)
        wait(for: [probe.activity], timeout: 3)
        return (service, probe)
    }
    func testLegacyPushKeepsItsContentAndGetsItsDynamicCategory() throws {
        var factoryCalls = 0
        let (service, probe) = beginLegacy(legacyInfo(), effects: { factoryCalls += 1 })
        defer { service.serviceExtensionTimeWillExpire() }
        let category = try XCTUnwrap(probe.installedCategory(), "A single-question push with real labels must build its dynamic category")
        XCTAssertEqual(category.identifier, "REMI_DYN_q-123")
        XCTAssertEqual(category.actions.map(\.identifier), ["OPT_0", "OPT_1", "OPT_2"])
        XCTAssertEqual(category.actions.map(\.title), ["PostgreSQL", "MySQL", "No, thanks"])
        XCTAssertEqual(category.actions.map { $0.options.contains(.destructive) }, [false, false, true])
        XCTAssertTrue(probe.snapshot().isEmpty, "Nothing is delivered until the registration read-back")
        probe.release(true); wait(for: [probe.completed], timeout: 3)
        let result = try XCTUnwrap(probe.snapshot().first)
        XCTAssertEqual(result.title, "Claude needs your input"); XCTAssertEqual(result.body, "Pick a database")
        XCTAssertEqual(result.categoryIdentifier, "REMI_DYN_q-123")
        for (key, value) in legacyInfo() { XCTAssertEqual(result.userInfo[key] as? String, value as? String, "\(key) must reach RemiAnswerRelay") }
        XCTAssertEqual(factoryCalls, 0, "A legacy push never touches the secure push state or keys")
    }
    func testLegacyPushKeepsTheDaemonCategoryWhenRegistrationDoesNotLand() throws {
        let (service, probe) = beginLegacy(legacyInfo()); defer { service.serviceExtensionTimeWillExpire() }
        XCTAssertNotNil(probe.installedCategory())
        probe.release(false); wait(for: [probe.completed], timeout: 3)
        let result = try XCTUnwrap(probe.snapshot().first)
        XCTAssertEqual(result.categoryIdentifier, "REMI_MULTI", "The daemon's static category is the fallback, never an unresolved dynamic id")
        XCTAssertEqual(result.userInfo["questionId"] as? String, "q-123"); XCTAssertEqual(result.userInfo["opt_0"] as? String, "PostgreSQL")
    }
    func testLegacyPushWithoutDynamicOptionsPassesThroughUnchanged() throws {
        let (service, probe) = beginLegacy(legacyInfo(dynamic: false)); defer { service.serviceExtensionTimeWillExpire() }
        wait(for: [probe.completed], timeout: 3)
        let result = try XCTUnwrap(probe.snapshot().first)
        XCTAssertNil(probe.installedCategory())
        XCTAssertEqual(result.title, "Claude needs your input"); XCTAssertEqual(result.categoryIdentifier, "REMI_MULTI")
        XCTAssertEqual(result.userInfo["sessionId"] as? String, "s-1"); XCTAssertEqual(result.userInfo["claudeSessionId"] as? String, "c-1")
    }
    func testLegacyPushExpiryDeliversTheOriginalOnceAndIgnoresALateCategory() throws {
        let (service, probe) = beginLegacy(legacyInfo())
        XCTAssertNotNil(probe.installedCategory())
        service.serviceExtensionTimeWillExpire(); wait(for: [probe.completed], timeout: 3)
        probe.release(true); service.serviceExtensionTimeWillExpire()
        let result = try XCTUnwrap(probe.snapshot().first)
        XCTAssertEqual(probe.snapshot().count, 1, "The content handler is invoked exactly once")
        XCTAssertEqual(result.categoryIdentifier, "REMI_MULTI"); XCTAssertEqual(result.userInfo["questionId"] as? String, "q-123")
    }
}
