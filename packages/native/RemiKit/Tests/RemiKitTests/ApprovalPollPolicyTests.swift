import Testing
@testable import RemiKit

struct ApprovalPollPolicyTests {
    @Test func pollsEveryFewSecondsForABoundedWindow() {
        let policy = ApprovalPollPolicy.standard
        #expect(policy.interval == .seconds(5))
        #expect(policy.window == .seconds(180))
    }

    @Test func continuesInsideTheWindowAndStopsAtItsEnd() {
        let policy = ApprovalPollPolicy.standard
        #expect(policy.shouldContinue(elapsed: .zero))
        #expect(policy.shouldContinue(elapsed: .seconds(179)))
        #expect(!policy.shouldContinue(elapsed: .seconds(180)))
        #expect(!policy.shouldContinue(elapsed: .seconds(600)))
    }
}
