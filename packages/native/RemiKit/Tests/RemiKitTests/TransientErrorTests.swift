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

    /// Waits until `condition` holds, up to two seconds, so the tests do not depend on one fixed
    /// sleep being long enough on a busy machine.
    @MainActor private func waitUntil(_ condition: () -> Bool) async {
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
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

    @Test @MainActor func aNewerErrorIsNotClearedByAnOlderTimer() async {
        let store = makeStore()
        store.setTransientOperationError("first", for: .milliseconds(60))
        store.setTransientOperationError("second", for: .seconds(30))
        // Past the first timer: the second is still showing.
        try? await Task.sleep(for: .milliseconds(250))
        #expect(store.latestOperationError == "second")
    }

    @Test @MainActor func theSameMessageAgainRestartsTheWait() async {
        let store = makeStore()
        store.setTransientOperationError("Message not sent.", for: .milliseconds(60))
        store.setTransientOperationError("Message not sent.", for: .seconds(30))
        try? await Task.sleep(for: .milliseconds(250))
        // A second failure must not be wiped by the first failure's timer.
        #expect(store.latestOperationError == "Message not sent.")
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
}
