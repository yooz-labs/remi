import Darwin
import Foundation
import Security
import Testing
@testable import RemiPush
@testable import RemiKit

/// Every Keychain item and directory here is UUID-owned by this fixture.
@Suite struct ImageInstallationKeyTests {
    private func withStore(operations: NativeKeychainOperations = .system,
                           _ body: (URL, ImageInstallationKeyStore, [String: Any]) throws -> Void) throws {
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
        defer { SecItemDelete(query as CFDictionary) }
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
        try body(root, store, query)
    }

    #if os(iOS)
    @Test func iOSCannotCreateImageKeyUntilProtectionIsQualified() throws {
        try withStore { _, store, _ in
            #expect(throws: ImageInstallationKeyStore.Failure.unavailable(errSecNotAvailable)) { try store.beginPending() }
            #expect(try store.load() == nil)
        }
    }
    #else
    @Test func pendingKeyIsCreatedOnceAndNeverRotatedAutomatically() throws {
        try withStore { _, store, _ in
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
        try withStore { root, store, _ in
            let foreign = root.appendingPathComponent("unrelated")
            let marker = Data([1, 2, 3])
            try marker.write(to: foreign)
            #expect(throws: ImageInstallationKeyStore.Failure.notFresh) { try store.beginPending() }
            #expect(try store.load() == nil)
            #expect(try Data(contentsOf: foreign) == marker)
        }
    }

    @Test func corruptExistingKeyIsNeverReplaced() throws {
        try withStore { _, store, query in
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
        try withStore(operations: operations) { _, store, _ in
            #expect(throws: ImageInstallationKeyStore.Failure.unavailable(errSecInteractionNotAllowed)) { try store.load() }
            #expect(throws: ImageInstallationKeyStore.Failure.unavailable(errSecInteractionNotAllowed)) { try store.beginPending() }
            #expect(adds == 0)
        }
    }
    #endif
}
