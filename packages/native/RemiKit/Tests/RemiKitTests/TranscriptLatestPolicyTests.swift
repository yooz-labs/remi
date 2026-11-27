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

    @Test func loadAndLateStreamFollowUntilPersonScrollsUp() {
        var policy = RemiTranscriptFollowPolicy(restoredPosition: false)
        #expect(policy.shouldFollow(isReviewing: false))
        #expect(policy.shouldFollow(isReviewing: false)) // late transcript or stream
        policy.userScrolled(previousOffset: 200, offset: 190, remaining: 10)
        #expect(!policy.shouldFollow(isReviewing: false))
        #expect(!policy.shouldFollow(isReviewing: false)) // subsequent stream
        policy.userScrolled(previousOffset: 190, offset: 200, remaining: 0)
        #expect(policy.shouldFollow(isReviewing: false))
    }

    @Test func springBackAtTailKeepsFollowing() {
        var policy = RemiTranscriptFollowPolicy(restoredPosition: false)
        policy.userScrolled(previousOffset: 205, offset: 200, remaining: 1)
        #expect(policy.shouldFollow(isReviewing: false))
    }

    @Test func savedPositionAndReviewWinOverInitialFollow() {
        var policy = RemiTranscriptFollowPolicy(restoredPosition: true)
        #expect(!policy.shouldFollow(isReviewing: false))
        policy.jumpToLatest()
        #expect(policy.shouldFollow(isReviewing: false))
        #expect(!policy.shouldFollow(isReviewing: true))
    }
}
