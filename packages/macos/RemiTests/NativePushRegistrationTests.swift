import CryptoKit
import Foundation
import Security
import XCTest

final class NativePushRegistrationTests: XCTestCase {
    private var directory: URL!
    private var service = ""
    private var state: NativePushState!
    private var keys: NativePushKeyStore!
    private var authority: NativePushState.Authority!
    private var rid = Data()
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "owned-push-p256"]
    }
    override func setUpWithError() throws {
        service = "live.yooz.remi.tests.registration-" + UUID().uuidString
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi1200-registration-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        state = try NativePushState(file: directory.appendingPathComponent("public.sqlite"))
        keys = NativePushKeyStore(service: service, account: "owned-push-p256", accessGroup: nil)
        let lease = try state.acquireIdentityMutation()
        defer { lease.release() }
        let generation = try lease.invalidateIdentityAuthority()
        try lease.installIdentityAuthority(publicKey: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation,
            revision: UUID().uuidString, requiresAppUnlock: false, generation: generation)
        authority = try XCTUnwrap(state.currentAuthority())
        let machinePublicKey = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        rid = Data(SHA256.hash(data: machinePublicKey).prefix(16))
        try state.installMachineTrust(.init(rid: rid, machinePublicKey: machinePublicKey,
            endpoint: "https://relay.example.invalid", authority: authority, relayUrl: "wss://relay.example.invalid"), generation: generation)
    }
    override func tearDownWithError() throws {
        SecItemDelete(query as CFDictionary)
        keys = nil; state = nil
        if let directory { try FileManager.default.removeItem(at: directory) }
    }
    @MainActor private func registration(_ tokens: NativePushTokenOwner, production: Bool = true) -> NativePushRegistration {
        NativePushRegistration(state: state, keys: keys, tokens: tokens, environment: {
            NativeAPNsEnvironment(query: { queriedProduction, completion in
                // Only the external public OS completion boundary is controlled.
                completion(queriedProduction == production ? .match : .mismatch)
                return {}
            })
        })
    }
    @MainActor private func prepare(_ registration: NativePushRegistration) async -> NativePushRegistration.Prepared? {
        do { return try await registration.prepare(rid: rid, authority: authority, stillCurrent: { true }) }
        catch { XCTFail("Actual completed native pairing and OS token must prepare secure metadata: \(error)"); return nil }
    }
    func testActualOSTokenBoundaryOwnsBoundedRevisionedToken() throws {
        let tokens = NativePushTokenOwner()
        XCTAssertNil(tokens.snapshot())
        let token = Data([0, 15, 255])
        tokens.recordFromOS(token)
        guard let first = tokens.snapshot() else { XCTFail("Actual OS token callback must be captured"); return }
        XCTAssertEqual(first.token, token)
        tokens.recordFromOS(token)
        XCTAssertNotEqual(tokens.snapshot()?.revision, first.revision, "Every OS callback changes the capture epoch")
        tokens.recordFromOS(Data(repeating: 1, count: 256))
        XCTAssertEqual(tokens.snapshot()?.token.count, 256)
        tokens.recordFromOS(Data(repeating: 1, count: 257))
        XCTAssertNil(tokens.snapshot(), "Out-of-contract OS token must close token authority")
        tokens.recordFromOS(Data([1])); tokens.clearFromOS()
        XCTAssertNil(tokens.snapshot())
        tokens.recordFromOS(Data())
        XCTAssertNil(tokens.snapshot())
    }
    @MainActor func testProductionMetadataCreatesActualDurableNativeRecipient() async throws {
        let tokens = NativePushTokenOwner(); tokens.recordFromOS(Data([0, 15, 255]))
        let r = registration(tokens)
        guard let p = await prepare(r) else { return }
        XCTAssertEqual(p.token, "000fff")
        XCTAssertEqual(p.environment, "production")
        let durable = try XCTUnwrap(keys.load())
        XCTAssertEqual(p.pushPublicKey, durable.publicKey.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: ""))
        XCTAssertEqual(p.keyVersion, durable.keyVersion)
        XCTAssertEqual(p.authority, authority)
        XCTAssertEqual(p.generation, try state.authorityGeneration())
        XCTAssertNoThrow(try r.recheck(p, stillCurrent: { true }))
    }
    @MainActor func testSandboxMetadataPreservesExistingRecipient() async throws {
        let original = try keys.loadOrCreate()
        let tokens = NativePushTokenOwner(); tokens.recordFromOS(Data([1]))
        guard let p = await prepare(registration(tokens, production: false)) else { return }
        XCTAssertEqual(p.environment, "sandbox")
        XCTAssertEqual(p.keyVersion, original.keyVersion)
        XCTAssertEqual(try keys.load()?.publicKey, original.publicKey)
    }
    @MainActor func testTokenReplacementRefusesPreparedRegistration() async throws {
        let tokens = NativePushTokenOwner(); tokens.recordFromOS(Data([1]))
        let r = registration(tokens)
        guard let p = await prepare(r) else { return }
        tokens.recordFromOS(Data([2]))
        XCTAssertThrowsError(try r.recheck(p, stillCurrent: { true }))
    }
    @MainActor func testSamePublicFreshGenerationAndForgetRefusePreparedRegistration() async throws {
        let tokens = NativePushTokenOwner(); tokens.recordFromOS(Data([1]))
        let r = registration(tokens)
        guard let p = await prepare(r) else { return }
        let lease = try state.acquireIdentityMutation()
        let generation = try lease.invalidateIdentityAuthority()
        try lease.installIdentityAuthority(publicKey: authority.publicKey, revision: authority.revision,
            requiresAppUnlock: authority.requiresAppUnlock, generation: generation)
        lease.release()
        try state.installMachineTrust(p.trust, generation: generation)
        XCTAssertThrowsError(try r.recheck(p, stillCurrent: { true }), "Equal public fields do not restore the captured authority generation")
        guard let fresh = await prepare(r) else { return }
        try state.forgetMachine(rid: rid)
        XCTAssertThrowsError(try r.recheck(fresh, stillCurrent: { true }))
    }
    @MainActor func testContextLossRefusesPreparedRegistration() async throws {
        let tokens = NativePushTokenOwner(); tokens.recordFromOS(Data([1]))
        let r = registration(tokens)
        guard let p = await prepare(r) else { return }
        XCTAssertThrowsError(try r.recheck(p, stillCurrent: { false }))
    }
    @MainActor func testMissingTokenUnavailableEnvironmentAndContextNeverCreateRecipient() async throws {
        let tokens = NativePushTokenOwner()
        do { _ = try await registration(tokens).prepare(rid: rid, authority: authority, stillCurrent: { true }); XCTFail("Missing OS token must refuse") }
        catch {}
        XCTAssertNil(try keys.load())
        tokens.recordFromOS(Data([1]))
        let unavailable = NativePushRegistration(state: state, keys: keys, tokens: tokens, environment: {
            NativeAPNsEnvironment(query: { _, completion in completion(.unavailable); return {} })
        })
        do { _ = try await unavailable.prepare(rid: rid, authority: authority, stillCurrent: { true }); XCTFail("Unavailable OS environment must refuse") }
        catch {}
        XCTAssertNil(try keys.load())
        do { _ = try await registration(tokens).prepare(rid: rid, authority: authority, stillCurrent: { false }); XCTFail("Lost caller context must refuse") }
        catch {}
        XCTAssertNil(try keys.load())
    }
}
