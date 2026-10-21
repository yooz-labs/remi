import Foundation
import Testing
@testable import RemiKit

struct MachineRecoveryBudgetTests {
    @Test func burstDebouncesAndPathEpochDoesNotBypassCooldown() {
        var schedule = MachineRecoverySchedule()
        let now = ContinuousClock.now
        schedule.request(at: now, newEpisode: true)
        let result1 = !schedule.begin(at: now.advanced(by: .milliseconds(749)))
        #expect(result1)
        schedule.request(at: now.advanced(by: .milliseconds(500)), newEpisode: false)
        let result2 = !schedule.begin(at: now.advanced(by: .seconds(1)))
        #expect(result2)
        let first = now.advanced(by: .milliseconds(1250))
        let result3 = schedule.begin(at: first)
        #expect(result3)
        #expect(schedule.deadline == first.advanced(by: .seconds(180)))
        schedule.cancel()
        schedule.request(at: first.advanced(by: .seconds(1)), newEpisode: true)
        #expect(schedule.due == first.advanced(by: .seconds(30)))
        let result4 = !schedule.begin(at: first.advanced(by: .seconds(29)))
        #expect(result4)
    }

    @Test func episodeHasThreeSweepsWithBoundedRetryThenNeedsNewTrigger() {
        var schedule = MachineRecoverySchedule()
        let now = ContinuousClock.now
        schedule.request(at: now, newEpisode: true)
        let first = now.advanced(by: .milliseconds(750))
        let result5 = schedule.begin(at: first)
        #expect(result5)
        schedule.finish(at: first.advanced(by: .seconds(8)), retry: true)
        // The 15-second first retry also respects the 30-second cooldown.
        #expect(schedule.due == first.advanced(by: .seconds(30)))
        let second = first.advanced(by: .seconds(30))
        let result6 = schedule.begin(at: second)
        #expect(result6)
        schedule.finish(at: second.advanced(by: .seconds(8)), retry: true)
        #expect(schedule.due == second.advanced(by: .seconds(68)))
        let third = second.advanced(by: .seconds(68))
        let result7 = schedule.begin(at: third)
        #expect(result7)
        schedule.finish(at: third.advanced(by: .seconds(8)), retry: true)
        #expect(schedule.exhausted && schedule.due == nil)
        schedule.request(at: third.advanced(by: .seconds(60)), newEpisode: false)
        #expect(schedule.due == nil)
        schedule.request(at: third.advanced(by: .seconds(60)), newEpisode: true)
        #expect(schedule.due != nil && schedule.sweeps == 0)
    }

    @Test func probeLeasesBoundProfilesConcurrencyAndTotalStarts() throws {
        var budget = MachineRecoveryProbeBudget()
        let reserved8 = budget.reserve(profileID: "one")
        let first = try #require(reserved8)
        let result9 = budget.reserve(profileID: "one") == nil
        #expect(result9)
        let reserved10 = budget.reserve(profileID: "two")
        let second = try #require(reserved10)
        let result11 = budget.reserve(profileID: "three") == nil
        #expect(result11)
        budget.retire(first)
        for _ in 0..<6 {
            let reserved12 = budget.reserve(profileID: "one")
            let lease = try #require(reserved12)
            budget.retire(lease)
        }
        #expect(budget.starts == 8 && budget.exhausted)
        budget.retire(second)
        #expect(budget.activeCount == 0)
        let result13 = budget.reserve(profileID: "one") == nil
        #expect(result13)
    }
}
