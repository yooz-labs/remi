import Foundation
import LocalAuthentication
import Security
import Testing
@testable import RemiKit
@testable import RemiPush

#if os(macOS)
/// Opt-in Keychain stress diagnostic for #1768: many concurrent non-interactive
/// reads, the pattern of two local LocalAuthentication crashes. It is excluded
/// from the default run because a crash or a hang ends the whole test process:
/// `REMI_LA_STRESS=1 swift test --package-path packages/native/RemiKit --filter
/// LocalAuthenticationStressTests`. Run one opt-in run at a time; a killed run
/// leaves its two test-only items until the next run starts.
///
/// REMI_LA_STRESS_MODE selects what each read does:
/// - Regression checks, expected to pass: `stores` (the default) reads through
///   NativePushKeyStore.load and NativeIdentityRecordStore.currentRecord, that
///   is, through NativeKeychainReadContext; `shared` sends the same query with one
///   long-lived test-owned context; `invalidated` uses that context after
///   invalidating it, as a read sees a long-lived context the system invalidated.
/// - Historical comparison, kept only to reproduce #1768: `fresh` creates a new
///   context per read, the stores' pattern before #1768, which made the daemon
///   invalidate live contexts and can hang (the negative control).
/// - Timing control: `none` passes no context. It is never a candidate, because
///   the stores' reads must stay non-interactive.
///
/// REMI_LA_STRESS_WORKERS, REMI_LA_STRESS_ITERATIONS and REMI_LA_STRESS_TIMEOUT
/// (seconds) size the run; REMI_LA_STRESS_ITEMS=absent reads names that do not
/// exist instead of writing the two items; REMI_LA_STRESS_EXECUTOR=tasks runs the
/// workers as detached tasks on the cooperative pool, where the package's own
/// tests run, instead of on threads.
///
/// The two items are test-only, under one fixed service that each run empties
/// before and after it, in the file Keychain the unsigned test process reaches.
/// Only counts and OSStatus codes are printed, never item contents.
struct LocalAuthenticationStressTests {
    private static let environment = ProcessInfo.processInfo.environment

    @Test(.enabled(if: environment["REMI_LA_STRESS"] == "1",
                   "Set REMI_LA_STRESS=1 to run the Keychain stress diagnostic"))
    func concurrentNoninteractiveReads() throws {
        let mode = Self.environment["REMI_LA_STRESS_MODE"] ?? "stores"
        let workers = Int(Self.environment["REMI_LA_STRESS_WORKERS"] ?? "") ?? 16
        let iterations = Int(Self.environment["REMI_LA_STRESS_ITERATIONS"] ?? "") ?? 100
        let timeout = Double(Self.environment["REMI_LA_STRESS_TIMEOUT"] ?? "") ?? 120
        try #require(["stores", "fresh", "shared", "invalidated", "none"].contains(mode))
        let items = try StressItems(write: Self.environment["REMI_LA_STRESS_ITEMS"] != "absent")
        defer { items.cleanup() }
        let tally = Tally()
        let shared = SharedContext()
        if mode == "invalidated" { shared.context.invalidate() }
        let group = DispatchGroup()
        let started = Date()
        let onTasks = Self.environment["REMI_LA_STRESS_EXECUTOR"] == "tasks"
        for _ in 0..<workers {
            group.enter()
            let work: @Sendable () -> Void = {
                defer { group.leave() }
                let push = NativePushKeyStore(service: items.service, account: items.pushAccount, accessGroup: nil)
                for _ in 0..<iterations {
                    if mode == "stores" {
                        do {
                            tally.record(try push.load()?.publicKey == items.records?.pushPublicKey ? nil : "mismatch")
                        } catch { tally.record("\(error)") }
                        do {
                            let identity = try NativeIdentityRecordStore.currentRecord(accessGroup: nil,
                                service: items.service, account: items.identityAccount)
                            tally.record(identity?.publicKeyRaw == items.records?.identityPublicKey ? nil : "mismatch")
                        } catch { tally.record("\(error)") }
                        continue
                    }
                    for (account, expected) in [(items.pushAccount, items.records?.pushRecord),
                                                (items.identityAccount, items.records?.identityRecord)] {
                        let read = { (context: LAContext?) in
                            tally.record(Self.rawRead(service: items.service, account: account,
                                                      context: context, expected: expected))
                        }
                        switch mode {
                        case "shared", "invalidated": read(shared.context)
                        case "none": read(nil)
                        default:
                            let context = LAContext()
                            context.interactionNotAllowed = true
                            read(context)
                        }
                    }
                }
            }
            if onTasks { Task.detached(operation: work) } else { Thread(block: work).start() }
        }
        let finished = group.wait(timeout: .now() + timeout) == .success
        let seconds = Date().timeIntervalSince(started)
        let summary = tally.summary
        print("LA_STRESS pid=\(getpid()) mode=\(mode) items=\(items.records == nil ? "absent" : "present") "
            + "executor=\(onTasks ? "tasks" : "threads") "
            + "workers=\(workers) iterations=\(iterations) reads=\(summary.reads) failures=\(summary.failures) "
            + "finished=\(finished) seconds=\(String(format: "%.2f", seconds)) outcomes=\(summary.outcomes)")
        #expect(finished)
        #expect(summary.failures == 0)
    }

    /// The stores' read query (the keys NativeKeychainReadContext.readQuery adds),
    /// with the context chosen by the mode. `expected` nil means not found.
    private static func rawRead(service: String, account: String, context: LAContext?, expected: Data?) -> String? {
        var query = KeychainRecordFixtures.query(service: service, account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        if let context { query[kSecUseAuthenticationContext as String] = context }
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return expected == nil ? nil : "status \(status)" }
        guard status == errSecSuccess else { return "status \(status)" }
        return result as? Data == expected ? nil : "mismatch"
    }

    private final class SharedContext: @unchecked Sendable {
        let context: LAContext
        init() {
            context = LAContext()
            context.interactionNotAllowed = true
        }
    }

    /// The two items of a run (KeychainRecordFixtures), or none.
    private struct StressItems: Sendable {
        /// One fixed test-only service, so a run that crashed or was killed
        /// leaves nothing behind once the next run starts.
        let service = "live.yooz.remi.tests.la-stress"
        let pushAccount = "push-\(UUID().uuidString)"
        let identityAccount = "identity-\(UUID().uuidString)"
        let records: KeychainRecordFixtures?

        init(write: Bool) throws {
            records = try write ? KeychainRecordFixtures() : nil
            SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                           kSecAttrService as String: service] as CFDictionary)
            guard let records else { return }
            try #require(KeychainRecordFixtures.add(records.pushRecord, service: service, account: pushAccount)
                == errSecSuccess)
            try #require(KeychainRecordFixtures.add(records.identityRecord, service: service, account: identityAccount)
                == errSecSuccess)
        }
        func cleanup() {
            for account in [pushAccount, identityAccount] { KeychainRecordFixtures.delete(service: service, account: account) }
        }
    }

    private final class Tally: @unchecked Sendable {
        private let lock = NSLock()
        private var reads = 0
        private var outcomes: [String: Int] = [:]
        func record(_ failure: String?) {
            lock.withLock {
                reads += 1
                if let failure { outcomes[failure, default: 0] += 1 }
            }
        }
        var summary: (reads: Int, failures: Int, outcomes: [String: Int]) {
            lock.withLock { (reads, outcomes.values.reduce(0, +), outcomes) }
        }
    }
}
#endif
