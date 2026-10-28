import Foundation
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
        #expect(threads.resolve(machineID: "a", current: "", available: ["a-1", "a-2"], settled: true) == .fallback("a-1"))
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
        #expect(threads.resolve(machineID: "a", current: "gone", available: ["home"], settled: true) == .fallback("home"))
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

    @Test func aWantedThreadIsOpenAndAFallbackIsReportedAsOne() {
        var threads = RemiLastThreads()
        threads.remember(machineID: "a", sessionID: "a-2")
        #expect(threads.resolve(machineID: "a", current: "", available: ["a-1", "a-2"], settled: true) == .open("a-2"))
        #expect(threads.resolve(machineID: "a", current: "", available: ["a-1"], settled: true) == .fallback("a-1"))
        #expect(threads.resolve(machineID: "b", current: "", available: ["b-1"], settled: false) == .fallback("b-1"))
    }

    @Test func aMachineIsSettledOnlyAfterItHasBeenConnectedForTheGrace() {
        let start = Date(timeIntervalSince1970: 1_000)
        #expect(!RemiLastThreads.isSettled(connectedAt: nil, now: start))
        #expect(!RemiLastThreads.isSettled(connectedAt: start, now: start.addingTimeInterval(3.9)))
        #expect(RemiLastThreads.isSettled(connectedAt: start, now: start.addingTimeInterval(4)))
        #expect(RemiLastThreads.isSettled(connectedAt: start, now: start.addingTimeInterval(60)))
        #expect(RemiLastThreads.isSettled(connectedAt: start, now: start.addingTimeInterval(1), grace: 1))
    }

    @Test func pruningKeepsOnlyTheNamedMachines() {
        var threads = RemiLastThreads()
        threads.remember(machineID: "a", sessionID: "a-2")
        threads.remember(machineID: "b", sessionID: "b-3")
        threads.prune(keepingMachines: ["b"])
        var expected = RemiLastThreads()
        expected.remember(machineID: "b", sessionID: "b-3")
        #expect(threads == expected)
        threads.prune(keepingMachines: [])
        #expect(threads == RemiLastThreads())
    }

    @Test func onlyTheExactAutomaticSelectionIsSkipped() {
        let auto: (machineID: String, sessionID: String)? = (machineID: "a", sessionID: "a-1")
        #expect(!RemiLastThreads.shouldRecord(machineID: "a", sessionID: "a-1", autoSelected: auto))
        #expect(RemiLastThreads.shouldRecord(machineID: "a", sessionID: "a-2", autoSelected: auto))
        #expect(RemiLastThreads.shouldRecord(machineID: "b", sessionID: "a-1", autoSelected: auto))
        #expect(RemiLastThreads.shouldRecord(machineID: "a", sessionID: "a-1", autoSelected: nil))
    }
}
