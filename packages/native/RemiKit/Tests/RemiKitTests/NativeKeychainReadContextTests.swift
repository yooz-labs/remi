import CryptoKit
import Foundation
import LocalAuthentication
import Security
import Testing
@testable import RemiKit
@testable import RemiPush

/// #1768: every native Keychain read passes the one non-interactive context, so
/// concurrent reads allocate no LocalAuthentication context per read; a read
/// after that context is invalidated still returns its item; and the stores map
/// read statuses as before. Reads go to the real Keychain; the operations seam
/// only looks at each query on its way to SecItemCopyMatching.
struct NativeKeychainReadContextTests {
    /// The system can invalidate the one shared context (the daemon did so to
    /// per-read contexts under load, #1768). Remi reuses it rather than
    /// recreating it, so the next reads through both stores must still return
    /// their items. The context in each query is swapped for an invalidated one
    /// on its way to the real SecItemCopyMatching; the shared one stays valid.
    @Test func readsThroughAnInvalidatedContextStillReturnTheirItems() throws {
        let invalidated = LAContext()
        invalidated.interactionNotAllowed = true
        invalidated.invalidate()
        let service = "live.yooz.remi.tests.read-context.\(UUID().uuidString)"
        let pushAccount = UUID().uuidString, identityAccount = UUID().uuidString
        struct PushRecord: Encodable { let version: Int; let privateDER: Data; let publicKey: Data; let keyVersion: Int }
        struct IdentityRecord: Encodable {
            let version: Int; let pkcs8: Data; let publicKey: Data; let revision: String; let requiresAppUnlock: Bool
        }
        let key = P256.KeyAgreement.PrivateKey(), identity = ClientIdentity()
        let records = [
            (pushAccount, try JSONEncoder().encode(PushRecord(version: 1, privateDER: key.derRepresentation,
                publicKey: key.publicKey.x963Representation, keyVersion: 3))),
            (identityAccount, try JSONEncoder().encode(IdentityRecord(version: 2,
                pkcs8: Ed25519PKCS8.encode(identity.privateKey), publicKey: identity.publicKeyRaw,
                revision: UUID().uuidString, requiresAppUnlock: false))),
        ]
        func query(_ account: String) -> [String: Any] {
            [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
             kSecAttrAccount as String: account]
        }
        defer { for (account, _) in records { SecItemDelete(query(account) as CFDictionary) } }
        for (account, data) in records {
            var item = query(account)
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            try #require(SecItemAdd(item as CFDictionary, nil) == errSecSuccess)
        }
        let operations = NativeKeychainOperations(copyMatching: { query, output in
            let values = (query as NSDictionary).mutableCopy() as! NSMutableDictionary
            #expect(values[kSecUseAuthenticationContext as String] as? LAContext === NativeKeychainReadContext.noninteractive)
            values[kSecUseAuthenticationContext as String] = invalidated
            return SecItemCopyMatching(values as CFDictionary, output)
        }, add: { _, _ in errSecUnimplemented }, update: { _, _ in errSecUnimplemented })
        let push = NativePushKeyStore(service: service, account: pushAccount, accessGroup: nil, operations: operations)
        for _ in 0..<3 {
            #expect(try push.load()?.publicKey == key.publicKey.x963Representation)
            #expect(try NativeIdentityRecordStore.currentRecord(accessGroup: nil, service: service,
                account: identityAccount, operations: operations)?.publicKeyRaw == identity.publicKeyRaw)
            #expect(try NativeIdentityRecordStore.currentRecord(accessGroup: nil, service: service,
                account: UUID().uuidString, operations: operations) == nil)
        }
    }

    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var contexts: [ObjectIdentifier: LAContext] = [:]
        private var reads = 0
        private var withoutContext = 0
        var operations: NativeKeychainOperations {
            .init(copyMatching: { query, output in
                let context = (query as NSDictionary)[kSecUseAuthenticationContext as String] as? LAContext
                self.lock.withLock {
                    self.reads += 1
                    if let context { self.contexts[ObjectIdentifier(context)] = context } else { self.withoutContext += 1 }
                }
                return SecItemCopyMatching(query, output)
            }, add: SecItemAdd, update: SecItemUpdate)
        }
        var observed: (reads: Int, withoutContext: Int, contexts: [LAContext]) {
            lock.withLock { (reads, withoutContext, Array(contexts.values)) }
        }
    }

    @Test func concurrentReadsOfBothStoresShareOneNoninteractiveContext() async {
        let recorder = Recorder()
        let service = "live.yooz.remi.tests.read-context.\(UUID().uuidString)"
        await withTaskGroup(of: Void.self) { group in
            for worker in 0..<16 {
                group.addTask {
                    let push = NativePushKeyStore(service: service, account: "push-\(worker)", accessGroup: nil,
                                                  operations: recorder.operations)
                    for _ in 0..<4 {
                        do {
                            // Nothing is written under this service: both reads find nothing.
                            #expect(try push.load() == nil)
                            #expect(try NativeIdentityRecordStore.currentRecord(accessGroup: nil, service: service,
                                account: "identity-\(worker)", operations: recorder.operations) == nil)
                        } catch { Issue.record(error) }
                    }
                }
            }
        }
        let observed = recorder.observed
        #expect(observed.reads == 128)
        #expect(observed.withoutContext == 0)
        #expect(observed.contexts.count == 1)
        #expect(observed.contexts.first === NativeKeychainReadContext.noninteractive)
        #expect(observed.contexts.first?.interactionNotAllowed == true)
    }

    /// Not found is no item; every other status is an error carrying it.
    @Test(arguments: [errSecInteractionNotAllowed, errSecAuthFailed, errSecNotAvailable])
    func readStatusesKeepTheirMapping(status: OSStatus) throws {
        func operations(_ result: OSStatus) -> NativeKeychainOperations {
            .init(copyMatching: { _, _ in result }, add: { _, _ in errSecUnimplemented },
                  update: { _, _ in errSecUnimplemented })
        }
        let service = "live.yooz.remi.tests.read-context.unused", account = "unused"
        #expect(try NativePushKeyStore(service: service, account: account, accessGroup: nil,
                                       operations: operations(errSecItemNotFound)).load() == nil)
        #expect(try NativeIdentityRecordStore.currentRecord(accessGroup: nil, service: service, account: account,
                                                            operations: operations(errSecItemNotFound)) == nil)
        do {
            _ = try NativePushKeyStore(service: service, account: account, accessGroup: nil,
                                       operations: operations(status)).load()
            Issue.record("the push key read did not throw")
        } catch NativePushKeyError.keychain(let thrown) { #expect(thrown == status) }
        do {
            _ = try NativeIdentityRecordStore.currentRecord(accessGroup: nil, service: service, account: account,
                                                            operations: operations(status))
            Issue.record("the identity read did not throw")
        } catch NativeIdentityError.keychain(let thrown) { #expect(thrown == status) }
    }
}
