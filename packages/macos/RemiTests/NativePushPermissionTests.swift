import Foundation
import XCTest

final class NativePushPermissionTests: XCTestCase {
    @MainActor func testActualPermissionContinuationCompletesOnceDespiteLateOSCallbacks() async throws {
        var completion: ((Bool) -> Void)?
        let owner = NativePushPermission(osRequest: { completion = $0 })
        var returned: [Bool] = []
        let task = Task { returned.append(await owner.resolve()) }
        for _ in 0..<50 where completion == nil { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertNotNil(completion, "The actual production continuation must reach its external OS boundary")
        completion?(true)
        await task.value
        completion?(false); completion?(true)
        await Task.yield()
        XCTAssertEqual(returned, [true])
    }
    @MainActor func testActualPermissionCancellationRefusesLateSuccessfulOSCallback() async throws {
        var completion: ((Bool) -> Void)?
        let owner = NativePushPermission(osRequest: { completion = $0 })
        let task = Task { await owner.resolve() }
        for _ in 0..<50 where completion == nil { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertNotNil(completion)
        task.cancel()
        completion?(true)
        let result = await task.value
        XCTAssertFalse(result)
        completion?(true)
        await Task.yield()
    }
    @MainActor func testSilentActualOSPermissionHasOneThirtySecondDeadline() async throws {
        var requests = 0
        let owner = NativePushPermission(osRequest: { _ in requests += 1 })
        let started = ProcessInfo.processInfo.systemUptime
        let task = Task { () -> (Bool, TimeInterval) in
            let result = await owner.resolve()
            return (result, ProcessInfo.processInfo.systemUptime - started)
        }
        // A bounded safety cancellation makes a missing production deadline a
        // named elapsed-time assertion failure, rather than a runner timeout.
        try await Task.sleep(nanoseconds: 33_000_000_000)
        task.cancel()
        let (result, elapsed) = await task.value
        XCTAssertEqual(requests, 1)
        XCTAssertFalse(result)
        XCTAssertGreaterThanOrEqual(elapsed, 29)
        XCTAssertLessThan(elapsed, 32, "A silent native permission callback must lose authority at its fixed deadline")
    }
}
