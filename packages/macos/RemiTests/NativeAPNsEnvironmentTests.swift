import XCTest

final class NativeAPNsEnvironmentTests: XCTestCase {
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
}
