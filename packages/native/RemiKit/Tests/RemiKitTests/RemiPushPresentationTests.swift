import Testing
import UserNotifications
@testable import RemiPush

@Suite struct RemiPushPresentationTests {
    @Test func aQuestionBreaksThroughFocusAndOutranksNotices() {
        let content = UNMutableNotificationContent()
        RemiPushPresentation.apply(.question, sessionID: "s1", to: content)
        #expect(content.interruptionLevel == .timeSensitive)
        #expect(content.relevanceScore == 1)
        #expect(content.sound == .default)
        #expect(content.threadIdentifier == "remi.session.s1")
    }

    @Test func aNoticeDoesNotBreakThrough() {
        let content = UNMutableNotificationContent()
        RemiPushPresentation.apply(.information, sessionID: "s1", to: content)
        #expect(content.interruptionLevel == .active)
        #expect(content.relevanceScore == 0.5)
    }

    @Test func soundsOffLeavesTheSoundUnset() {
        let content = UNMutableNotificationContent()
        RemiPushPresentation.apply(.question, sessionID: nil, sound: false, to: content)
        #expect(content.sound == nil)
        // Still time sensitive: the person chose silence, not to miss it.
        #expect(content.interruptionLevel == .timeSensitive)
    }

    @Test func aSessionIsAGroupAndNoSessionIsNot() {
        #expect(RemiPushPresentation.threadIdentifier(sessionID: "abc") == "remi.session.abc")
        #expect(RemiPushPresentation.threadIdentifier(sessionID: nil) == nil)
        #expect(RemiPushPresentation.threadIdentifier(sessionID: "") == nil)

        let content = UNMutableNotificationContent()
        RemiPushPresentation.apply(.information, sessionID: nil, to: content)
        #expect(content.threadIdentifier.isEmpty)
    }

    @Test func aLongSessionIdMakesABoundedGroupKey() throws {
        let key = try #require(RemiPushPresentation.threadIdentifier(sessionID: String(repeating: "x", count: 5000)))
        #expect(key.count == "remi.session.".count + RemiPushPresentation.maximumSessionComponentLength)
    }
}
