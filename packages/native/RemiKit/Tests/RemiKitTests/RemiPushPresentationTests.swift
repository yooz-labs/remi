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
        #expect(key.utf8.count == "remi.session.".utf8.count + RemiPushPresentation.maximumSessionComponentBytes)
    }

    @Test func theBoundIsInBytesNotCharacters() throws {
        // Each is one character but several bytes: 200 of them is far past the bound as characters.
        let key = try #require(RemiPushPresentation.threadIdentifier(sessionID: String(repeating: "e\u{301}", count: 200)))
        #expect(key.utf8.count <= "remi.session.".utf8.count + RemiPushPresentation.maximumSessionComponentBytes + 4)
    }

    @Test func eachVerifiedKindMapsToItsImportanceAndADismissalToNone() {
        #expect(RemiPushPresentation.importance(for: .question) == .question)
        #expect(RemiPushPresentation.importance(for: .information) == .information)
        #expect(RemiPushPresentation.importance(for: .dismiss) == nil)
    }

    @Test func soundsAreOnUnlessThePersonTurnedThemOff() throws {
        let suite = "live.yooz.remi.tests.presentation.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        #expect(RemiPushPresentation.soundsEnabled(in: defaults))
        #expect(RemiPushPresentation.soundsEnabled(in: nil))

        RemiPushPresentation.shareSoundsPreference(false, with: defaults)
        #expect(!RemiPushPresentation.soundsEnabled(in: defaults))
        RemiPushPresentation.shareSoundsPreference(true, with: defaults)
        #expect(RemiPushPresentation.soundsEnabled(in: defaults))
    }

    @Test func theFallbackIsAudibleButNotTimeSensitive() {
        let fallback = UNMutableNotificationContent()
        RemiPushPresentation.apply(.information, sessionID: nil, to: fallback)
        #expect(fallback.sound == .default)
        #expect(fallback.interruptionLevel == .active)
    }
}
