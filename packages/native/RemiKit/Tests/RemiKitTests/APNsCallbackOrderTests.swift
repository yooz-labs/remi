import Foundation
import Testing
@testable import RemiPush

// The actual OS boundary may call from a different executor. This holder only
// transports its callback; the production resolver owns all decision logic.
private final class APNsCallbackDelivery: @unchecked Sendable {
    let callback: (NativeAPNsEnvironment.Match) -> Void
    init(_ callback: @escaping (NativeAPNsEnvironment.Match) -> Void) { self.callback = callback }
}

private final class APNsWaitResults: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Bool] = []
    func append(_ value: Bool) { lock.lock(); defer { lock.unlock() }; values.append(value) }
    func snapshot() -> [Bool] { lock.lock(); defer { lock.unlock() }; return values }
}

private final class APNsOrderedCallbacks: @unchecked Sendable {
    let queue = DispatchQueue(label: "remi.test.apns-callback-order")
    let finished = DispatchGroup()
    let waits = APNsWaitResults()

    func submit(production: Bool, delivery: APNsCallbackDelivery) {
        finished.enter()
        queue.async { [self] in
            defer { finished.leave() }
            let priorities: [TaskPriority] = production ? [.high, .background] : [.high]
            for priority in priorities {
                let returned = DispatchSemaphore(value: 0)
                Task.detached(priority: priority) {
                    delivery.callback(production ? .match : .mismatch)
                    returned.signal()
                }
                waits.append(returned.wait(timeout: .now() + 3) == .success)
            }
        }
    }
}

@MainActor
struct APNsCallbackOrderTests {
    @Test func callbackPriorityCannotReorderAnEarlierDuplicate() async {
        let callbacks = APNsOrderedCallbacks()
        let environment = NativeAPNsEnvironment(query: { production, completion in
            let delivery = APNsCallbackDelivery(completion)
            // Preserve arrival order without waiting on the MainActor that other tests need.
            callbacks.submit(production: production, delivery: delivery)
            return {}
        })
        let result = await environment.resolve(stillCurrent: { true })
        await withCheckedContinuation { continuation in
            callbacks.finished.notify(queue: .main) { continuation.resume() }
        }
        #expect(callbacks.waits.snapshot() == [true, true, true])
        #expect(result == .unavailable)
    }

    @Test func earlierDuplicateCannotBeOvertakenByComplementaryResult() async {
        var accepted = 0
        for _ in 0..<1_000 {
            let environment = NativeAPNsEnvironment(query: { production, completion in
                completion(production ? .match : .mismatch)
                if production { completion(.match) }
                return {}
            })
            if await environment.resolve(stillCurrent: { true }) != .unavailable {
                accepted += 1
            }
        }
        #expect(accepted == 0, "An earlier duplicate must refuse every actual resolver attempt")
    }

    @Test func exactComplementaryResultsStillSelectBothEnvironments() async {
        for expected in [NativeAPNsEnvironment.Outcome.production, .sandbox] {
            let environment = NativeAPNsEnvironment(query: { production, completion in
                completion(production == (expected == .production) ? .match : .mismatch)
                return {}
            })
            #expect(await environment.resolve(stillCurrent: { true }) == expected)
        }
    }
}
