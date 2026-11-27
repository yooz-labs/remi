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

    @Test func savedPositionAndReviewWinOverInitialFollow() {
        #expect(!RemiTranscriptFollowPolicy.shouldFollow(followsLatest: false, isReviewing: false))
        #expect(RemiTranscriptFollowPolicy.shouldFollow(followsLatest: true, isReviewing: false))
        #expect(!RemiTranscriptFollowPolicy.shouldFollow(followsLatest: true, isReviewing: true))
    }
}
