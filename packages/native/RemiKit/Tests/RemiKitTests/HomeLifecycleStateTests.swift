import Testing
@testable import RemiUI

@Suite struct HomeLifecycleStateTests {
    @Test func noMachinesAlwaysUsesFirstRunOnboarding() {
        #expect(RemiHomeLifecycleState.resolve(
            machineCount: 0,
            visibleSessionCount: 0,
            query: "ignored search",
            hasSelectedMachine: false
        ) == .firstRun)
    }

    @Test func existingContentWinsOverEmptyStateCopy() {
        #expect(RemiHomeLifecycleState.resolve(
            machineCount: 2,
            visibleSessionCount: 1,
            query: "",
            hasSelectedMachine: true
        ) == .content)
    }

    @Test func emptyStatesDistinguishSearchAndScope() {
        #expect(RemiHomeLifecycleState.resolve(
            machineCount: 1,
            visibleSessionCount: 0,
            query: "  api ",
            hasSelectedMachine: false
        ) == .noSearchResults)
        #expect(RemiHomeLifecycleState.resolve(
            machineCount: 1,
            visibleSessionCount: 0,
            query: "",
            hasSelectedMachine: false
        ) == .noSessionsAllMachines)
        #expect(RemiHomeLifecycleState.resolve(
            machineCount: 1,
            visibleSessionCount: 0,
            query: "",
            hasSelectedMachine: true
        ) == .noSessionsForMachine)
    }
}
