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
}
