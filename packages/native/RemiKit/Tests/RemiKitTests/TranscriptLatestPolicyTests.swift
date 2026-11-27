import CoreGraphics
import Testing
@testable import RemiUI

@Suite struct TranscriptLatestPolicyTests {
    @Test func composerRolesAndLabels() {
        for atLatest in [true, false] {
            let send = RemiComposerAction.resolve(draft: " hello ", keyboardUp: true, atLatest: atLatest)
            #expect(send.role == .send)
            #expect(send.label == "Send message")
            #expect(send.isEnabled)
            let keyboard = RemiComposerAction.resolve(draft: " \n", keyboardUp: true, atLatest: atLatest)
            #expect(keyboard.role == .hideKeyboard)
            #expect(keyboard.label == "Hide keyboard")
            #expect(keyboard.isEnabled)
            let latest = RemiComposerAction.resolve(draft: "", keyboardUp: false, atLatest: atLatest)
            #expect(latest.role == .jumpToLatest)
            #expect(latest.label == "Jump to latest")
            #expect(latest.isEnabled == !atLatest)
        }
    }

    @Test func followUntilPersonScrollsUp() {
        var follows = true
        #expect(RemiTranscriptFollowPolicy.shouldFollow(followsLatest: follows, isReviewing: false))
        follows = RemiTranscriptFollowPolicy.afterUserScroll(followsLatest: follows, previousOffset: 200, offset: 190, remaining: 10)
        #expect(!RemiTranscriptFollowPolicy.shouldFollow(followsLatest: follows, isReviewing: false))
        follows = RemiTranscriptFollowPolicy.afterUserScroll(followsLatest: follows, previousOffset: 190, offset: 200, remaining: 0)
        #expect(RemiTranscriptFollowPolicy.shouldFollow(followsLatest: follows, isReviewing: false))
    }

    @Test func springBackAtTailKeepsFollowing() {
        #expect(RemiTranscriptFollowPolicy.afterUserScroll(followsLatest: true, previousOffset: 205, offset: 200, remaining: 1))
    }

    @Test func noninteractiveScrollUpStopsFollowingOnlyWithoutReflow() {
        func result(_ followingLayout: Bool, _ sizesChanged: Bool, _ offset: CGFloat, _ remaining: CGFloat) -> Bool {
            RemiTranscriptFollowPolicy.afterNoninteractiveScroll(followsLatest: true, followingLayout: followingLayout,
                sizesChanged: sizesChanged, previousOffset: 200, offset: offset, remaining: remaining)
        }
        #expect(!result(false, false, 190, 10))
        #expect(result(true, false, 190, 10))
        #expect(result(false, true, 190, 10))
        #expect(result(false, false, 190, 1))
        #expect(result(false, false, 210, 10))
    }

    @Test func scrollPositionIsReleasedAndClearedOnlyWhenFollowing() {
        #expect(RemiScrollPositionPolicy.effectiveBinding(followsLatest: true, following: "tail", review: "saved") == "tail")
        #expect(RemiScrollPositionPolicy.effectiveBinding(followsLatest: false, following: "tail", review: "saved") == "saved")
        #expect(RemiScrollPositionPolicy.positionAfterFollowChange(followsLatest: true, visibleEntryID: "saved") == nil)
        #expect(RemiScrollPositionPolicy.positionAfterFollowChange(followsLatest: false, visibleEntryID: "saved") == "saved")
    }

    @Test func doNotOverwriteReviewBeforePositionArrives() {
        #expect(!RemiScrollPositionPolicy.shouldSaveReview(followsLatest: false, visibleEntryID: nil))
        #expect(RemiScrollPositionPolicy.shouldSaveReview(followsLatest: false, visibleEntryID: "row"))
        #expect(RemiScrollPositionPolicy.shouldSaveReview(followsLatest: true, visibleEntryID: nil))
    }

    @Test func followThresholdAndComposerAvailability() {
        #expect(!RemiTranscriptFollowPolicy.afterUserScroll(followsLatest: false, previousOffset: 100, offset: 120, remaining: 50))
        #expect(RemiTranscriptFollowPolicy.afterUserScroll(followsLatest: false, previousOffset: 120, offset: 150, remaining: 1))
        #expect(!RemiTranscriptFollowPolicy.isAtLatest(remaining: 1.01))
        #expect(RemiTranscriptFollowPolicy.isAtLatest(remaining: 1))
        let mac = RemiComposerAction.resolve(draft: "", keyboardUp: false, atLatest: false)
        #expect(mac.role == .jumpToLatest && mac.isEnabled)
        let prompt = RemiComposerAction.resolve(draft: "text", keyboardUp: false, atLatest: false, promptWaiting: true)
        #expect(prompt.role == .interrupt && prompt.label == "Interrupt agent" && prompt.isEnabled)
        #expect(!RemiComposerAction.resolve(draft: "text", keyboardUp: false, atLatest: false, isSending: true).isEnabled)
        #expect(!RemiComposerAction.resolve(draft: "", keyboardUp: false, atLatest: false, hasJumpHandler: false).isEnabled)
    }

    @Test func savedPositionAndReviewWinOverInitialFollow() {
        #expect(!RemiTranscriptFollowPolicy.shouldFollow(followsLatest: false, isReviewing: false))
        #expect(RemiTranscriptFollowPolicy.shouldFollow(followsLatest: true, isReviewing: false))
        #expect(!RemiTranscriptFollowPolicy.shouldFollow(followsLatest: true, isReviewing: true))
    }
}
