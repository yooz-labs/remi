import CryptoKit
import Foundation
import LocalAuthentication
import Security
import Testing
@testable import RemiKit
@testable import RemiPush

#if os(macOS)
/// Opt-in diagnostic for #1768: many threads making non-interactive Keychain
/// reads at once, the pattern found in two local LocalAuthentication crashes.
/// It is excluded from the default run because a crash ends the whole test
/// process: run it with REMI_LA_STRESS=1 and --filter LocalAuthenticationStressTests.
///
/// REMI_LA_STRESS_MODE `stores` (the default) reads through NativePushKeyStore.load
/// and NativeIdentityRecordStore.currentRecord. The other modes repeat the stores'
/// query directly and differ only in the authentication context, for comparison:
/// `fresh` (a new LAContext per read, the stores' pattern), `shared` (one
/// long-lived LAContext), `invalidated` (that one context, invalidated before the
/// first read: what a read sees if the system invalidates a long-lived context),
/// `serial` (a new LAContext per read, created, used and released under one lock)
/// and `none` (no LAContext: a control only, never a candidate, because the
/// stores' reads must stay non-interactive).
/// REMI_LA_STRESS_WORKERS, REMI_LA_STRESS_ITERATIONS and REMI_LA_STRESS_TIMEOUT
/// (seconds) size the run; REMI_LA_STRESS_ITEMS=absent reads names that do not
/// exist instead of writing the two items; REMI_LA_STRESS_EXECUTOR=tasks runs
/// the workers as detached tasks on the cooperative pool, where the package's
/// own tests run, instead of on threads.
///
/// The two items are test-only (one fixed service, emptied before and after each
/// run) in the file Keychain the unsigned test binary reaches. Only counts and OSStatus codes
/// are printed, never item contents.
struct LocalAuthenticationStressTests {
    private static let environment = ProcessInfo.processInfo.environment

    @Test(.enabled(if: environment["REMI_LA_STRESS"] == "1",
                   "Set REMI_LA_STRESS=1 to run the Keychain stress diagnostic"))
    func concurrentNoninteractiveReads() throws {
        let mode = Self.environment["REMI_LA_STRESS_MODE"] ?? "stores"
        let workers = Int(Self.environment["REMI_LA_STRESS_WORKERS"] ?? "") ?? 16
        let iterations = Int(Self.environment["REMI_LA_STRESS_ITERATIONS"] ?? "") ?? 100
        let timeout = Double(Self.environment["REMI_LA_STRESS_TIMEOUT"] ?? "") ?? 120
        try #require(["stores", "fresh", "shared", "invalidated", "serial", "none"].contains(mode))
        let items = try StressItems(write: Self.environment["REMI_LA_STRESS_ITEMS"] != "absent")
        defer { items.cleanup() }
        let tally = Tally()
        let shared = SharedContext()
        if mode == "invalidated" { shared.context.invalidate() }
        let serial = NSLock()
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
                            tally.record(try push.load()?.publicKey == items.pushPublicKey ? nil : "mismatch")
                        } catch { tally.record("\(error)") }
                        do {
                            let identity = try NativeIdentityRecordStore.currentRecord(accessGroup: nil,
                                service: items.service, account: items.identityAccount)
                            tally.record(identity?.publicKeyRaw == items.identityPublicKey ? nil : "mismatch")
                        } catch { tally.record("\(error)") }
                        continue
                    }
                    for (account, expected) in [(items.pushAccount, items.pushRecord),
                                                (items.identityAccount, items.identityRecord)] {
                        let read = { (context: LAContext?) in
                            tally.record(Self.rawRead(service: items.service, account: account,
                                                      context: context, expected: expected))
                        }
                        switch mode {
                        case "shared", "invalidated": read(shared.context)
                        case "none": read(nil)
                        case "serial":
                            serial.withLock {
                                let context = LAContext()
                                context.interactionNotAllowed = true
                                read(context)
                            }
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
        print("LA_STRESS pid=\(getpid()) mode=\(mode) items=\(items.written ? "present" : "absent") "
            + "executor=\(onTasks ? "tasks" : "threads") "
            + "workers=\(workers) iterations=\(iterations) reads=\(summary.reads) failures=\(summary.failures) "
            + "finished=\(finished) seconds=\(String(format: "%.2f", seconds)) outcomes=\(summary.outcomes)")
        #expect(finished)
        #expect(summary.failures == 0)
    }

    /// The stores' read query (as in NativePushKeyStore.read(query:)), with the
    /// context handling chosen by the mode. `expected` nil means not found.
    private static func rawRead(service: String, account: String, context: LAContext?, expected: Data?) -> String? {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account, kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne]
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

    /// One push key record and one identity record, written the way the
    /// existing owned-context tests write theirs, or neither.
    private struct StressItems: Sendable {
        /// One fixed test-only service, so a run that crashed or was killed
        /// leaves nothing behind once the next run starts.
        let service = "live.yooz.remi.tests.la-stress"
        let pushAccount = "push-\(UUID().uuidString)"
        let identityAccount = "identity-\(UUID().uuidString)"
        let written: Bool
        let pushRecord: Data?
        let pushPublicKey: Data?
        let identityRecord: Data?
        let identityPublicKey: Data?

        init(write: Bool) throws {
            written = write
            SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                           kSecAttrService as String: service] as CFDictionary)
            guard write else {
                pushRecord = nil; pushPublicKey = nil; identityRecord = nil; identityPublicKey = nil
                return
            }
            struct PushRecord: Encodable { let version: Int; let privateDER: Data; let publicKey: Data; let keyVersion: Int }
            struct IdentityRecord: Encodable {
                let version: Int; let pkcs8: Data; let publicKey: Data; let revision: String; let requiresAppUnlock: Bool
            }
            let key = P256.KeyAgreement.PrivateKey()
            let pushPublicKey = key.publicKey.x963Representation
            let pushRecord = try JSONEncoder().encode(PushRecord(version: 1, privateDER: key.derRepresentation,
                publicKey: pushPublicKey, keyVersion: 3))
            let identity = ClientIdentity()
            let identityRecord = try JSONEncoder().encode(IdentityRecord(version: 2,
                pkcs8: Ed25519PKCS8.encode(identity.privateKey), publicKey: identity.publicKeyRaw,
                revision: UUID().uuidString, requiresAppUnlock: false))
            self.pushRecord = pushRecord; self.pushPublicKey = pushPublicKey
            self.identityRecord = identityRecord; identityPublicKey = identity.publicKeyRaw
            for (account, data) in [(pushAccount, pushRecord), (identityAccount, identityRecord)] {
                var item = query(account)
                item[kSecValueData as String] = data
                item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                try #require(SecItemAdd(item as CFDictionary, nil) == errSecSuccess)
            }
        }
        private func query(_ account: String) -> [String: Any] {
            [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
             kSecAttrAccount as String: account]
        }
        func cleanup() {
            for account in [pushAccount, identityAccount] { SecItemDelete(query(account) as CFDictionary) }
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
