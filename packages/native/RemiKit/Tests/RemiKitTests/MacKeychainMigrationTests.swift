import CryptoKit
import Foundation
import Security
import Testing
@testable import RemiKit
@testable import RemiPush

#if os(macOS)
/// The unsigned package cannot claim the team's groups. Only the OS boundary
/// redirects queries to two UUID-owned file-Keychain slots; codecs, leases,
/// migration and refusal logic remain real. Signed probes cover OS isolation.
private final class OwnedMacKeychainPair {
    let context: OwnedIdentityContext
    let group = "9DQ459HAZB.live.yooz.remi.dev"
    var legacyReads = 0
    init() throws { context = try OwnedIdentityContext() }
    var service: String { context.service }
    var account: String { context.account }
    var operations: NativeKeychainOperations {
        .init(copyMatching: { query, output in
            let values = query as! [String: Any]
            if values[kSecUseDataProtectionKeychain as String] as? Bool != true { self.legacyReads += 1 }
            return SecItemCopyMatching(self.redirect(query), output)
        }, add: { SecItemAdd(self.redirect($0), $1) }, update: { SecItemUpdate(self.redirect($0), $1) })
    }
    private func redirect(_ query: CFDictionary) -> CFDictionary {
        var values = query as! [String: Any]
        if values[kSecUseDataProtectionKeychain as String] as? Bool == true {
            values[kSecAttrService as String] = service + ".owned-dp"
        }
        values.removeValue(forKey: kSecUseDataProtectionKeychain as String)
        values.removeValue(forKey: kSecAttrAccessGroup as String)
        return values as CFDictionary
    }
    private func query(dp: Bool) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service + (dp ? ".owned-dp" : ""),
         kSecAttrAccount as String: account]
    }
    func write(_ data: Data, dp: Bool) throws {
        var values = query(dp: dp); values[kSecValueData as String] = data
        values[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        #expect(SecItemAdd(values as CFDictionary, nil) == errSecSuccess)
    }
    func bytes(dp: Bool) throws -> Data {
        var values = query(dp: dp); values[kSecReturnData as String] = true
        var output: CFTypeRef?
        #expect(SecItemCopyMatching(values as CFDictionary, &output) == errSecSuccess)
        return try #require(output as? Data)
    }
    func replaceLegacy(_ data: Data) throws {
        #expect(SecItemUpdate(query(dp: false) as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecSuccess)
    }
    func cleanup() {
        SecItemDelete(query(dp: true) as CFDictionary)
        try? context.cleanup()
    }
    func load() throws -> ClientIdentity {
        try NativeIdentityRecordStore.loadOrCreate(authority: NativePushAuthorityAdapter(context.push),
            accessGroup: group, service: service, account: account, operations: operations)
    }
    func current() throws -> ClientIdentity? {
        try NativeIdentityRecordStore.currentRecord(accessGroup: group, service: service, account: account, operations: operations)
    }
}

struct MacKeychainMigrationTests {
    @Test func coldReadDoesNotFallBackToOrMigrateLegacy() throws {
        let pair = try OwnedMacKeychainPair(); defer { pair.cleanup() }
        let legacy = ClientIdentity().rawPrivateKey
        try pair.write(legacy, dp: false)
        #expect(try pair.current() == nil)
        #expect(pair.legacyReads == 0)
        #expect(try pair.bytes(dp: false) == legacy)
    }

    @Test func rawSeedCopiesInwardAndSurvivesLegacyReplacement() throws {
        let pair = try OwnedMacKeychainPair(); defer { pair.cleanup() }
        let original = ClientIdentity()
        try pair.write(original.rawPrivateKey, dp: false)
        let migrated = try pair.load()
        #expect(migrated.publicKeyRaw == original.publicKeyRaw)
        #expect(try pair.bytes(dp: false) == original.rawPrivateKey)
        #expect(try pair.current()?.publicKeyRaw == original.publicKeyRaw)
        try pair.replaceLegacy(ClientIdentity().rawPrivateKey)
        #expect(try pair.current()?.publicKeyRaw == original.publicKeyRaw)
        #expect(try pair.load().publicKeyRaw == original.publicKeyRaw)
    }

    @Test func versionedRecordBytesRevisionAndProtectionAreCopied() throws {
        let pair = try OwnedMacKeychainPair(); defer { pair.cleanup() }
        let original = ClientIdentity(), revision = UUID().uuidString
        let bytes = try pair.context.record(identity: original, revision: revision, protected: true)
        try pair.write(bytes, dp: false)
        let migrated = try pair.load()
        #expect(migrated.publicKeyRaw == original.publicKeyRaw)
        #expect(migrated.revision == revision && migrated.requiresAppUnlock)
        #expect(try pair.bytes(dp: true) == bytes)
        #expect(try pair.bytes(dp: false) == bytes)
    }

    @Test func existingDestinationWinsWithoutConsultingLegacy() throws {
        let pair = try OwnedMacKeychainPair(); defer { pair.cleanup() }
        let legacy = ClientIdentity(), current = ClientIdentity()
        let bytes = try pair.context.record(identity: current, revision: current.revision, protected: false)
        try pair.write(legacy.rawPrivateKey, dp: false); try pair.write(bytes, dp: true)
        #expect(try pair.load().publicKeyRaw == current.publicKeyRaw)
        #expect(pair.legacyReads == 0)
        #expect(try pair.bytes(dp: false) == legacy.rawPrivateKey)
    }

    @Test func corruptLegacyFailsWithoutCreatingDestination() throws {
        let pair = try OwnedMacKeychainPair(); defer { pair.cleanup() }
        let bytes = Data("corrupt-owned-record".utf8)
        try pair.write(bytes, dp: false)
        #expect(throws: (any Error).self) { try pair.load() }
        #expect(try pair.current() == nil)
        #expect(try pair.bytes(dp: false) == bytes)
    }

    @Test func corruptDestinationDoesNotFallBackToValidLegacy() throws {
        let pair = try OwnedMacKeychainPair(); defer { pair.cleanup() }
        let legacy = ClientIdentity().rawPrivateKey, corrupt = Data("owned-corrupt-destination".utf8)
        try pair.write(legacy, dp: false); try pair.write(corrupt, dp: true)
        #expect(throws: (any Error).self) { try pair.load() }
        #expect(pair.legacyReads == 0)
        #expect(try pair.bytes(dp: true) == corrupt && pair.bytes(dp: false) == legacy)
    }

    @Test func failedDestinationWritePreservesTheLegacyRecord() throws {
        let pair = try OwnedMacKeychainPair(); defer { pair.cleanup() }
        let bytes = ClientIdentity().rawPrivateKey
        try pair.write(bytes, dp: false)
        var operations = pair.operations
        operations.add = { _, _ in errSecNotAvailable }
        #expect(throws: (any Error).self) {
            try NativeIdentityRecordStore.loadOrCreate(authority: NativePushAuthorityAdapter(pair.context.push),
                accessGroup: pair.group, service: pair.service, account: pair.account, operations: operations)
        }
        #expect(try pair.current() == nil)
        #expect(try pair.bytes(dp: false) == bytes)
    }

    @Test func destinationCreatedDuringPreparationWins() throws {
        let pair = try OwnedMacKeychainPair(); defer { pair.cleanup() }
        let winner = ClientIdentity()
        let bytes = try pair.context.record(identity: winner, revision: winner.revision, protected: false)
        try pair.write(ClientIdentity().rawPrivateKey, dp: false)
        let original = pair.operations
        var operations = original, reads = 0
        operations.copyMatching = { query, output in
            if (query as! [String: Any])[kSecUseDataProtectionKeychain as String] as? Bool == true {
                reads += 1
                if reads == 2 { try? pair.write(bytes, dp: true) }
            }
            return original.copyMatching(query, output)
        }
        let actual = try NativeIdentityRecordStore.loadOrCreate(authority: NativePushAuthorityAdapter(pair.context.push),
            accessGroup: pair.group, service: pair.service, account: pair.account, operations: operations)
        #expect(actual.publicKeyRaw == winner.publicKeyRaw)
        #expect(try pair.bytes(dp: true) == bytes)
    }

    @Test func recipientColdReadAndCopyPreserveKeyVersion() throws {
        let pair = try OwnedMacKeychainPair(); defer { pair.cleanup() }
        let legacy = NativePushKeyStore(service: pair.service, account: pair.account, accessGroup: nil, operations: pair.operations)
        let original = try legacy.loadOrCreate()
        let bytes = try pair.bytes(dp: false)
        pair.legacyReads = 0
        let current = NativePushKeyStore(service: pair.service, account: pair.account,
            accessGroup: "9DQ459HAZB.live.yooz.remi.secure-push", operations: pair.operations)
        #expect(try current.load() == nil)
        #expect(pair.legacyReads == 0)
        let copied = try current.loadOrCreate()
        #expect(copied.publicKey == original.publicKey && copied.keyVersion == original.keyVersion)
        #expect(try pair.bytes(dp: true) == bytes && pair.bytes(dp: false) == bytes)
    }
}
#endif
