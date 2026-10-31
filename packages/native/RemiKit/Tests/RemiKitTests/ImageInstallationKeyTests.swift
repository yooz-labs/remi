import Darwin
import Foundation
import Security
import Testing
@testable import RemiPush
@testable import RemiKit

/// Every Keychain item and directory here is UUID-owned by this fixture.
@Suite struct ImageInstallationKeyTests {
    private func withStore(operations: NativeKeychainOperations = .system,
                           _ body: (URL, ImageDirectoryLease, ImageInstallationKeyStore, [String: Any]) throws -> Void) throws {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent("remi-image-key-\(UUID().uuidString)")
        let root = parent.appendingPathComponent("images")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: parent) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let parentFD = open(parent.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        let rootFD = open(root.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard parentFD >= 0, rootFD >= 0 else { throw POSIXError(.EIO) }
        defer { close(parentFD); close(rootFD) }
        let service = "live.yooz.remi.tests.image-key.\(UUID().uuidString)"
        let account = UUID().uuidString
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account]
        defer {
            let status = SecItemDelete(query as CFDictionary)
            #expect(status == errSecSuccess || status == errSecItemNotFound)
        }
        let lease = try ImageDirectoryLease(parent: parentFD, rootName: "images", directory: rootFD)
        // The unsigned fixture redirects only the OS boundary to a UUID-owned Keychain slot;
        // signed app-group and ThisDeviceOnly behavior still require device acceptance.
        func redirected(_ input: CFDictionary) -> CFDictionary {
            var values = input as! [String: Any]
            values.removeValue(forKey: kSecAttrAccessGroup as String)
            #if os(macOS)
            values.removeValue(forKey: kSecUseDataProtectionKeychain as String)
            #endif
            return values as CFDictionary
        }
        let controlled = NativeKeychainOperations(copyMatching: { operations.copyMatching(redirected($0), $1) },
            add: { operations.add(redirected($0), $1) }, update: { operations.update(redirected($0), $1) })
        let store = ImageInstallationKeyStore(lease: lease, accessGroup: "owned-test-group", service: service,
                                              account: account, operations: controlled)
        try body(root, lease, store, query)
    }

    #if os(iOS)
    @Test func iOSCannotCreateImageKeyUntilProtectionIsQualified() throws {
        try withStore { _, _, store, _ in
            #expect(throws: ImageInstallationKeyStore.Failure.unavailable(errSecNotAvailable)) { try store.beginPending() }
            #expect(try store.load() == nil)
        }
    }
    #else
    @Test func pendingKeyIsCreatedOnceAndNeverRotatedAutomatically() throws {
        try withStore { _, _, store, _ in
            #expect(try store.load() == nil)
            let first = try store.beginPending()
            #expect(first.phase == .pending)
            #expect(first.secret.count == 32)
            #expect(try store.load() == first)
            #expect(throws: ImageInstallationKeyStore.Failure.alreadyExists) { try store.beginPending() }
            #expect(try store.load() == first)
        }
    }

    @Test func existingFilesPreventFreshInstallationWithoutDeletion() throws {
        try withStore { root, _, store, _ in
            let foreign = root.appendingPathComponent("unrelated")
            let marker = Data([1, 2, 3])
            try marker.write(to: foreign)
            #expect(throws: ImageInstallationKeyStore.Failure.notFresh) { try store.beginPending() }
            #expect(try store.load() == nil)
            #expect(try Data(contentsOf: foreign) == marker)
        }
    }

    @Test func missingKeyWithExistingJournalIsObservedLossNotFreshInstallation() throws {
        try withStore { root, _, store, _ in
            let journal = root.appendingPathComponent(".image-journal")
            let previousState = Data("prior state".utf8)
            try previousState.write(to: journal)
            #expect(try store.load() == nil)
            #expect(throws: ImageInstallationKeyStore.Failure.notFresh) { try store.beginPending() }
            #expect(try Data(contentsOf: journal) == previousState)
            #expect(try store.load() == nil)
        }
    }

    @Test func corruptExistingKeyIsNeverReplaced() throws {
        try withStore { _, _, store, query in
            let corrupt = Data("not an image key record".utf8)
            var item = query
            item[kSecValueData as String] = corrupt
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            #expect(SecItemAdd(item as CFDictionary, nil) == errSecSuccess)
            #expect(throws: ImageInstallationKeyStore.Failure.malformed) { try store.load() }
            #expect(throws: ImageInstallationKeyStore.Failure.malformed) { try store.beginPending() }
            var read = query
            read[kSecReturnData as String] = true
            var returned: CFTypeRef?
            #expect(SecItemCopyMatching(read as CFDictionary, &returned) == errSecSuccess)
            #expect(returned as? Data == corrupt)
        }
    }

    @Test func unavailableKeychainNeverTriggersCreation() throws {
        var operations = NativeKeychainOperations.system
        var adds = 0
        operations.copyMatching = { _, _ in errSecInteractionNotAllowed }
        operations.add = { _, _ in adds += 1; return errSecSuccess }
        try withStore(operations: operations) { _, _, store, _ in
            #expect(throws: ImageInstallationKeyStore.Failure.unavailable(errSecInteractionNotAllowed)) { try store.load() }
            #expect(throws: ImageInstallationKeyStore.Failure.unavailable(errSecInteractionNotAllowed)) { try store.beginPending() }
            #expect(adds == 0)
        }
    }

    @Test func freshInstallationIsPromotedOnlyAfterMarkerAndJournalExist() throws {
        try withStore { root, lease, store, _ in
            let owner = try ImageInstallationOwner.open(lease: lease, keys: store)
            let loaded = try store.load()
            let record = try #require(loaded)
            #expect(record.phase == .ready)
            #expect(owner.journal.snapshot.records.isEmpty)
            #expect(FileManager.default.fileExists(atPath: root.appendingPathComponent(".image-installation").path))
            #expect(FileManager.default.fileExists(atPath: root.appendingPathComponent(".image-journal").path))
        }
    }

    @Test func pendingInitializationCanResumeButUnknownMarkerIsPreserved() throws {
        try withStore { _, lease, store, _ in
            let pending = try store.beginPending()
            let owner = try ImageInstallationOwner.open(lease: lease, keys: store)
            #expect(owner.journal.snapshot.records.isEmpty)
            let loaded = try store.load()
            let ready = try #require(loaded)
            #expect(ready.phase == .ready && ready.installation == pending.installation && ready.secret == pending.secret)
        }
        try withStore { root, lease, store, _ in
            let pending = try store.beginPending()
            let marker = root.appendingPathComponent(".image-installation")
            let unknown = Data("unknown".utf8)
            try unknown.write(to: marker)
            #expect(chmod(marker.path, 0o600) == 0)
            #expect(throws: (any Error).self) { try ImageInstallationOwner.open(lease: lease, keys: store) }
            #expect(try store.load() == pending)
            #expect(try Data(contentsOf: marker) == unknown)
        }
    }

    @Test func missingJournalOrKeyAfterInitializationNeverCreatesAReplacement() throws {
        try withStore { root, lease, store, _ in
            _ = try ImageInstallationOwner.open(lease: lease, keys: store)
            let loaded = try store.load()
            let ready = try #require(loaded)
            #expect(unlink(root.appendingPathComponent(".image-journal").path) == 0)
            #expect(throws: (any Error).self) { try ImageInstallationOwner.open(lease: lease, keys: store) }
            #expect(try store.load() == ready)
            #expect(FileManager.default.fileExists(atPath: root.appendingPathComponent(".image-installation").path))
        }
        try withStore { root, lease, store, query in
            _ = try ImageInstallationOwner.open(lease: lease, keys: store)
            #expect(SecItemDelete(query as CFDictionary) == errSecSuccess)
            #expect(throws: (any Error).self) { try ImageInstallationOwner.open(lease: lease, keys: store) }
            #expect(try store.load() == nil)
            #expect(FileManager.default.fileExists(atPath: root.appendingPathComponent(".image-journal").path))
        }
    }

    @Test func reopensInterruptedReservationWithoutRestoringCopyAuthority() throws {
        try withStore { _, lease, store, _ in
            let first = try ImageInstallationOwner.open(lease: lease, keys: store)
            let id = try first.journal.reserveCopy()
            let reopened = try ImageInstallationOwner.open(lease: lease, keys: store)
            #expect(reopened.journal.snapshot.localSnapshotID == id)
            #expect(reopened.journal.snapshot.records.first?.exposure == .copyOrphaned)
            try reopened.snapshots.abandon(id: id, confirmed: true)
            #expect(reopened.journal.snapshot.records.isEmpty)
        }
    }

    @Test func unavailablePromotionLeavesPendingStateAndCanResumeSafely() throws {
        let system = NativeKeychainOperations.system
        var operations = system
        var first = true
        operations.update = { query, values in
            if first { first = false; return errSecNotAvailable }
            return system.update(query, values)
        }
        try withStore(operations: operations) { root, lease, store, _ in
            #expect(throws: (any Error).self) { try ImageInstallationOwner.open(lease: lease, keys: store) }
            let loadedPending = try store.load()
            let pending = try #require(loadedPending)
            #expect(pending.phase == .pending)
            #expect(FileManager.default.fileExists(atPath: root.appendingPathComponent(".image-journal").path))
            let reopened = try ImageInstallationOwner.open(lease: lease, keys: store)
            #expect(reopened.journal.snapshot.records.isEmpty)
            let loadedReady = try store.load()
            let ready = try #require(loadedReady)
            #expect(ready.phase == .ready && ready.installation == pending.installation)
        }
    }

    @Test func uncommittedPromotionCannotCreateReadyAuthority() throws {
        var operations = NativeKeychainOperations.system
        operations.update = { _, _ in errSecSuccess }
        try withStore(operations: operations) { root, lease, store, _ in
            #expect(throws: (any Error).self) { try ImageInstallationOwner.open(lease: lease, keys: store) }
            let loaded = try store.load()
            let record = try #require(loaded)
            #expect(record.phase == .pending)
            #expect(FileManager.default.fileExists(atPath: root.appendingPathComponent(".image-journal").path))
        }
    }

    @Test func malformedSuccessfulKeychainReadNeverTriggersCreation() throws {
        var operations = NativeKeychainOperations.system
        var adds = 0
        operations.copyMatching = { _, _ in errSecSuccess }
        operations.add = { _, _ in adds += 1; return errSecSuccess }
        try withStore(operations: operations) { _, _, store, _ in
            #expect(throws: ImageInstallationKeyStore.Failure.malformed) { try store.load() }
            #expect(throws: ImageInstallationKeyStore.Failure.malformed) { try store.beginPending() }
            #expect(adds == 0)
        }
    }

    @Test func unknownReadyStateIsPreservedAndBlocksAdoption() throws {
        try withStore { root, lease, store, _ in
            _ = try ImageInstallationOwner.open(lease: lease, keys: store)
            let loaded = try store.load()
            let before = try #require(loaded)
            let foreign = root.appendingPathComponent("unrelated")
            let bytes = Data([9, 8, 7])
            try bytes.write(to: foreign)
            #expect(throws: ImageInstallationOwner.Failure.recoveryRequired) { try ImageInstallationOwner.open(lease: lease, keys: store) }
            #expect(try store.load() == before)
            #expect(try Data(contentsOf: foreign) == bytes)
        }
    }

    @Test func pendingKeyCannotAdoptNonemptyJournal() throws {
        try withStore { root, lease, store, _ in
            let pending = try store.beginPending()
            let marker = root.appendingPathComponent(".image-installation")
            try Data("remi-image-installation-v1:\(pending.installation)\n".utf8).write(to: marker)
            #expect(chmod(marker.path, 0o600) == 0)
            let disk = ImageJournalDisk(lease: lease, secret: pending.secret)
            try disk.initializeIfProvenFresh(ImageRecoveryLedger().encodeJournal(secret: pending.secret))
            let owner = try ImageRecoveryJournal(disk: disk, secret: pending.secret)
            _ = try owner.reserveCopy()
            #expect(throws: ImageInstallationOwner.Failure.recoveryRequired) { try ImageInstallationOwner.open(lease: lease, keys: store) }
            #expect(try store.load() == pending)
        }
    }
    #endif
}
