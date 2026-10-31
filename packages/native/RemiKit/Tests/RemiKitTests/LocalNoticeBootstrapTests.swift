import Foundation
import Security
import Testing
@testable import RemiPush
@testable import RemiKit

/// Substitutes only the Keychain OS boundary; bootstrap and protected SQLite remain real.
private final class OwnedLocalKeychain {
    var readStatus: OSStatus = errSecItemNotFound
    var addStatus: OSStatus = errSecSuccess
    var stored: Data?
    var reads = 0
    var adds = 0
    var accessibility: String?
    var synchronizable: Bool?
    var operations: NativeKeychainOperations {
        NativeKeychainOperations(copyMatching: { [self] _, output in
            reads += 1
            if readStatus == errSecSuccess, let stored { output?.pointee = stored as CFData }
            return readStatus
        }, add: { [self] query, _ in
            adds += 1
            let dictionary = query as NSDictionary
            accessibility = dictionary[kSecAttrAccessible] as? String
            synchronizable = dictionary[kSecAttrSynchronizable] as? Bool
            if addStatus == errSecSuccess {
                stored = dictionary[kSecValueData] as? Data
                readStatus = .init(errSecSuccess)
            }
            return addStatus
        }, update: { _, _ in Issue.record("Local bootstrap must not update an existing key"); return errSecUnimplemented })
    }
}

@Suite(.serialized) struct LocalNoticeBootstrapTests {
    private func path() throws -> URL {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent("remi-local-bootstrap-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return parent
    }

    @Test func unavailableProtectedDataAndLockedKeychainNeverCreateOrErase() throws {
        let dir = try path(); defer { try? FileManager.default.removeItem(at: dir) }
        let os = OwnedLocalKeychain(), key = LocalNoticeKeyStore(service: "synthetic", account: "one")
        #expect(throws: LocalNoticeBootstrap.Failure.locked) {
            try LocalNoticeBootstrap.open(directory: dir, sentinel: .absent, inventory: .noLocalMarkers,
                protectedDataAvailable: false, keyStore: key, operations: os.operations)
        }
        #expect(os.reads == 0 && os.adds == 0)
        os.readStatus = errSecInteractionNotAllowed
        #expect(throws: LocalNoticeBootstrap.Failure.locked) {
            try LocalNoticeBootstrap.open(directory: dir, sentinel: .absent, inventory: .noLocalMarkers,
                protectedDataAvailable: true, keyStore: key, operations: os.operations)
        }
        #expect(os.adds == 0)
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("local-notifications.sqlite").path))
    }

    @Test func missingKeyWithPriorEvidenceRequiresRecoveryWithoutCreation() throws {
        let dir = try path(); defer { try? FileManager.default.removeItem(at: dir) }
        let os = OwnedLocalKeychain(), key = LocalNoticeKeyStore(service: "synthetic", account: "one")
        for (sentinel, inventory) in [(LocalNoticeBootstrap.Sentinel.present, LocalNoticeBootstrap.Inventory.noLocalMarkers),
                                       (.absent, .localMarkersPresent), (.invalid, .noLocalMarkers)] {
            #expect(throws: LocalNoticeBootstrap.Failure.recoveryRequired) {
                try LocalNoticeBootstrap.open(directory: dir, sentinel: sentinel, inventory: inventory,
                    protectedDataAvailable: true, keyStore: key, operations: os.operations)
            }
        }
        let journal = dir.appendingPathComponent("local-notifications.sqlite"), original = Data("owned-sentinel".utf8)
        try original.write(to: journal)
        #expect(throws: LocalNoticeBootstrap.Failure.recoveryRequired) {
            try LocalNoticeBootstrap.open(directory: dir, sentinel: .absent, inventory: .noLocalMarkers,
                protectedDataAvailable: true, keyStore: key, operations: os.operations)
        }
        #expect(try Data(contentsOf: journal) == original)
        #expect(os.adds == 0)
    }

    @Test func freshCreationUsesDeviceOnlyNonSynchronizingKeyAndReopensWithoutRotation() throws {
        let dir = try path(); defer { try? FileManager.default.removeItem(at: dir) }
        let os = OwnedLocalKeychain(), key = LocalNoticeKeyStore(service: "synthetic", account: "one")
        let first = try LocalNoticeBootstrap.open(directory: dir, sentinel: .absent, inventory: .noLocalMarkers,
            protectedDataAvailable: true, keyStore: key, operations: os.operations)
        #expect(first.needsSentinel); #expect(os.adds == 1); #expect(os.stored?.count == 32)
        #expect(os.accessibility == (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String))
        #expect(os.synchronizable == false)
        let owner = UUID(), original = try first.keys.ownerIndex(runtimeOwner: owner)
        first.ledger.close()
        let second = try LocalNoticeBootstrap.open(directory: dir, sentinel: .present, inventory: .noLocalMarkers,
            protectedDataAvailable: true, keyStore: key, operations: os.operations)
        defer { second.ledger.close() }
        #expect(!second.needsSentinel); #expect(os.adds == 1)
        #expect(try second.keys.ownerIndex(runtimeOwner: owner) == original)
    }

    @Test func unavailableInventoryAndCorruptKeyDoNotBecomeFreshInstall() throws {
        let dir = try path(); defer { try? FileManager.default.removeItem(at: dir) }
        let os = OwnedLocalKeychain(), key = LocalNoticeKeyStore(service: "synthetic", account: "one")
        #expect(throws: LocalNoticeBootstrap.Failure.unavailable) {
            try LocalNoticeBootstrap.open(directory: dir, sentinel: .absent, inventory: .unavailable,
                protectedDataAvailable: true, keyStore: key, operations: os.operations)
        }
        #expect(os.reads == 0 && os.adds == 0)
        os.readStatus = errSecSuccess; os.stored = Data(count: 31)
        #expect(throws: LocalNoticeBootstrap.Failure.recoveryRequired) {
            try LocalNoticeBootstrap.open(directory: dir, sentinel: .absent, inventory: .noLocalMarkers,
                protectedDataAvailable: true, keyStore: key, operations: os.operations)
        }
        #expect(os.adds == 0)
    }
}
