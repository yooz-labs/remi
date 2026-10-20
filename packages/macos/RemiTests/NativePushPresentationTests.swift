import UserNotifications
import XCTest

final class NativePushPresentationTests: XCTestCase {
    func testUnsignedOuterCategoryCannotGrantNotificationActions() {
        // Construct the shipping extension. This request is never delivered to
        // the OS. Its remiPush carrier is unverifiable, so it is a secure push
        // and gets the generic fallback; a push with NO carrier is the legacy
        // plaintext path and passes through (NativePushPublicationTests, #1200).
        let content = UNMutableNotificationContent()
        content.title = "Unverified outer title"
        content.body = "Unverified outer body"
        content.categoryIdentifier = "REMI_YN"
        content.userInfo = ["remiPush": ["v": 2], "sessionId": UUID().uuidString, "questionId": UUID().uuidString,
                            "opt_0": "Yes", "opt_1": "No"]
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        let service = NotificationService()
        var delivered: UNNotificationContent?
        var deliveries = 0
        service.didReceive(request) { result in
            delivered = result
            deliveries += 1
        }
        service.serviceExtensionTimeWillExpire()
        service.serviceExtensionTimeWillExpire()
        XCTAssertEqual(delivered?.title, "Remi needs your attention")
        XCTAssertEqual(delivered?.body, "Open Remi to view this notification.")
        XCTAssertNil(delivered?.userInfo["sessionId"])
        XCTAssertNil(delivered?.userInfo["questionId"])
        XCTAssertNil(delivered?.userInfo["opt_0"])
        XCTAssertEqual(deliveries, 1, "The actual extension must complete exactly once")
        XCTAssertEqual(delivered?.categoryIdentifier, "",
                       "Unsigned outer category must never grant notification actions")
    }
}
