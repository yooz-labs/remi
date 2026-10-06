import CryptoKit
import Foundation
import Security
import XCTest

final class NativePushKeyStoreTests: XCTestCase {
    private var service = ""
    private let account = "push-p256"
    override func setUp() { service = "live.yooz.remi.tests.push-" + UUID().uuidString }
    override func tearDown() {
        SecItemDelete(query as CFDictionary)
        var secondary = query
        secondary[kSecAttrService as String] = service + ".secondary"
        SecItemDelete(secondary as CFDictionary)
    }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    private func store(operations: NativeKeychainOperations = .system) -> NativePushKeyStore {
        NativePushKeyStore(service: service, account: account, accessGroup: nil, operations: operations)
    }
    private func bytes() throws -> Data {
        var q = query
        q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(q as CFDictionary, &result), errSecSuccess)
        return try XCTUnwrap(result as? Data)
    }

    func testActualKeychainPushKeyPersistsEngineDERAndPublicPoint() throws {
        var key: NativePushKeyStore.Key?
        XCTAssertNoThrow(key = try store().loadOrCreate(), "Native P256 creation must persist a durable Keychain record")
        guard let key else { XCTFail("The actual native provider did not return its durable key"); return }
        let second = try store().loadOrCreate()
        XCTAssertEqual(second.publicKey, key.publicKey)
        XCTAssertEqual(second.keyVersion, 1)
        XCTAssertEqual(second.publicKey.count, 65)
        let record = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes()) as? [String: Any])
        XCTAssertEqual(Set(record.keys), Set(["version", "privateDER", "publicKey", "keyVersion"]))
        let der = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(record["privateDER"] as? String)))
        XCTAssertEqual(try P256.KeyAgreement.PrivateKey(derRepresentation: der).publicKey.x963Representation, key.publicKey)
        let peer = P256.KeyAgreement.PrivateKey()
        let a = try key.privateKey.sharedSecretFromKeyAgreement(with: peer.publicKey).withUnsafeBytes { Data($0) }
        let b = try peer.sharedSecretFromKeyAgreement(with: key.privateKey.publicKey).withUnsafeBytes { Data($0) }
        XCTAssertEqual(a, b, "The real engine ECDH must agree after durable key restoration")
    }

    func testReadFailurePreservesExistingPushKeyWithoutCreation() throws {
        var created: NativePushKeyStore.Key?
        XCTAssertNoThrow(created = try store().loadOrCreate())
        guard created != nil else { XCTFail("Read-failure pin requires actual durable initial key"); return }
        let original = try bytes()
        var operations = NativeKeychainOperations.system
        operations.copyMatching = { _, _ in errSecAuthFailed }
        var additions = 0
        operations.add = { _, _ in additions += 1; return errSecAuthFailed }
        XCTAssertThrowsError(try store(operations: operations).loadOrCreate())
        XCTAssertEqual(additions, 0, "Only exact not-found may create a push key")
        XCTAssertEqual(try bytes(), original)
    }

    func testWrongPublicPointAndCorruptRecordNeverRotatePushKey() throws {
        struct Record: Encodable { let version: Int; let privateDER: Data; let publicKey: Data; let keyVersion: Int }
        let key = P256.KeyAgreement.PrivateKey()
        let wrong = P256.KeyAgreement.PrivateKey()
        let record = try JSONEncoder().encode(Record(version: 1, privateDER: key.derRepresentation,
                                                     publicKey: wrong.publicKey.x963Representation, keyVersion: 1))
        var item = query
        item[kSecValueData as String] = record
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        XCTAssertEqual(SecItemAdd(item as CFDictionary, nil), errSecSuccess)
        XCTAssertThrowsError(try store().loadOrCreate())
        XCTAssertEqual(try bytes(), record, "Wrong-public refusal cannot replace or delete the previous record")
        let corrupt = Data("not a native key record".utf8)
        XCTAssertEqual(SecItemUpdate(query as CFDictionary, [kSecValueData as String: corrupt] as CFDictionary), errSecSuccess)
        XCTAssertThrowsError(try store().loadOrCreate())
        XCTAssertEqual(try bytes(), corrupt)
    }

    func testDurableReadBackMismatchRefusesWithoutDeletingEitherOwnedKey() throws {
        let secondary = NativePushKeyStore(service: service + ".secondary", account: account, accessGroup: nil)
        let other = try secondary.loadOrCreate()
        var operations = NativeKeychainOperations.system
        var reads = 0
        operations.copyMatching = { request, result in
            reads += 1
            var query = request as NSDictionary as! [String: Any]
            // Redirect only the actual post-add OS read into another disposable
            // real Keychain item. Production persistence/validation is unchanged.
            if reads > 1 { query[kSecAttrService as String] = self.service + ".secondary" }
            return SecItemCopyMatching(query as CFDictionary, result)
        }
        XCTAssertThrowsError(try store(operations: operations).loadOrCreate(),
                             "A mismatching durable read-back cannot publish the created push key")
        let retained = try XCTUnwrap(store().load())
        XCTAssertNotEqual(retained.publicKey, other.publicKey)
        XCTAssertEqual(try secondary.load().map { $0.publicKey }, other.publicKey)
    }

    // #1200 D6: the daemon refuses an equal key version with a different key
    // (STALE_KEY_VERSION), so a recreated key must outrank every version the lost
    // key could have registered; earlier builds always registered version 1.
    func testRecreatedPushKeyOutranksTheVersionTheLostKeyRegistered() throws {
        let lost = try store().loadOrCreate()
        XCTAssertEqual(SecItemDelete(query as CFDictionary), errSecSuccess, "The P256 item is lost; the daemon still holds its registration")
        Thread.sleep(forTimeInterval: 0.01)
        let recreated = try store().loadOrCreate()
        XCTAssertNotEqual(recreated.publicKey, lost.publicKey)
        XCTAssertGreaterThan(recreated.keyVersion, lost.keyVersion,
                             "An equal version with a different key can never register again")
    }
    func testNewPushKeyOutranksVersionOneFromEarlierBuilds() throws {
        let key = try store().loadOrCreate()
        XCTAssertGreaterThan(key.keyVersion, 1, "A device that registered version 1 must be able to register the new key")
    }
}
