import Testing
@testable import RemiUI

@Suite struct RemiLastThreadsTests {
    @Test func aMachineOpensItsOwnLastThread() {
        var threads = RemiLastThreads()
        threads.remember(machineID: "a", sessionID: "a-2")
        threads.remember(machineID: "b", sessionID: "b-3")
        #expect(threads.resolve(machineID: "a", current: "", available: ["a-1", "a-2"], settled: true) == .open("a-2"))
        #expect(threads.resolve(machineID: "b", current: "", available: ["b-1", "b-3"], settled: true) == .open("b-3"))
    }

    @Test func aMachineWithNoHistoryOpensItsFirstThread() {
        let threads = RemiLastThreads()
        #expect(threads.resolve(machineID: "a", current: "", available: ["a-1", "a-2"], settled: true) == .open("a-1"))
    }

    @Test func aThreadNotListedYetIsWaitedForNotReplaced() {
        // A hub lists its own sessions first and the per-session daemons a moment later.
        var threads = RemiLastThreads()
        threads.remember(machineID: "a", sessionID: "a-2")
        #expect(threads.resolve(machineID: "a", current: "a-2", available: ["home"], settled: false) == .wait)
        #expect(threads.resolve(machineID: "a", current: "", available: ["home"], settled: false) == .wait)
    }

    @Test func aThreadThatNeverAppearsFallsBackOnceTheListIsSettled() {
        var threads = RemiLastThreads()
        threads.remember(machineID: "a", sessionID: "gone")
        #expect(threads.resolve(machineID: "a", current: "gone", available: ["home"], settled: true) == .open("home"))
        #expect(threads.resolve(machineID: "a", current: "gone", available: [], settled: true) == .clear)
    }

    @Test func aListedCurrentThreadIsKept() {
        let threads = RemiLastThreads()
        #expect(threads.resolve(machineID: "a", current: "a-2", available: ["a-1", "a-2"], settled: false) == .open("a-2"))
    }

    @Test func storageRoundTripsAndToleratesGarbage() {
        var threads = RemiLastThreads()
        threads.remember(machineID: "a", sessionID: "a-2")
        #expect(RemiLastThreads(storage: threads.storageValue) == threads)
        #expect(RemiLastThreads(storage: "not json") == RemiLastThreads())
        #expect(RemiLastThreads(storage: "") == RemiLastThreads())
    }

    @Test func emptyIdentifiersAreNotRemembered() {
        var threads = RemiLastThreads()
        threads.remember(machineID: "", sessionID: "x")
        threads.remember(machineID: "a", sessionID: "")
        #expect(threads == RemiLastThreads())
    }
}
