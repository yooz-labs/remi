import Foundation
import Testing
import UserNotifications
@testable import RemiPush

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
}
