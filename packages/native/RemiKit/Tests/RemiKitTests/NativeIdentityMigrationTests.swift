import CryptoKit
import Foundation
import Security
import Testing
import RemiPush
@testable import RemiKit

struct OwnedIdentityContext {
    let directory: URL
    let push: RemiPushStore
    let service = "live.yooz.remi.tests.identity.\(UUID().uuidString)"
    let account = UUID().uuidString
    var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service, kSecAttrAccount as String: account] }
    var store: ClientIdentityStore { .init(service: service, account: account, pushStore: push) }
    init() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-x2-identity-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        push = try .ownedTestStore(file: directory.appendingPathComponent("public.sqlite"),
            service: "live.yooz.remi.tests.recipient.\(UUID().uuidString)", account: UUID().uuidString)
    }
    func write(_ data: Data) throws {
        var item = query; item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        #expect(SecItemAdd(item as CFDictionary, nil) == errSecSuccess)
    }
    func bytes() throws -> Data {
        var request = query; request[kSecReturnData as String] = true
        var result: CFTypeRef?
        #expect(SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess)
        return try #require(result as? Data)
    }
    func cleanup() throws { SecItemDelete(query as CFDictionary); try FileManager.default.removeItem(at: directory) }
    func record(identity: ClientIdentity, revision: String, protected: Bool) throws -> Data {
        struct Record: Encodable {
            let version: Int; let pkcs8: Data; let publicKey: Data; let revision: String; let requiresAppUnlock: Bool
        }
        return try JSONEncoder().encode(Record(version: 2, pkcs8: Ed25519PKCS8.encode(identity.privateKey),
            publicKey: identity.publicKeyRaw, revision: revision, requiresAppUnlock: protected))
    }
}

struct NativeIdentityMigrationTests {
    @Test func legacyVersionTwoBytesRevisionAndProtectionSurviveRead() throws {
        let context = try OwnedIdentityContext(); defer { try? context.cleanup() }
        let original = ClientIdentity(); let revision = UUID().uuidString
        let bytes = try context.record(identity: original, revision: revision, protected: true)
        try context.write(bytes)
        let restored = try context.store.loadOrCreate()
        #expect(restored.publicKeyRaw == original.publicKeyRaw)
        #expect(restored.revision == revision)
        #expect(restored.requiresAppUnlock)
        #expect(try context.bytes() == bytes)
        #expect(throws: (any Error).self) { try restored.signature(for: Data("background H2".utf8)) }
        #expect(try context.push.authority() == nil, "Reading legacy JSON never restores capsule authority")
    }

    @Test func malformedSuccessfulKeychainReadNeverReplacesTheItem() throws {
        let context = try OwnedIdentityContext(); defer { try? context.cleanup() }
        let corrupt = Data("{\"version\":2,\"revision\":\"invalid\"}".utf8)
        try context.write(corrupt)
        #expect(throws: (any Error).self) { try context.store.loadOrCreate() }
        #expect(try context.bytes() == corrupt)
    }

    @Test func rawSeedMigrationUpdatesWithoutChangingDeviceKey() throws {
        let context = try OwnedIdentityContext(); defer { try? context.cleanup() }
        let original = ClientIdentity()
        try context.write(original.rawPrivateKey)
        let migrated = try context.store.loadOrCreate()
        #expect(migrated.publicKeyRaw == original.publicKeyRaw)
        #expect(try context.bytes().count != 32)
        #expect(try context.store.loadOrCreate().revision == migrated.revision)
        #expect(try context.push.authority() == migrated.pushAuthority)
        #expect(try context.push.generation() > 0)
    }

    @Test func cachedSignerRefusesDeletedPrivateRecordWithoutCreatingOne() throws {
        let context = try OwnedIdentityContext(); defer { try? context.cleanup() }
        let cached = try context.store.loadOrCreate()
        #expect(SecItemDelete(context.query as CFDictionary) == errSecSuccess)
        #expect(throws: (any Error).self) { try cached.signature(for: Data("Worker admission".utf8)) }
        #expect(try context.store.load() == nil)
        #expect(try context.push.authority() == nil)
    }

    @Test func cachedSignerRechecksRevisionAndProtectionBeforeEverySignature() throws {
        let context = try OwnedIdentityContext(); defer { try? context.cleanup() }
        let cached = try context.store.loadOrCreate()
        _ = try cached.signature(for: Data("Worker admission".utf8))
        let changed = try context.record(identity: cached, revision: UUID().uuidString, protected: true)
        #expect(SecItemUpdate(context.query as CFDictionary, [kSecValueData as String: changed] as CFDictionary) == errSecSuccess)
        #expect(throws: (any Error).self) { try cached.signature(for: Data("H2 after await".utf8)) }
        #expect(throws: (any Error).self) { try cached.signature(for: Data("native answer".utf8)) }
        #expect(try context.bytes() == changed)
        // The signer is load-only. The owning coordinator reconciles observations.
        #expect(try context.push.authority() == cached.pushAuthority)
    }

    @Test func signerNeverMigratesRawReplacementOrMutatesPublicAuthority() throws {
        let context = try OwnedIdentityContext(); defer { try? context.cleanup() }
        let cached = try context.store.loadOrCreate()
        let generation = try context.push.generation()
        let bytes = cached.rawPrivateKey
        #expect(SecItemUpdate(context.query as CFDictionary, [kSecValueData as String: bytes] as CFDictionary) == errSecSuccess)
        #expect(throws: (any Error).self) { try cached.signature(for: Data("background admission".utf8)) }
        #expect(try context.bytes() == bytes)
        #expect(try context.push.authority() == cached.pushAuthority)
        #expect(try context.push.generation() == generation)
    }
}
