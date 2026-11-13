import Testing
@testable import RemiUI

@Suite struct RemiDrawerEmptyStateTests {
    @Test func rowsMeanContentWhateverNarrowsTheList() {
        #expect(RemiDrawerEmptyState.resolve(visibleSessionCount: 2, query: "x", isMachineFiltered: true) == .content)
        #expect(RemiDrawerEmptyState.resolve(visibleSessionCount: 1, query: "", isMachineFiltered: false) == .content)
    }

    @Test func nothingNarrowingAndNoSessionsIsNothing() {
        #expect(RemiDrawerEmptyState.resolve(visibleSessionCount: 0, query: "", isMachineFiltered: false) == .nothing)
        #expect(RemiDrawerEmptyState.resolve(visibleSessionCount: 0, query: "  ", isMachineFiltered: false) == .nothing)
    }

    @Test func aFilteredMachineWithNoSessionsAndNoQueryIsMachineEmpty() {
        #expect(RemiDrawerEmptyState.resolve(visibleSessionCount: 0, query: "", isMachineFiltered: true) == .machineEmpty)
        #expect(RemiDrawerEmptyState.resolve(visibleSessionCount: 0, query: " \n", isMachineFiltered: true) == .machineEmpty)
    }

    @Test func aQueryThatMatchesNothingIsNoMatchWithOrWithoutAMachine() {
        #expect(RemiDrawerEmptyState.resolve(visibleSessionCount: 0, query: "zzz", isMachineFiltered: false) == .noMatch)
        #expect(RemiDrawerEmptyState.resolve(visibleSessionCount: 0, query: "zzz", isMachineFiltered: true) == .noMatch)
    }
}
