import CryptoKit
import Foundation
import Security
import Testing
import RemiPush
@testable import RemiKit

struct OwnedPushContext {
    let directory: URL
    let store: RemiPushStore
    let service: String
    let account: String
    let authority: PushDeviceAuthority
    let room: Data
    let generation: Int64

    init(vector: [String: Any], oracle: [String: Any]) throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-x2-push-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        service = "live.yooz.remi.tests.push.\(UUID().uuidString)"; account = UUID().uuidString
        store = try .ownedTestStore(file: directory.appendingPathComponent("public.sqlite"), service: service, account: account)
        let content = try #require(vector["content"] as? [String: Any])
        room = try RelayOracle.hex(#require(content["rid"] as? String))
        authority = .init(publicKey: try RelayCrypto.unb64(#require(content["devicePublicKey"] as? String)),
            revision: UUID().uuidString, requiresAppUnlock: false)
        let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: RelayOracle.hex(#require(oracle["recipientScalarHex"] as? String)))
        struct Record: Encodable { let version: Int; let privateDER: Data; let publicKey: Data; let keyVersion: Int }
        var item: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: account]
        item[kSecValueData as String] = try JSONEncoder().encode(Record(version: 1, privateDER: key.derRepresentation,
            publicKey: key.publicKey.x963Representation, keyVersion: 3))
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        #expect(SecItemAdd(item as CFDictionary, nil) == errSecSuccess)
        let lease = try store.acquireIdentityMutation()
        defer { lease.release() }
        generation = try lease.invalidate()
        try lease.install(authority, generation: generation)
        try store.commitMachine(room: room, machinePublicKey: RelayCrypto.unb64(#require(content["machinePublicKey"] as? String)),
            origin: "https://relay.example.invalid", relayURL: "wss://relay.example.invalid", authority: authority, generation: generation)
    }
    func cleanup() throws {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account] as CFDictionary)
        try FileManager.default.removeItem(at: directory)
    }
    static func carrier(_ vector: [String: Any]) throws -> Data {
        let submit = try #require(vector["submit"] as? [String: Any])
        return try JSONSerialization.data(withJSONObject: ["v": 2, "rid": #require(submit["rid"]),
            "collapseId": #require(submit["collapseId"]), "sealed": #require(submit["sealed"])])
    }
}

struct NativePushCoreTests {
    @Test func sharedFacadeOpensAllTenReviewedOriginalCapsules() throws {
        let oracle = try NativePushOracle.load("push-vectors.json")
        let vectors = try #require(oracle["cases"] as? [[String: Any]])
        #expect(vectors.count == 10)
        for vector in vectors {
            let context = try OwnedPushContext(vector: vector, oracle: oracle)
            defer { try? context.cleanup() }
            let opened = try context.store.open(carrier: OwnedPushContext.carrier(vector), now: 1_700_000_001)
            let content = try #require(vector["content"] as? [String: Any])
            #expect(opened.collapseID == content["collapseId"] as? String)
            #expect(opened.revision == content["revision"] as? Int64)
            #expect(opened.machine.authority == context.authority)
            try context.store.recheck(opened, now: 1_700_000_001)
            #expect(try context.store.open(carrier: opened.originalCarrier, now: 1_700_000_001).contentDigest == opened.contentDigest)
        }
    }

    @Test func forgottenTrustCannotBeRestoredByReadsOrRecipientAccess() throws {
        let oracle = try NativePushOracle.load("push-vectors.json")
        let vector = try #require((oracle["cases"] as? [[String: Any]])?.first)
        let context = try OwnedPushContext(vector: vector, oracle: oracle)
        defer { try? context.cleanup() }
        let opened = try context.store.open(carrier: OwnedPushContext.carrier(vector), now: 1_700_000_001)
        try context.store.forgetMachine(room: context.room)
        #expect(try context.store.machine(room: context.room) == nil)
        #expect(try context.store.recipient() != nil)
        #expect(throws: (any Error).self) { try context.store.recheck(opened, now: 1_700_000_001) }
        #expect(throws: (any Error).self) { try context.store.open(carrier: opened.originalCarrier, now: 1_700_000_001) }
        #expect(try context.store.completedMachines().isEmpty)
    }

    @Test func generationChangeRevokesPreparedEffectsEvenWithSamePublicKey() throws {
        let oracle = try NativePushOracle.load("push-vectors.json")
        let vector = try #require((oracle["cases"] as? [[String: Any]])?.first)
        let context = try OwnedPushContext(vector: vector, oracle: oracle)
        defer { try? context.cleanup() }
        let opened = try context.store.open(carrier: OwnedPushContext.carrier(vector), now: 1_700_000_001)
        let lease = try context.store.acquireIdentityMutation()
        defer { lease.release() }
        let generation = try lease.invalidate()
        try lease.install(context.authority, generation: generation)
        #expect(generation != context.generation)
        #expect(throws: (any Error).self) { try context.store.recheck(opened, now: 1_700_000_001) }
    }
}
