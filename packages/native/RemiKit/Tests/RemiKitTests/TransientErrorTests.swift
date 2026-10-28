import Foundation
import Testing
@testable import RemiKit
@testable import RemiUI

@Suite struct TransientErrorTests {
    @MainActor private func makeStore() -> MachineStore {
        MachineStore(
            endpoints: [MachineEndpoint(host: "127.0.0.1", port: 18765)],
            identity: ClientIdentity(), clientVersion: "test", clientId: "test-client")
    }

    /// Hosted integration fixtures can occupy the main actor for over six seconds. Allow a
    /// bounded scheduling margin while still requiring the real expiry task to clear the error.
    @MainActor private func waitUntil(timeout: Duration = .seconds(15), _ condition: () -> Bool) async {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while !condition(), ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    @Test @MainActor func aTransientErrorShowsThenClearsItself() async {
        let store = makeStore()
        store.setTransientOperationError("Message not sent.", for: .milliseconds(60))
        #expect(store.latestOperationError == "Message not sent.")
        await waitUntil { store.latestOperationError == nil }
        #expect(store.latestOperationError == nil)
    }

    @Test @MainActor func aNewerErrorIsNotClearedByAnOlderTimerButIsClearedByItsOwn() async {
        let store = makeStore()
        store.setTransientOperationError("first", for: .milliseconds(50))
        store.setTransientOperationError("second", for: .milliseconds(1500))
        // Well past the first timer: the second is still showing.
        try? await Task.sleep(for: .milliseconds(300))
        #expect(store.latestOperationError == "second")
        // And its own timer does clear it.
        await waitUntil { store.latestOperationError == nil }
        #expect(store.latestOperationError == nil)
    }

    @Test @MainActor func theSameMessageAgainRestartsTheWait() async {
        let store = makeStore()
        store.setTransientOperationError("Message not sent.", for: .milliseconds(50))
        store.setTransientOperationError("Message not sent.", for: .milliseconds(1500))
        try? await Task.sleep(for: .milliseconds(300))
        // A second failure must not be wiped by the first failure's timer...
        #expect(store.latestOperationError == "Message not sent.")
        // ...and still clears when its own wait is over.
        await waitUntil { store.latestOperationError == nil }
        #expect(store.latestOperationError == nil)
    }

    @Test @MainActor func aClearInTheMeantimeIsRespected() async {
        let store = makeStore()
        store.setTransientOperationError("Message not sent.", for: .milliseconds(60))
        store.clearLatestError()
        #expect(store.latestOperationError == nil)
        try? await Task.sleep(for: .milliseconds(150))
        #expect(store.latestOperationError == nil)
    }

    @Test @MainActor func bothNoticesClearWithinTenToFifteenSeconds() {
        for duration in [MachineStore.transientErrorDuration, RemiSessionInteractionBar.failureNoticeDuration] {
            #expect(duration >= .seconds(10))
            #expect(duration <= .seconds(15))
        }
    }

    @Test @MainActor func theComposerNoticeSaysTheDraftIsKept() {
        #expect(RemiSessionInteractionBar.failureMessage.contains("draft is still here"))
    }

    @Test func enablingAssistiveTechnologyChangesTheTaskAndPreventsDismissal() {
        typealias TaskID = RemiSessionInteractionBar.FailureNoticeTaskID
        let waiting = TaskID(failureCount: 1, voiceOverEnabled: false, switchControlEnabled: false)
        #expect(waiting.permitsDismissal)
        for accessible in [
            TaskID(failureCount: 1, voiceOverEnabled: true, switchControlEnabled: false),
            TaskID(failureCount: 1, voiceOverEnabled: false, switchControlEnabled: true)
        ] {
            #expect(accessible != waiting)
            #expect(!accessible.permitsDismissal)
        }
    }
}
