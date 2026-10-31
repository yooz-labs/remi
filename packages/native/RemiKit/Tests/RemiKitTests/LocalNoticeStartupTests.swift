import Foundation
import Security
import Testing
@testable import RemiPush
@testable import RemiKit

@MainActor private final class OwnedStartupKeychain {
    var readStatus: OSStatus = errSecItemNotFound
    var stored: Data?
    var reads = 0, adds = 0
    var operations: NativeKeychainOperations {
        NativeKeychainOperations(copyMatching: { [self] _, output in
            reads += 1
            if readStatus == errSecSuccess, let stored { output?.pointee = stored as CFData }
            return readStatus
        }, add: { [self] query, _ in
            adds += 1; stored = (query as NSDictionary)[kSecValueData] as? Data; readStatus = errSecSuccess
            return errSecSuccess
        }, update: { _, _ in Issue.record("Startup must not rotate its key"); return errSecUnimplemented })
    }
}

@MainActor private final class HeldStartupInventory {
    var pending: (@Sendable (LocalNoticeInventory.Batch) -> Void)?
    var delivered: (@Sendable (LocalNoticeInventory.Batch) -> Void)?
    var boundary: LocalNoticeInventory.Boundary {
        .init(pending: { [self] _, callback in pending = callback },
              delivered: { [self] _, callback in delivered = callback })
    }
}

@Suite(.serialized) @MainActor struct LocalNoticeStartupTests {
    private func resources() throws -> (URL, String, UserDefaults) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("remi-local-startup-\(UUID())")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let name = "live.yooz.remi.tests.local-startup." + UUID().uuidString
        return (dir, name, try #require(UserDefaults(suiteName: name)))
    }
    private func boundary(pending: [LocalNoticeInventoryRecord] = [], delivered: [LocalNoticeInventoryRecord] = [],
                          onRead: @escaping () -> Void = {}) -> LocalNoticeInventory.Boundary {
        .init(pending: { _, callback in onRead(); callback(.pending(pending)) },
              delivered: { _, callback in onRead(); callback(.delivered(delivered)) })
    }
    private func notificationBoundary() -> LocalNoticeBoundary {
        .init(authorized: { true }, identifierAvailable: { _ in true }, add: { _ in Issue.record("Startup must not add") },
              remove: { _ in Issue.record("Startup must not remove unrelated alerts") })
    }

    @Test func lockedStartupNeverReadsInventoryOrCreatesKey() async throws {
        let (dir, name, defaults) = try resources(); defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let keychain = OwnedStartupKeychain(); keychain.readStatus = errSecInteractionNotAllowed
        var reads = 0
        let reader = LocalNoticeInventory(boundary: boundary(onRead: { reads += 1 }))
        do {
            _ = try await LocalNoticeStartup.open(directory: dir, sentinel: .init(defaults: defaults, domainName: name),
                keyStore: .init(service: "synthetic", account: "startup"), operations: keychain.operations,
                inventory: reader, protectedDataAvailable: { true }, notificationBoundary: notificationBoundary())
            Issue.record("Locked keychain must not start")
        } catch let error as LocalNoticeBootstrap.Failure { #expect(error == .locked) }
        #expect(reads == 0); #expect(keychain.adds == 0)
    }

    @Test func priorLocalMarkerWithMissingKeyRequiresRecoveryWithoutErasure() async throws {
        let (dir, name, defaults) = try resources(); defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let keychain = OwnedStartupKeychain()
        let marker = LocalNoticeInventoryRecord(identifier: "remi.local.v1.synthetic", title: "Synthetic", subtitle: "", body: "",
            deliveredAt: nil, protected: false, marker: nil, metadataBytes: 64)
        let reader = LocalNoticeInventory(boundary: boundary(pending: [marker]))
        do {
            _ = try await LocalNoticeStartup.open(directory: dir, sentinel: .init(defaults: defaults, domainName: name),
                keyStore: .init(service: "synthetic", account: "startup"), operations: keychain.operations,
                inventory: reader, protectedDataAvailable: { true }, notificationBoundary: notificationBoundary())
            Issue.record("Missing historical key must require recovery")
        } catch let error as LocalNoticeBootstrap.Failure { #expect(error == .recoveryRequired) }
        #expect(keychain.adds == 0)
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("local-notifications.sqlite").path))
    }

    @Test func freshStartupEstablishesSentinelAndPreservesSecureInventory() async throws {
        let (dir, name, defaults) = try resources(); defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let keychain = OwnedStartupKeychain()
        let secure = LocalNoticeInventoryRecord(identifier: "remi.local.v1.synthetic", title: "Synthetic", subtitle: "", body: "",
            deliveredAt: nil, protected: true, marker: nil, metadataBytes: 64)
        let sentinel = LocalNoticeSentinel(defaults: defaults, domainName: name)
        let reader = LocalNoticeInventory(boundary: boundary(pending: [secure]))
        let ready = try await LocalNoticeStartup.open(directory: dir, sentinel: sentinel,
            keyStore: .init(service: "synthetic", account: "startup"), operations: keychain.operations,
            inventory: reader, protectedDataAvailable: { true }, notificationBoundary: notificationBoundary())
        defer { ready.ledger.close() }
        #expect(keychain.adds == 1); #expect(sentinel.read() == .present)
        #expect(try ready.ledger.counts().tickets == 0)
    }

    @Test func protectedDataLossDuringInventoryCannotCreateAKey() async throws {
        let (dir, name, defaults) = try resources(); defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let keychain = OwnedStartupKeychain()
        var unlocked = true
        let reader = LocalNoticeInventory(boundary: boundary(onRead: { unlocked = false }))
        do {
            _ = try await LocalNoticeStartup.open(directory: dir, sentinel: .init(defaults: defaults, domainName: name),
                keyStore: .init(service: "synthetic", account: "startup"), operations: keychain.operations,
                inventory: reader, protectedDataAvailable: { unlocked }, notificationBoundary: notificationBoundary())
            Issue.record("Protected-data loss must prevent startup")
        } catch let error as LocalNoticeBootstrap.Failure { #expect(error == .locked) }
        #expect(keychain.adds == 0)
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("local-notifications.sqlite").path))
    }

    @Test func failedSentinelFlushCanRetryWithoutRotatingTheKey() async throws {
        let (dir, name, defaults) = try resources(); defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let keychain = OwnedStartupKeychain()
        var flushWorks = false
        let sentinel = LocalNoticeSentinel(defaults: defaults, domainName: name, flush: { _ in flushWorks })
        let reader = LocalNoticeInventory(boundary: boundary())
        do {
            _ = try await LocalNoticeStartup.open(directory: dir, sentinel: sentinel,
                keyStore: .init(service: "synthetic", account: "startup"), operations: keychain.operations,
                inventory: reader, protectedDataAvailable: { true }, notificationBoundary: notificationBoundary())
            Issue.record("Failed sentinel flush must prevent startup")
        } catch let error as LocalNoticeBootstrap.Failure { #expect(error == .unavailable) }
        let firstKey = try #require(keychain.stored)
        flushWorks = true
        let ready = try await LocalNoticeStartup.open(directory: dir, sentinel: sentinel,
            keyStore: .init(service: "synthetic", account: "startup"), operations: keychain.operations,
            inventory: reader, protectedDataAvailable: { true }, notificationBoundary: notificationBoundary())
        defer { ready.ledger.close() }
        #expect(keychain.adds == 1); #expect(keychain.stored == firstKey); #expect(sentinel.read() == .present)
    }

    @Test func cancelledInventoryCannotLaterCreateAKey() async throws {
        let (dir, name, defaults) = try resources(); defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let keychain = OwnedStartupKeychain(), os = HeldStartupInventory()
        let reader = LocalNoticeInventory(boundary: os.boundary, timeout: .seconds(1))
        let task = Task { try await LocalNoticeStartup.open(directory: dir, sentinel: .init(defaults: defaults, domainName: name),
            keyStore: .init(service: "synthetic", account: "startup"), operations: keychain.operations,
            inventory: reader, protectedDataAvailable: { true }, notificationBoundary: notificationBoundary()) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while os.pending == nil || os.delivered == nil {
            guard ContinuousClock.now < deadline else { throw LocalNoticeError.unavailable }
            try await Task.sleep(for: .milliseconds(5))
        }
        task.cancel()
        do { _ = try await task.value; Issue.record("Cancelled startup must not succeed") }
        catch is CancellationError { }
        os.pending?(.pending([])); os.delivered?(.delivered([]))
        #expect(keychain.adds == 0)
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("local-notifications.sqlite").path))
    }

    @Test func historicalPendingForgetCannotSilentlyRestoreLocalScheduling() async throws {
        let (dir, name, defaults) = try resources(); defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let keychain = OwnedStartupKeychain(), sentinel = LocalNoticeSentinel(defaults: defaults, domainName: name)
        let reader = LocalNoticeInventory(boundary: boundary())
        let first = try await LocalNoticeStartup.open(directory: dir, sentinel: sentinel,
            keyStore: .init(service: "synthetic", account: "startup"), operations: keychain.operations,
            inventory: reader, protectedDataAvailable: { true }, notificationBoundary: notificationBoundary())
        let owner = Data(repeating: 51, count: 32)
        try first.ledger.createOwner(owner); try first.ledger.invalidateOwner(owner)
        first.ledger.close()
        do {
            _ = try await LocalNoticeStartup.open(directory: dir, sentinel: sentinel,
                keyStore: .init(service: "synthetic", account: "startup"), operations: keychain.operations,
                inventory: reader, protectedDataAvailable: { true }, notificationBoundary: notificationBoundary())
            Issue.record("An unresolved historical forget cannot be silently adopted")
        } catch let error as LocalNoticeBootstrap.Failure { #expect(error == .pendingForget) }
        let ledger = try LocalNoticeLedger(directory: dir)
        defer { ledger.close() }
        #expect(try ledger.pendingForgetOwners() == [owner])
        #expect(keychain.adds == 1)
    }

    @Test func pendingForgetCanOpenRecoveryWithoutRestoringScheduling() async throws {
        let (dir, name, defaults) = try resources(); defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let keychain = OwnedStartupKeychain(), sentinel = LocalNoticeSentinel(defaults: defaults, domainName: name)
        let keyStore = LocalNoticeKeyStore(service: "synthetic", account: "startup")
        let reader = LocalNoticeInventory(boundary: boundary())
        let first = try await LocalNoticeStartup.open(directory: dir, sentinel: sentinel, keyStore: keyStore,
            operations: keychain.operations, inventory: reader, protectedDataAvailable: { true }, notificationBoundary: notificationBoundary())
        try first.ledger.createOwner(Data(repeating: 52, count: 32))
        try first.ledger.invalidateOwner(Data(repeating: 52, count: 32))
        first.ledger.close()
        var removals: [[String]] = []
        let access = try LocalNoticeStartup.openRecovery(directory: dir, keyStore: keyStore, operations: keychain.operations,
            protectedDataAvailable: true, remove: { removals.append($0) })
        defer { access.close() }
        #expect(access.pendingForgetCount == 1); #expect(removals.isEmpty)
        #expect(try access.recovery.unassignedUncertain().isEmpty)
        #expect(keychain.adds == 1)
    }

    @Test func recoveryOpeningNeverCreatesMissingKeyOrJournal() throws {
        let (dir, name, defaults) = try resources(); defer { defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        let keychain = OwnedStartupKeychain(), keyStore = LocalNoticeKeyStore(service: "synthetic", account: "startup")
        #expect(throws: LocalNoticeBootstrap.Failure.recoveryRequired) {
            try LocalNoticeStartup.openRecovery(directory: dir, keyStore: keyStore, operations: keychain.operations,
                                               protectedDataAvailable: true, remove: { _ in })
        }
        #expect(keychain.adds == 0)
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("local-notifications.sqlite").path))
        keychain.readStatus = errSecSuccess; keychain.stored = Data(repeating: 53, count: 32)
        #expect(throws: LocalNoticeBootstrap.Failure.recoveryRequired) {
            try LocalNoticeStartup.openRecovery(directory: dir, keyStore: keyStore, operations: keychain.operations,
                                               protectedDataAvailable: true, remove: { _ in })
        }
        #expect(keychain.adds == 0)
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("local-notifications.sqlite").path))
        let empty = dir.appendingPathComponent("local-notifications.sqlite")
        try Data().write(to: empty)
        #expect(throws: LocalNoticeBootstrap.Failure.recoveryRequired) {
            try LocalNoticeStartup.openRecovery(directory: dir, keyStore: keyStore, operations: keychain.operations,
                                               protectedDataAvailable: true, remove: { _ in })
        }
        #expect(try Data(contentsOf: empty).isEmpty)
        #expect(keychain.adds == 0)
    }
}
