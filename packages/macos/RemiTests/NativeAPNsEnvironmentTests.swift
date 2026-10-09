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

    @MainActor
    func testUnsignedProductionOSQueryIsUnavailable() async {
        // The unhosted unsigned test process has no aps-environment entitlement.
        // This invokes the real public SecTask self-query; it reads no Keychain.
        let result = await NativeAPNsEnvironment().resolve(stillCurrent: { true })
        XCTAssertEqual(result, .unavailable)
    }

    @MainActor
    func testTaskCancellationDisposesQueries() async throws {
        var queries = 0
        var cancellations = 0
        let environment = NativeAPNsEnvironment(query: { _, _ in
            queries += 1
            return { cancellations += 1 }
        })
        let task = Task { await environment.resolve(stillCurrent: { true }) }
        try await awaitQueries { queries == 2 }
        XCTAssertEqual(queries, 2)
        task.cancel()
        let result = await task.value
        XCTAssertEqual(result, .unavailable)
        XCTAssertEqual(cancellations, 2, "Task cancellation must dispose both native queries")
    }

    @MainActor
    func testReplacedAttemptIgnoresOldCallbacksAndOldTaskCancellation() async throws {
        var completions: [(Bool, (NativeAPNsEnvironment.Match) -> Void)] = []
        var cancellations = 0
        let environment = NativeAPNsEnvironment(query: { production, completion in
            completions.append((production, completion))
            return { cancellations += 1 }
        })
        let old = Task { await environment.resolve(stillCurrent: { true }) }
        try await awaitQueries { completions.count == 2 }
        XCTAssertEqual(completions.count, 2)
        let fresh = Task { await environment.resolve(stillCurrent: { true }) }
        try await awaitQueries { completions.count == 4 }
        XCTAssertEqual(completions.count, 4)
        let replaced = await old.value
        XCTAssertEqual(replaced, .unavailable)
        old.cancel()
        for (production, complete) in completions.prefix(2) { complete(production ? .match : .mismatch) }
        for (production, complete) in completions.suffix(2) { complete(production ? .mismatch : .match) }
        let result = await fresh.value
        XCTAssertEqual(result, .sandbox, "Old production replies cannot replace the new sandbox result")
        XCTAssertEqual(cancellations, 4)
    }

    @MainActor
    func testDuplicateOSReplyFailsClosed() async {
        let environment = NativeAPNsEnvironment(query: { production, completion in
            completion(production ? .match : .mismatch)
            if production { completion(.match) }
            return {}
        })
        let result = await environment.resolve(stillCurrent: { true })
        XCTAssertEqual(result, .unavailable, "An ambiguous duplicate callback is not a runtime entitlement proof")
    }


    func testActualAnonymousSelfPeerRejectsAbsentEntitlementExactlyOnce() async {
        let complete = expectation(description: "Actual self-peer mismatch")
        complete.expectedFulfillmentCount = 1
        complete.assertForOverFulfill = true
        let cancel = RemiQueryAPNsSelfPeerForTesting("live.yooz.remi.tests.absent", true) { result in
            XCTAssertEqual(result, 0, "The public self-peer requirement must explicitly refuse an absent entitlement")
            complete.fulfill()
        }
        await fulfillment(of: [complete], timeout: 3)
        cancel()
        try? await Task.sleep(nanoseconds: 100_000_000)
    }

    func testActualAnonymousSelfPeerCancellationCompletesOnlyOnce() async {
        let complete = expectation(description: "Actual canceled self-peer completion")
        complete.expectedFulfillmentCount = 1
        complete.assertForOverFulfill = true
        let cancel = RemiQueryAPNsSelfPeerForTesting("live.yooz.remi.tests.absent", false) { result in
            // The explicit mismatch can win the real OS race; neither result
            // grants environment authority. Cancellation cannot publish match.
            XCTAssertTrue(result == -1 || result == 0)
            complete.fulfill()
        }
        cancel(); cancel()
        await fulfillment(of: [complete], timeout: 3)
        try? await Task.sleep(nanoseconds: 100_000_000)
    }

}

/// #1200: `project.yml` is the source of truth for the checked-in project. The
/// native push sources need these build settings and files; a regeneration that
/// drops them leaves `$(APNS_ENVIRONMENT)` empty in the entitlements and removes
/// the Objective-C bridging header `NativeAPNsEnvironment.swift` compiles against.
final class MacOSProjectSpecTests: XCTestCase {
    private var macos: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }
    private func text(_ name: String) throws -> String {
        try String(contentsOf: macos.appendingPathComponent(name), encoding: .utf8)
    }
    /// The lines of one top-level-indented target block in project.yml.
    private func block(_ name: String, in spec: String) throws -> String {
        let lines = spec.components(separatedBy: "\n")
        let start = try XCTUnwrap(lines.firstIndex { $0 == "  \(name):" }, "project.yml has no target \(name)")
        let rest = lines[(start + 1)...]
        let end = rest.firstIndex { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            return !trimmed.isEmpty && !trimmed.hasPrefix("#") && line.prefix { $0 == " " }.count <= 2
        }
        return rest[..<(end ?? lines.endIndex)].joined(separator: "\n")
    }
    func testSpecDeclaresTheApnsEnvironmentPerConfiguration() throws {
        let app = try block("Remi", in: text("project.yml"))
        XCTAssertTrue(app.contains("APNS_ENVIRONMENT: development"), "Debug must sign the development APNs environment")
        XCTAssertTrue(app.contains("APNS_ENVIRONMENT: production"), "Release must sign the production APNs environment")
        let project = try text("Remi.xcodeproj/project.pbxproj")
        XCTAssertTrue(project.contains("APNS_ENVIRONMENT = development;") && project.contains("APNS_ENVIRONMENT = production;"))
    }
    func testSpecDeclaresTheBridgingHeaderTheEnvironmentQueryNeeds() throws {
        let spec = try text("project.yml")
        XCTAssertTrue(spec.contains("SWIFT_OBJC_BRIDGING_HEADER: Remi/NativePush/NativePush-Bridging-Header.h"))
        XCTAssertTrue(try text("Remi.xcodeproj/project.pbxproj").contains("SWIFT_OBJC_BRIDGING_HEADER"))
    }
    func testSpecCompilesTheShippingExtensionAndDelegateIntoTheTestTarget() throws {
        let tests = try block("RemiTests", in: text("project.yml"))
        XCTAssertTrue(tests.contains("RemiNotificationService/NotificationService.swift"),
                      "Tests must construct the actual iOS notification extension class")
        XCTAssertFalse(tests.contains("AppDelegate.swift"),
                       "Registration ingress tests construct the actual macOS AppDelegate")
    }
}
