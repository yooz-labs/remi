import UserNotifications
import XCTest

final class NativePushPresentationTests: XCTestCase {
    func testUnsignedOuterCategoryCannotGrantNotificationActions() {
        // Construct the shipping extension. This request is never delivered to
        // the OS, and lacks dynCategory so no global categories are registered.
        let content = UNMutableNotificationContent()
        content.title = "Unverified outer title"
        content.body = "Unverified outer body"
        content.categoryIdentifier = "REMI_YN"
        content.userInfo = ["sessionId": UUID().uuidString, "questionId": UUID().uuidString,
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
        XCTAssertEqual(deliveries, 1, "The actual extension must complete exactly once")
        XCTAssertEqual(delivered?.categoryIdentifier, "",
                       "Unsigned outer category must never grant notification actions")
    }
}
