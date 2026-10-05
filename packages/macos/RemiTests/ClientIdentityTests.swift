//
//  ClientIdentityTests.swift
//  RemiTests
//
//  #872: the macOS app's Ed25519 identity. Covers what's testable without a
//  daemon — Keychain persistence, the fingerprint derivation, and Ed25519
//  signing/verification — against REAL vectors generated from
//  packages/shared/src/crypto.ts (the source of truth this must match on
//  the wire), not invented ones.
//
//  Vectors captured via `bun run` against crypto.ts's generateKeyPair(),
//  fingerprint(), and sign():
//    publicKeyBase64:  hTsqoOoMHpkLCHTMC3fmWZ0dPf944WBgvCA/zIkd1Lc=
//    fingerprint:      f851bb1f053baacf
//    challengeBase64:  hbGyBAveiwqpVe4KOI9Ph3WjQ5rEBAjNBAY8JzZ0HSA=
//    signatureBase64:  8OJYmBhAA/4694uebtoQssikFbMYHIhdmlxTAYZQTkon9EGlv1VQhKqsyDbwWahp3dcIf1EVWX2sfrZ3q/5mAw==
//

import CryptoKit
import Security
import XCTest


final class ClientIdentityTests: XCTestCase {
    // Distinct service/account per test run so this suite never touches (or
    // collides with) the real app's Keychain item.
    private var service = ""
    private var account = ""

    override func setUp() {
        super.setUp()
        let unique = UUID().uuidString
        service = "live.yooz.remi.tests.\(unique)"
        account = "ed25519-private-key"
    }

    override func tearDown() {
        ClientIdentityStore.resetForTesting(service: service, account: account)
        super.tearDown()
    }

    func testApprovalExportContainsOnlyPublicIdentity() throws {
        let identity = ClientIdentity(privateKey: .init())
        let json = try XCTUnwrap(identity.publicIdentityJSON.data(using: .utf8))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: json) as? [String: String])
        XCTAssertEqual(Set(object.keys), Set(["publicKey", "fingerprint"]))
        XCTAssertEqual(object["publicKey"], identity.publicKeyRaw.base64EncodedString())
        XCTAssertEqual(object["fingerprint"], identity.fingerprint)
        XCTAssertEqual(identity.authorizeCommand, "remi authorize \(identity.fingerprint)")
    }

    func testServerKeyValidatorMatchesActualSharedHelperFixtures() throws {
        struct Case: Decodable {
            let publicKey: String
            let fingerprint: String
            let smallOrder: Bool
        }
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("fixtures/ed25519-server-keys.json")
        let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: file))
        XCTAssertEqual(cases.filter { $0.smallOrder }.count, 14)
        XCTAssertEqual(cases.filter { !$0.smallOrder }.count, 2)
        for item in cases {
            let raw = try XCTUnwrap(Data(base64Encoded: item.publicKey))
            XCTAssertEqual(ClientIdentity.isSmallOrderPublicKey(raw), item.smallOrder)
            XCTAssertEqual(ClientIdentity.fingerprint(ofPublicKeyRaw: raw), item.fingerprint)
        }
    }

    // MARK: - Keychain persistence

    func testLoadOrCreatePersistsAcrossInstantiations() throws {
        let first = try ClientIdentityStore.loadOrCreate(service: service, account: account)
        let second = try ClientIdentityStore.loadOrCreate(service: service, account: account)
        XCTAssertEqual(
            first.publicKeyRaw, second.publicKeyRaw,
            "a fresh loadOrCreate() call must return the SAME key as before, not regenerate one")
        XCTAssertEqual(first.fingerprint, second.fingerprint)
    }

    func testResetForTestingForcesAFreshKey() throws {
        let first = try ClientIdentityStore.loadOrCreate(service: service, account: account)
        ClientIdentityStore.resetForTesting(service: service, account: account)
        let second = try ClientIdentityStore.loadOrCreate(service: service, account: account)
        XCTAssertNotEqual(
            first.publicKeyRaw, second.publicKeyRaw,
            "with the Keychain item deleted, loadOrCreate() must generate a new key")
    }

    func testDistinctServiceAccountPairsGetIndependentKeys() throws {
        let a = try ClientIdentityStore.loadOrCreate(service: service, account: account)
        let otherAccount = "\(account)-other"
        let b = try ClientIdentityStore.loadOrCreate(service: service, account: otherAccount)
        defer { ClientIdentityStore.resetForTesting(service: service, account: otherAccount) }
        XCTAssertNotEqual(a.publicKeyRaw, b.publicKeyRaw)
    }

    // MARK: - Fingerprint (known vector from packages/shared/src/crypto.ts)

    func testFingerprintMatchesTypeScriptVector() throws {
        let publicKeyRaw = try XCTUnwrap(
            Data(base64Encoded: "hTsqoOoMHpkLCHTMC3fmWZ0dPf944WBgvCA/zIkd1Lc="))
        XCTAssertEqual(publicKeyRaw.count, 32, "Ed25519 public keys are 32 raw bytes")
        XCTAssertEqual(
            ClientIdentity.fingerprint(ofPublicKeyRaw: publicKeyRaw), "f851bb1f053baacf")
    }

    func testFingerprintIsSixteenHexCharacters() throws {
        let identity = try ClientIdentityStore.loadOrCreate(service: service, account: account)
        XCTAssertEqual(identity.fingerprint.count, 16)
        XCTAssertTrue(identity.fingerprint.allSatisfy(\.isHexDigit))
        // crypto.ts toHex() is lowercase; the daemon compares strings, so
        // case must match exactly or a correct key would look unauthorized.
        XCTAssertEqual(identity.fingerprint, identity.fingerprint.lowercased())
    }

    /// R4: the native store must durably hold a validated PKCS8/public record,
    /// not return a newly generated signer while leaving only a bare seed behind.
    func testKeychainPersistsPKCS8AndPublicRecord() throws {
        let identity = try ClientIdentityStore.loadOrCreate(service: service, account: account)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &result), errSecSuccess)
        let data = try XCTUnwrap(result as? Data)
        let record = try XCTUnwrap(
            (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            "The real native Keychain entry must be a versioned PKCS8/public record")
        XCTAssertEqual(record["version"] as? Int, 2)
        let pkcs8 = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(record["pkcs8"] as? String)))
        XCTAssertEqual(pkcs8.count, 48)
        XCTAssertEqual(record["publicKey"] as? String, identity.publicKeyRaw.base64EncodedString())
    }

    func testCorruptKeychainRefusesWithoutRotationOrDeletion() throws {
        let corrupt = Data("not-an-identity".utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        var create = query
        create[kSecValueData as String] = corrupt
        XCTAssertEqual(SecItemAdd(create as CFDictionary, nil), errSecSuccess)
        do {
            _ = try ClientIdentityStore.loadOrCreate(service: service, account: account)
            XCTFail("Corruption must fail visibly instead of generating a different signer")
        } catch {}
        var read = query
        read[kSecReturnData as String] = true
        var result: AnyObject?
        XCTAssertEqual(SecItemCopyMatching(read as CFDictionary, &result), errSecSuccess)
        XCTAssertEqual(result as? Data, corrupt, "A failed load must preserve the existing entry")
    }

    func testDirectAnswerSignerWorksAfterLegacyPreferencesSeedIsRemoved() throws {
        let suite = "remi1199-direct-answer-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let identity = try ClientIdentityStore.loadOrCreate(service: service, account: account)
        let message = "session|question|yes"
        let auth = try XCTUnwrap(RemiNativeStore.sign(message: message, identity: identity, defaults: defaults),
                                 "The shipping direct-answer signer must use the durable native identity before seed cleanup")
        let signature = try XCTUnwrap(Data(base64Encoded: auth.signature))
        XCTAssertTrue(identity.publicKey.isValidSignature(signature, for: Data(message.utf8)))
        XCTAssertEqual(auth.publicKey, identity.publicKeyRaw.base64EncodedString())
        XCTAssertEqual(auth.fingerprint, identity.fingerprint)
    }

    // MARK: - Signing / verification

    func testSignedChallengeVerifiesAgainstOwnPublicKey() throws {
        let identity = try ClientIdentityStore.loadOrCreate(service: service, account: account)
        let challenge = Data("auth-challenge-fixture".utf8)
        let signature = try identity.sign(challenge)
        XCTAssertTrue(identity.publicKey.isValidSignature(signature, for: challenge))
    }

    func testSignedChallengeFailsAgainstADifferentKey() throws {
        let identity = try ClientIdentityStore.loadOrCreate(service: service, account: account)
        let impostor = ClientIdentity(privateKey: .init())
        let challenge = Data("auth-challenge-fixture".utf8)
        let signature = try identity.sign(challenge)
        XCTAssertFalse(impostor.publicKey.isValidSignature(signature, for: challenge))
    }

    /// Cross-language wire compatibility: a signature produced by the
    /// TypeScript `sign()` (packages/shared/src/crypto.ts) over a real
    /// base64 challenge, verified here with CryptoKit exactly the way
    /// HubClient verifies a daemon's `auth_result.serverSignature`. If the
    /// byte layout ever drifted (e.g. PKCS8 vs raw), this is what would
    /// catch it — a same-process round trip (sign then verify with the same
    /// library) cannot.
    func testVerifiesASignatureProducedByTheTypeScriptImplementation() throws {
        let publicKeyRaw = try XCTUnwrap(
            Data(base64Encoded: "hTsqoOoMHpkLCHTMC3fmWZ0dPf944WBgvCA/zIkd1Lc="))
        let challengeData = try XCTUnwrap(
            Data(base64Encoded: "hbGyBAveiwqpVe4KOI9Ph3WjQ5rEBAjNBAY8JzZ0HSA="))
        let signatureData = try XCTUnwrap(
            Data(
                base64Encoded:
                    "8OJYmBhAA/4694uebtoQssikFbMYHIhdmlxTAYZQTkon9EGlv1VQhKqsyDbwWahp3dcIf1EVWX2sfrZ3q/5mAw=="
            ))
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyRaw)
        XCTAssertTrue(publicKey.isValidSignature(signatureData, for: challengeData))
    }
}
