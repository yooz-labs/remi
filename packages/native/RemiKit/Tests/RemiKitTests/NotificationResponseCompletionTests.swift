import Foundation
import Testing
@testable import RemiKit

private final class ResponseEvents: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [(String, Bool)] = []

    func record(_ name: String) {
        lock.lock(); defer { lock.unlock() }
        events.append((name, Thread.isMainThread))
    }

    func snapshot() -> [(String, Bool)] {
        lock.lock(); defer { lock.unlock() }
        return events
    }
}

@Suite struct NotificationResponseCompletionTests {
    @Test func completionRunsOnMainAfterSuspendedHandling() async {
        let events = ResponseEvents()
        let finished = await Task.detached { runProbe(events) }.value
        #expect(finished)
        let result = events.snapshot()
        #expect(result.map { $0.0 } == ["start", "end", "completion"])
        let allOnMain = result.allSatisfy { $0.1 }
        #expect(allOnMain)
    }

    private func runProbe(_ events: ResponseEvents) -> Bool {
        let semaphore = DispatchSemaphore(value: 0)
        NotificationResponseCompletion.perform({
            events.record("start")
            await Task.yield()
            events.record("end")
        }, completion: {
            events.record("completion")
            semaphore.signal()
        })
        return semaphore.wait(timeout: .now() + 3) == .success
    }
}
