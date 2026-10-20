import CryptoKit
import Foundation
import Security
import XCTest

final class NativeIdentityAuthorityTests: XCTestCase {
    private var service = ""
    private let account = "device-key"
    private var directory: URL!
    private var state: NativePushState!
    override func setUpWithError() throws {
        service = "live.yooz.remi.tests.authority-" + UUID().uuidString
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi1200-authority-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        state = try NativePushState(file: directory.appendingPathComponent("push.sqlite"))
    }
    override func tearDownWithError() throws {
        ClientIdentityStore.resetForTesting(service: service, account: account)
        state = nil
        if let directory { try FileManager.default.removeItem(at: directory) }
    }
    private func original() throws -> ClientIdentity {
        let identity = try ClientIdentityStore.loadOrCreate(authority: state, accessGroup: nil, service: service, account: account)
        // Install the prior public authority through the actual production lease.
        // This preparation also works before the newly pinned store wiring exists.
        let lease = try state.acquireIdentityMutation()
        defer { lease.release() }
        let generation = try lease.invalidateIdentityAuthority()
        try lease.installIdentityAuthority(publicKey: identity.publicKeyRaw, revision: identity.revision, requiresAppUnlock: false, generation: generation)
        return identity
    }
    private func assertAuthorityClosed(_ message: String) {
        do { let value = try state.currentAuthority(); XCTAssertNil(value, message) }
        catch { XCTFail("Reading the actual durable authority failed") }
    }
    private func replacement(_ original: ClientIdentity, operations: NativeKeychainOperations) throws -> ClientIdentity {
        let incoming = ClientIdentity(privateKey: .init())
        return try ClientIdentityStore.importIdentity(authority: state, accessGroup: nil,
            pkcs8: Ed25519PKCS8.encode(incoming.privateKey), publicKey: incoming.publicKeyRaw,
            replacing: original.revision, service: service, account: account, operations: operations)
    }

    func testActualIdentityReplacementInvalidatesBeforeKeychainMutation() throws {
        let prior = try original()
        var operations = NativeKeychainOperations.system
        operations.update = { query, value in
            self.assertAuthorityClosed("Durable authority must close BEFORE actual Keychain replacement")
            return SecItemUpdate(query, value)
        }
        let replaced = try replacement(prior, operations: operations)
        XCTAssertEqual(try state.currentAuthority(), .init(publicKey: replaced.publicKeyRaw, revision: replaced.revision, requiresAppUnlock: false))
    }

    func testBusyInvalidationBlocksKeychainReplacementAndPreservesOriginal() throws {
        let prior = try original()
        let held = try state.acquireIdentityMutation()
        defer { held.release() }
        var operations = NativeKeychainOperations.system
        var writes = 0
        operations.update = { query, value in writes += 1; return SecItemUpdate(query, value) }
        XCTAssertThrowsError(try replacement(prior, operations: operations), "Busy authority must refuse BEFORE writing an identity")
        XCTAssertEqual(writes, 0)
        XCTAssertEqual(try ClientIdentityStore.load(authority: state, accessGroup: nil, service: service, account: account)?.revision, prior.revision)
        XCTAssertEqual(try state.currentAuthority(), .init(publicKey: prior.publicKeyRaw, revision: prior.revision, requiresAppUnlock: false))
    }

    func testKeychainFailurePreservesOldKeyAndLeavesAuthorityInvalidated() throws {
        let prior = try original()
        var operations = NativeKeychainOperations.system
        operations.update = { _, _ in errSecIO }
        XCTAssertThrowsError(try replacement(prior, operations: operations))
        XCTAssertEqual(try ClientIdentityStore.load(authority: state, accessGroup: nil, service: service, account: account)?.revision, prior.revision)
        XCTAssertNil(try state.currentAuthority(), "A failed key write cannot reinstall the older authority")
    }

    func testProtectionRevisionUsesTheSameDurableBarrier() throws {
        let prior = try original()
        var operations = NativeKeychainOperations.system
        operations.update = { query, value in
            self.assertAuthorityClosed("Protection revision must invalidate BEFORE the actual write")
            return SecItemUpdate(query, value)
        }
        let protected = try ClientIdentityStore.requireAppUnlock(authority: state, accessGroup: nil,
            revision: prior.revision, publicKey: prior.publicKeyRaw, service: service, account: account, operations: operations)
        XCTAssertTrue(protected.requiresAppUnlock)
        XCTAssertNotEqual(protected.revision, prior.revision)
        XCTAssertEqual(try state.currentAuthority(), .init(publicKey: protected.publicKeyRaw, revision: protected.revision, requiresAppUnlock: true))
    }

    func testActualNativeSeedMigrationInvalidatesBeforeAtomicUpdate() throws {
        let legacy = Curve25519.Signing.PrivateKey()
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account,
            kSecValueData as String: legacy.rawRepresentation]
        XCTAssertEqual(SecItemAdd(query as CFDictionary, nil), errSecSuccess)
        let lease = try state.acquireIdentityMutation()
        let token = try lease.invalidateIdentityAuthority()
        try lease.installIdentityAuthority(publicKey: legacy.publicKey.rawRepresentation, revision: UUID().uuidString, requiresAppUnlock: false, generation: token)
        lease.release()
        var operations = NativeKeychainOperations.system
        operations.update = { query, value in
            self.assertAuthorityClosed("Legacy seed migration must close authority before actual atomic update")
            return SecItemUpdate(query, value)
        }
        let migrated = try XCTUnwrap(ClientIdentityStore.load(authority: state, accessGroup: nil, service: service, account: account, operations: operations))
        XCTAssertEqual(migrated.publicKeyRaw, legacy.publicKey.rawRepresentation)
        XCTAssertEqual(try state.currentAuthority(), .init(publicKey: migrated.publicKeyRaw, revision: migrated.revision, requiresAppUnlock: false))
    }

    func testActualDirectPreferencesImportUsesBarrierAndPreservesSignedWire() throws {
        let suite = "remi1200-direct-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let legacy = Curve25519.Signing.PrivateKey()
        let record = ["seed": legacy.rawRepresentation.base64EncodedString(),
                      "publicKey": legacy.publicKey.rawRepresentation.base64EncodedString()]
        defaults.set(String(data: try JSONSerialization.data(withJSONObject: record), encoding: .utf8),
                     forKey: "CapacitorStorage.remi-native-identity")
        let message = "session|question|no"
        let auth = try XCTUnwrap(RemiNativeStore.sign(message: message, accessGroup: nil, defaults: defaults,
            service: service, account: account, authority: state))
        let signature = try XCTUnwrap(Data(base64Encoded: auth.signature))
        XCTAssertTrue(legacy.publicKey.isValidSignature(signature, for: Data(message.utf8)))
        let imported = try XCTUnwrap(ClientIdentityStore.load(authority: state, accessGroup: nil, service: service, account: account))
        XCTAssertEqual(try state.currentAuthority(), .init(publicKey: imported.publicKeyRaw, revision: imported.revision, requiresAppUnlock: false),
                       "The actual direct legacy signer must publish only its durably verified identity")
    }

    private var itemQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    private func externalRecord(_ identity: ClientIdentity) throws -> Data {
        struct Record: Encodable {
            let version: Int; let pkcs8: Data; let publicKey: Data; let revision: String; let requiresAppUnlock: Bool
        }
        return try JSONEncoder().encode(Record(version: 2, pkcs8: Ed25519PKCS8.encode(identity.privateKey),
            publicKey: identity.publicKeyRaw, revision: identity.revision, requiresAppUnlock: identity.requiresAppUnlock))
    }

    func testReadOnlyObservationClosesExternalReplacementWithoutRestoringAuthority() throws {
        _ = try original()
        let external = ClientIdentity(privateKey: .init())
        let bytes = try externalRecord(external)
        XCTAssertEqual(SecItemUpdate(itemQuery as CFDictionary, [kSecValueData as String: bytes] as CFDictionary), errSecSuccess)
        let observed = try XCTUnwrap(ClientIdentityStore.load(authority: state, accessGroup: nil, service: service, account: account))
        XCTAssertEqual(observed.revision, external.revision)
        XCTAssertNil(try state.currentAuthority(), "An observed external revision must close prior public authority")
        _ = try ClientIdentityStore.load(authority: state, accessGroup: nil, service: service, account: account)
        XCTAssertNil(try state.currentAuthority(), "A read cannot install the replacement authority implicitly")
    }

    func testReadOnlyDeletionObservationClosesAuthorityWithoutCreatingKey() throws {
        _ = try original()
        XCTAssertEqual(SecItemDelete(itemQuery as CFDictionary), errSecSuccess)
        XCTAssertNil(try ClientIdentityStore.load(authority: state, accessGroup: nil, service: service, account: account))
        XCTAssertNil(try state.currentAuthority(), "An observed deleted private record must close public authority")
    }

    func testReadOnlyCorruptionObservationClosesAuthorityAndPreservesRecord() throws {
        _ = try original()
        let corrupt = Data("corrupt owned key record".utf8)
        XCTAssertEqual(SecItemUpdate(itemQuery as CFDictionary, [kSecValueData as String: corrupt] as CFDictionary), errSecSuccess)
        XCTAssertThrowsError(try ClientIdentityStore.load(authority: state, accessGroup: nil, service: service, account: account))
        XCTAssertNil(try state.currentAuthority(), "An observed corrupt private record must close public authority")
        var query = itemQuery
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &result), errSecSuccess)
        XCTAssertEqual(result as? Data, corrupt)
    }

    func testReadErrorClosesAuthorityButLaterReadsCannotRestoreIt() throws {
        let prior = try original()
        var operations = NativeKeychainOperations.system
        operations.copyMatching = { _, _ in errSecAuthFailed }
        XCTAssertThrowsError(try ClientIdentityStore.load(authority: state, accessGroup: nil,
            service: service, account: account, operations: operations))
        XCTAssertNil(try state.currentAuthority(), "An unavailable private record cannot retain public push authority")
        XCTAssertEqual(try ClientIdentityStore.load(authority: state, accessGroup: nil, service: service, account: account)?.revision, prior.revision)
        XCTAssertNil(try state.currentAuthority(), "A successful later read cannot reopen authority implicitly")
    }


    func testObservedProtectionChangeAtSameRevisionClosesAuthority() throws {
        let prior = try original()
        let protected = ClientIdentity(privateKey: prior.privateKey, revision: prior.revision, requiresAppUnlock: true)
        let record = try externalRecord(protected)
        XCTAssertEqual(SecItemUpdate(itemQuery as CFDictionary, [kSecValueData as String: record] as CFDictionary), errSecSuccess)
        let observed = try XCTUnwrap(ClientIdentityStore.load(authority: state, accessGroup: nil, service: service, account: account))
        XCTAssertTrue(observed.requiresAppUnlock)
        XCTAssertNil(try state.currentAuthority(), "Observed protection policy is part of the public authority context")
    }

}
