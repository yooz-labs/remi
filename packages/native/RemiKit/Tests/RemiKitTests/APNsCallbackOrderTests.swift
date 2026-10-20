import Foundation
import Testing
@testable import RemiPush

// The actual OS boundary may call from a different executor. This holder only
// transports its callback; the production resolver owns all decision logic.
private final class APNsCallbackDelivery: @unchecked Sendable {
    let callback: (NativeAPNsEnvironment.Match) -> Void
    init(_ callback: @escaping (NativeAPNsEnvironment.Match) -> Void) { self.callback = callback }
}

@MainActor
struct APNsCallbackOrderTests {
    @Test func callbackPriorityCannotReorderAnEarlierDuplicate() async {
        let environment = NativeAPNsEnvironment(query: { production, completion in
            let delivery = APNsCallbackDelivery(completion)
            let priorities: [TaskPriority] = production ? [.high, .background] : [.high]
            for priority in priorities {
                let returned = DispatchSemaphore(value: 0)
                Task.detached(priority: priority) {
                    delivery.callback(production ? .match : .mismatch)
                    returned.signal()
                }
                #expect(returned.wait(timeout: .now() + 3) == .success)
            }
            return {}
        })
        #expect(await environment.resolve(stillCurrent: { true }) == .unavailable)
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
