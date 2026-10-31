import CryptoKit
import Foundation
import Testing
import UserNotifications
@testable import RemiKit
@testable import RemiPush

private final class CapturedRemovals: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String] = []
    func append(_ identifiers: [String]) { lock.lock(); defer { lock.unlock() }; values += identifiers }
    func snapshot() -> [String] { lock.lock(); defer { lock.unlock() }; return values }
}

@Suite struct DeliveredNotificationSafetyTests {
    @Test func ordinaryDeliveredNotificationDoesNotCrash() {
        let card = NativePushNotificationConsumer.DeliveredCard(identifier: "ordinary", userInfo: [:])
        #expect(card.identifier == "ordinary")
        #expect(card.carrier == nil)
    }

    @Test func malformedDeliveredCarriersAreIgnored() {
        let cases: [Any] = ["text", NSNull(), 1, ["nested": Date()], ["nested": Data([1])]]
        for value in cases {
            let card = NativePushNotificationConsumer.DeliveredCard(identifier: "bad", userInfo: ["remiPush": value])
            #expect(card.carrier == nil)
        }
    }

    @Test func validSignedCarrierStillOpensAfterCapture() throws {
        let oracle = try NativePushOracle.load("push-vectors.json")
        let vector = try #require((oracle["cases"] as? [[String: Any]])?.first(where: { $0["name"] as? String == "question" }))
        let original = try OwnedPushContext.carrier(vector)
        let object = try JSONSerialization.jsonObject(with: original)
        let card = NativePushNotificationConsumer.DeliveredCard(identifier: "secure", userInfo: ["remiPush": object])
        let captured = try #require(card.carrier)
        #expect(try NativePushCodec.parseCarrier(captured) == NativePushCodec.parseCarrier(original))
        let context = try OwnedPushContext(vector: vector, oracle: oracle)
        defer { try? context.cleanup() }
        #expect(try context.store.open(carrier: captured, now: 1_700_000_001).kind == .question)
        let forged = try OwnedPushContext.resealed(vector, oracle: oracle,
            payload: RelayOracle.hex(#require(vector["payloadHex"] as? String)), corruptSignature: true)
        let forgedObject = try JSONSerialization.jsonObject(with: forged)
        let forgedCard = NativePushNotificationConsumer.DeliveredCard(identifier: "forged", userInfo: ["remiPush": forgedObject])
        let forgedCapture = try #require(forgedCard.carrier)
        #expect(throws: (any Error).self) { try context.store.open(carrier: forgedCapture, now: 1_700_000_001) }
    }

    @Test func invalidDismissInputIsUnavailableWithoutReadingOrRemovingNotifications() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-invalid-dismiss-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let state = try NativePushState(file: directory.appendingPathComponent("state.sqlite"))
        let keys = NativePushKeyStore(service: "remi.invalid-test.\(UUID().uuidString)", account: "test", accessGroup: nil)
        let consumer = NativePushNotificationConsumer(state: state, keys: keys,
            readDelivered: { _ in Issue.record("Invalid input must not read delivered notifications") },
            removeDelivered: { _ in Issue.record("Invalid input must not remove notifications") })
        let inputs: [[AnyHashable: Any]] = [[:], ["remiPush": "text"], ["remiPush": NSNull()],
                                           ["remiPush": ["nested": Date()]], ["remiPush": ["v": 2]]]
        for input in inputs {
            let unavailable = await withCheckedContinuation { continuation in
                consumer.receiveDismiss(userInfo: input) { outcome in
                    continuation.resume(returning: outcome == .unavailable)
                }
            }
            #expect(unavailable)
        }
    }

    @Test func malformedExtensionCarrierReturnsGenericFallback() async {
        let content = UNMutableNotificationContent()
        content.userInfo = ["remiPush": "text"]
        let request = UNNotificationRequest(identifier: "synthetic", content: content, trigger: nil)
        let service = RemiPushServiceExtension()
        let title = await withCheckedContinuation { continuation in
            service.didReceive(request) { result in continuation.resume(returning: result.title) }
        }
        #expect(title == "Remi needs your attention")
    }

    @Test func mixedDeliveredScanRemovesOnlyMatchingAuthenticCard() async throws {
        let oracle = try NativePushOracle.load("push-vectors.json")
        let cases = try #require(oracle["cases"] as? [[String: Any]])
        let question = try #require(cases.first(where: { $0["name"] as? String == "question" }))
        let dismiss = try #require(cases.first(where: { $0["name"] as? String == "dismiss" }))
        let dismissContent = try #require(dismiss["content"] as? [String: Any])
        let collapseID = try #require(dismissContent["collapseId"] as? String)
        let context = try OwnedPushContext(vector: question, oracle: oracle)
        defer { try? context.cleanup() }
        let state = try NativePushState(file: context.directory.appendingPathComponent("public.sqlite"))
        let keys = NativePushKeyStore(service: context.service, account: context.account, accessGroup: nil)
        func info(_ data: Data) throws -> [AnyHashable: Any] {
            ["remiPush": try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])]
        }
        let matching = try resealQuestion(question, oracle: oracle, collapseID: collapseID, forged: false)
        let forged = try resealQuestion(question, oracle: oracle, collapseID: collapseID, forged: true)
        let other = try OwnedPushContext.carrier(question)
        let cards = [
            NativePushNotificationConsumer.DeliveredCard(identifier: "ordinary", userInfo: [:]),
            NativePushNotificationConsumer.DeliveredCard(identifier: "malformed", userInfo: ["remiPush": "bad"]),
            NativePushNotificationConsumer.DeliveredCard(identifier: "matching", userInfo: try info(matching)),
            NativePushNotificationConsumer.DeliveredCard(identifier: "forged", userInfo: try info(forged)),
            NativePushNotificationConsumer.DeliveredCard(identifier: "other", userInfo: try info(other)),
        ]
        let removals = CapturedRemovals()
        let consumer = NativePushNotificationConsumer(state: state, keys: keys, now: { 1_700_000_001 },
            readDelivered: { callback in callback(cards) }, removeDelivered: { removals.append($0) })
        let dismissInfo = try info(OwnedPushContext.carrier(dismiss))
        let removedOne = await withCheckedContinuation { continuation in
            consumer.receiveDismiss(userInfo: dismissInfo) { outcome in
                continuation.resume(returning: outcome == .removed(1))
            }
        }
        #expect(removedOne)
        #expect(removals.snapshot() == ["matching"])
    }

    /// Reseal the reviewed synthetic question with the dismiss fixture's collapse ID.
    /// All remaining identity, key, payload and revision fields come from the fixture.
    private func resealQuestion(_ vector: [String: Any], oracle: [String: Any], collapseID: String,
                                forged: Bool) throws -> Data {
        func parts(_ bytes: Data) throws -> [Data] {
            var offset = 0, values: [Data] = []
            while offset < bytes.count {
                try #require(offset + 2 <= bytes.count)
                let count = Int(bytes[offset]) << 8 | Int(bytes[offset + 1]); offset += 2
                try #require(offset + count <= bytes.count)
                values.append(bytes.subdata(in: offset..<(offset + count))); offset += count
            }
            return values
        }
        let inner = try parts(RelayOracle.hex(#require(vector["innerHex"] as? String)))
        var fields = try parts(#require(inner.first)); try #require(fields.count == 12)
        fields[5] = Data(collapseID.utf8)
        let body = try RelayCrypto.tuple(fields)
        let machine = try Curve25519.Signing.PrivateKey(rawRepresentation: RelayOracle.hex(#require(oracle["machineSeedHex"] as? String)))
        var signature = try machine.signature(for: RelayCrypto.tuple(Data("remi-relay-v2 push content".utf8), Data(SHA256.hash(data: body))))
        if forged { signature[0] ^= 1 }
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let shared = try ephemeral.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: fields[3]))
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: ephemeral.publicKey.x963Representation,
            sharedInfo: try RelayCrypto.tuple(Data("remi-relay-v2 seal".utf8), fields[3]), outputByteCount: 32)
        let box = try AES.GCM.seal(RelayCrypto.tuple(body, signature), using: key, authenticating: fields[1] + fields[5])
        let sealed = ephemeral.publicKey.x963Representation + box.nonce.withUnsafeBytes { Data($0) } + box.ciphertext + box.tag
        let content = try #require(vector["content"] as? [String: Any])
        return try JSONSerialization.data(withJSONObject: ["v": 2, "rid": #require(content["rid"]),
            "collapseId": collapseID, "sealed": RelayCrypto.b64(sealed)])
    }
}
