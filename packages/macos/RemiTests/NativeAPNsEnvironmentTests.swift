import XCTest

final class NativeAPNsEnvironmentTests: XCTestCase {
    @MainActor
    private func awaitQueries(_ ready: () -> Bool) async throws {
        for _ in 0..<50 where !ready() { try await Task.sleep(nanoseconds: 20_000_000) }
    }

    @MainActor
    func testProductionRequiresBothExactOSQueryOutcomes() async {
        var queries: [Bool] = []
        // Only the external OS completion boundary is controlled here. The
        // actual production resolver must aggregate and enforce the policy.
        let environment = NativeAPNsEnvironment(query: { production, completion in
            queries.append(production)
            completion(production ? .match : .mismatch)
            return {}
        })
        let result = await environment.resolve(stillCurrent: { true })
        XCTAssertEqual(result, .production, "One production match and one development mismatch must select production")
        XCTAssertEqual(Set(queries), Set([false, true]), "Both actual entitlement queries are required")
    }

    @MainActor
    func testSandboxRequiresBothExactOSQueryOutcomes() async {
        let environment = NativeAPNsEnvironment(query: { production, completion in
            completion(production ? .mismatch : .match)
            return {}
        })
        let result = await environment.resolve(stillCurrent: { true })
        XCTAssertEqual(result, .sandbox, "One development match and one production mismatch must select sandbox")
    }

    @MainActor
    func testConflictingOrUnavailableOSResultsNeverChooseEnvironment() async {
        for match: NativeAPNsEnvironment.Match in [.match, .mismatch, .unavailable] {
            let environment = NativeAPNsEnvironment(query: { _, completion in
                completion(match)
                return {}
            })
            let result = await environment.resolve(stillCurrent: { true })
            XCTAssertEqual(result, .unavailable, "Conflicting, missing or failed OS authority is unavailable")
        }
    }

    @MainActor
    func testCancelDisposesBothQueriesAndCannotAcceptLateOSCompletion() async throws {
        var completions: [Bool: (NativeAPNsEnvironment.Match) -> Void] = [:]
        var canceled: [Bool] = []
        let environment = NativeAPNsEnvironment(query: { production, completion in
            completions[production] = completion
            return { canceled.append(production) }
        })
        let attempt = Task { await environment.resolve(stillCurrent: { true }) }
        try await awaitQueries { completions.count == 2 }
        XCTAssertEqual(completions.count, 2, "The actual resolver must start both OS attempts")
        environment.cancel()
        let result = await attempt.value
        XCTAssertEqual(result, .unavailable)
        completions[true]?(.match); completions[false]?(.mismatch)
        await Task.yield()
        XCTAssertEqual(Set(canceled), Set([false, true]), "Cancellation must dispose both owned OS attempts")
    }

    @MainActor
    func testContextReplacementDuringOSAwaitRefusesEnvironment() async throws {
        var completions: [Bool: (NativeAPNsEnvironment.Match) -> Void] = [:]
        var current = true
        var cancellations = 0
        let environment = NativeAPNsEnvironment(query: { production, completion in
            completions[production] = completion
            return { cancellations += 1 }
        })
        let attempt = Task { await environment.resolve(stillCurrent: { current }) }
        try await awaitQueries { completions.count == 2 }
        XCTAssertEqual(completions.count, 2, "The actual resolver must await the OS before context replacement")
        current = false
        completions[true]?(.match); completions[false]?(.mismatch)
        let result = await attempt.value
        XCTAssertEqual(result, .unavailable, "Changed foreground/identity/trust/document context cannot install an environment")
        XCTAssertEqual(cancellations, 2)
    }

    @MainActor
    func testSilentOSQueriesShareOneTwoSecondDeadline() async {
        var queries = 0
        var cancellations = 0
        let environment = NativeAPNsEnvironment(query: { _, _ in
            queries += 1
            return { cancellations += 1 }
        })
        let began = ProcessInfo.processInfo.systemUptime
        let result = await environment.resolve(stillCurrent: { true })
        let elapsed = ProcessInfo.processInfo.systemUptime - began
        XCTAssertEqual(result, .unavailable)
        XCTAssertEqual(queries, 2, "Both silent OS queries must be owned by one attempt")
        XCTAssertGreaterThanOrEqual(elapsed, 1.8, "A silent supported query must remain pending until its deadline")
        XCTAssertLessThan(elapsed, 3, "Both queries share one two-second deadline, rather than serial two-second waits")
        XCTAssertEqual(cancellations, 2, "Timeout must dispose both owned OS attempts")
    }
}
