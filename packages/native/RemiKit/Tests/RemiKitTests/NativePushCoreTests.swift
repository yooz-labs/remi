import CryptoKit
import Foundation
import Security
import Testing
import RemiPush
@testable import RemiKit

struct OwnedPushContext: Sendable {
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
    /// Controlled signed inputs use the oracle's synthetic machine and recipient.
    /// Only payload/signature vary; the real facade still decrypts and verifies.
    static func resealed(_ vector: [String: Any], oracle: [String: Any], payload: Data,
                         corruptSignature: Bool = false) throws -> Data {
        func parts(_ bytes: Data) throws -> [Data] {
            var offset = 0, values: [Data] = []
            while offset < bytes.count {
                try #require(offset + 2 <= bytes.count)
                let count = Int(bytes[offset]) << 8 | Int(bytes[offset + 1]); offset += 2
                try #require(offset + count <= bytes.count)
                values.append(bytes.subdata(in: offset..<(offset + count))); offset += count
            }
            return values
        }
        let inner = try parts(RelayOracle.hex(#require(vector["innerHex"] as? String)))
        var fields = try parts(#require(inner.first)); try #require(fields.count == 12)
        fields[11] = payload
        let body = try RelayCrypto.tuple(fields)
        let machine = try Curve25519.Signing.PrivateKey(rawRepresentation: RelayOracle.hex(#require(oracle["machineSeedHex"] as? String)))
        var signature = try machine.signature(for: RelayCrypto.tuple(Data("remi-relay-v2 push content".utf8), Data(SHA256.hash(data: body))))
        if corruptSignature { signature[0] ^= 1 }
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let shared = try ephemeral.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: fields[3]))
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: ephemeral.publicKey.x963Representation,
            sharedInfo: try RelayCrypto.tuple(Data("remi-relay-v2 seal".utf8), fields[3]), outputByteCount: 32)
        let box = try AES.GCM.seal(RelayCrypto.tuple(body, signature), using: key, authenticating: fields[1] + fields[5])
        let sealed = ephemeral.publicKey.x963Representation + box.nonce.withUnsafeBytes { Data($0) } + box.ciphertext + box.tag
        let content = try #require(vector["content"] as? [String: Any])
        return try JSONSerialization.data(withJSONObject: ["v": 2, "rid": #require(content["rid"]),
            "collapseId": #require(content["collapseId"]), "sealed": RelayCrypto.b64(sealed)])
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
    @Test func decryptableCapsuleStillRequiresMachineSignature() throws {
        let oracle = try NativePushOracle.load("push-vectors.json")
        let vector = try #require((oracle["cases"] as? [[String: Any]])?.first)
        let context = try OwnedPushContext(vector: vector, oracle: oracle)
        defer { try? context.cleanup() }
        let payload = try RelayOracle.hex(#require(vector["payloadHex"] as? String))
        let valid = try OwnedPushContext.resealed(vector, oracle: oracle, payload: payload)
        _ = try context.store.open(carrier: valid, now: 1_700_000_001)
        let invalid = try OwnedPushContext.resealed(vector, oracle: oracle, payload: payload, corruptSignature: true)
        #expect(throws: (any Error).self) { try context.store.open(carrier: invalid, now: 1_700_000_001) }
        #expect(try context.store.generation() == context.generation)
        #expect(try context.store.completedMachines().count == 1)
    }
}
