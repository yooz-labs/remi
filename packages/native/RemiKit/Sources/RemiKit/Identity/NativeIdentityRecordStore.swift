// Adapted from reviewed legacy ClientIdentity.swift at1e96c688 (#1242).
// App-only: this file is never compiled into RemiPush or either NSE.
import CryptoKit
import Foundation
import Security
import LocalAuthentication
import RemiPush

protocol NativeIdentityAuthorityBarrier {
    func acquireIdentityMutation() throws -> PushIdentityMutationLease
    func reconcileObservedIdentity(publicKey: Data?, revision: String?, requiresAppUnlock: Bool?) throws
}
struct NativePushAuthorityAdapter: NativeIdentityAuthorityBarrier {
    let push: RemiPushStore
    init(_ push: RemiPushStore) { self.push = push }
    func acquireIdentityMutation() throws -> PushIdentityMutationLease { try push.acquireIdentityMutation() }
    func reconcileObservedIdentity(publicKey: Data?, revision: String?, requiresAppUnlock: Bool?) throws {
        let observed: PushDeviceAuthority?
        if let publicKey, let revision, let requiresAppUnlock {
            observed = .init(publicKey: publicKey, revision: revision, requiresAppUnlock: requiresAppUnlock)
        } else { observed = nil }
        try push.reconcileIdentity(observed)
    }
}

enum NativeIdentityError: Error {
    case protected
    case malformed, publicMismatch, changed, conflict
    case keychain(OSStatus)
}

enum Ed25519PKCS8 {
    private static let prefix = Data([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
                                     0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
    static func encode(_ key: Curve25519.Signing.PrivateKey) -> Data {
        prefix + key.rawRepresentation
    }
    static func decode(_ pkcs8: Data, publicKey: Data) throws -> Curve25519.Signing.PrivateKey {
        guard pkcs8.count == 48, pkcs8.prefix(16) == prefix, publicKey.count == 32 else {
            throw NativeIdentityError.malformed
        }
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: pkcs8.suffix(32))
        guard key.publicKey.rawRepresentation == publicKey else {
            throw NativeIdentityError.publicMismatch
        }
        let probe = Data("remi native identity validation".utf8)
        guard key.publicKey.isValidSignature(try key.signature(for: probe), for: probe) else {
            throw NativeIdentityError.publicMismatch
        }
        return key
    }
}

/// The native Keychain stores a versioned PKCS8/public record. Only exact
/// errSecItemNotFound permits creation; corruption and read errors never rotate a key.
/// Migration/replacement uses SecItemUpdate, preserving the previous item on failure.
enum NativeIdentityRecordStore {
    static let defaultService = "live.yooz.remi.client-identity"
    static let defaultAccount = "ed25519-private-key"
    private struct Record: Codable {
        let version: Int
        let pkcs8: Data
        let publicKey: Data
        let revision: String
        // Optional only for the initial R4 record format; missing means an unprotected native key.
        let requiresAppUnlock: Bool?
        init(_ identity: ClientIdentity) {
            version = 2
            pkcs8 = Ed25519PKCS8.encode(identity.privateKey)
            publicKey = identity.publicKeyRaw
            revision = identity.revision
            requiresAppUnlock = identity.requiresAppUnlock
        }
        func identity() throws -> ClientIdentity {
            guard version == 2, UUID(uuidString: revision) != nil else {
                throw NativeIdentityError.malformed
            }
            return ClientIdentity(privateKey: try Ed25519PKCS8.decode(pkcs8, publicKey: publicKey),
                                  revision: revision, requiresAppUnlock: requiresAppUnlock ?? false)
        }
    }

    private enum ExpectedRecord {
        case absent
        case nativeSeed(Data)
        case identity(ClientIdentity)
        case legacyCopy(Data)
    }

    /// Load-only validation for a persisted signer. No migration, repair, authority
    /// reconciliation, or credential creation may occur in this background path.
    static func currentRecord(accessGroup: String?, service: String = defaultService,
                              account: String = defaultAccount,
                              operations: NativeKeychainOperations = .system) throws -> ClientIdentity? {
        guard let data = try read(accessGroup: accessGroup, service: service, account: account,
                                  operations: operations) else { return nil }
        guard data.count != 32 else { throw NativeIdentityError.changed }
        return try JSONDecoder().decode(Record.self, from: data).identity()
    }

    static func loadOrCreate(authority: NativeIdentityAuthorityBarrier, accessGroup: String?, service: String = defaultService, account: String = defaultAccount,
                             operations: NativeKeychainOperations = .system) throws -> ClientIdentity {
        if let identity = try load(authority: authority, accessGroup: accessGroup, service: service, account: account, operations: operations) { return identity }
        let fresh = ClientIdentity(privateKey: .init())
        do { try persist(fresh, expected: .absent, service: service, account: account, updating: false, accessGroup: accessGroup, operations: operations, authority: authority) }
        catch NativeIdentityError.keychain(errSecDuplicateItem) {
            // A concurrent first creation won. Use its durable identity, never overwrite it.
            guard let winner = try load(authority: authority, accessGroup: accessGroup, service: service, account: account, operations: operations) else { throw NativeIdentityError.changed }
            return winner
        }
        return fresh
    }

    static func load(authority: NativeIdentityAuthorityBarrier, accessGroup: String?, service: String = defaultService, account: String = defaultAccount,
                     operations: NativeKeychainOperations = .system) throws -> ClientIdentity? {
        let data: Data
        do {
            guard let stored = try read(accessGroup: accessGroup, service: service, account: account, operations: operations) else {
                #if os(macOS)
                // Foreground only. Cold signers never inspect the legacy slot.
                if let accessGroup, let legacy = try readLegacy(service: service, account: account, operations: operations) {
                    let identity = legacy.count == 32
                        ? ClientIdentity(privateKey: try .init(rawRepresentation: legacy))
                        : try JSONDecoder().decode(Record.self, from: legacy).identity()
                    do {
                        try persist(identity, expected: .legacyCopy(legacy), service: service, account: account,
                            updating: false, accessGroup: accessGroup, operations: operations, authority: authority,
                            encodedRecord: legacy.count == 32 ? nil : legacy)
                    } catch NativeIdentityError.keychain(errSecDuplicateItem) {
                        guard let winner = try currentRecord(accessGroup: accessGroup, service: service,
                            account: account, operations: operations) else { throw NativeIdentityError.changed }
                        try authority.reconcileObservedIdentity(publicKey: winner.publicKeyRaw,
                            revision: winner.revision, requiresAppUnlock: winner.requiresAppUnlock)
                        return winner
                    }
                    return identity
                }
                #endif
                try authority.reconcileObservedIdentity(publicKey: nil, revision: nil, requiresAppUnlock: nil)
                return nil
            }
            data = stored
        } catch {
            try authority.reconcileObservedIdentity(publicKey: nil, revision: nil, requiresAppUnlock: nil)
            throw error
        }
        if data.count == 32 {
            // One-time inward migration of the existing native seed, with no deletion.
            let identity = ClientIdentity(privateKey: try .init(rawRepresentation: data))
            try persist(identity, expected: .nativeSeed(data), service: service, account: account, updating: true, accessGroup: accessGroup, operations: operations, authority: authority)
            return identity
        }
        let identity: ClientIdentity
        do { identity = try JSONDecoder().decode(Record.self, from: data).identity() }
        catch {
            try authority.reconcileObservedIdentity(publicKey: nil, revision: nil, requiresAppUnlock: nil)
            throw error
        }
        try authority.reconcileObservedIdentity(publicKey: identity.publicKeyRaw, revision: identity.revision, requiresAppUnlock: identity.requiresAppUnlock)
        return identity
    }

    /// An explicit inward import. A conflicting durable identity is untouched unless
    /// the caller presents its exact revision after a human chose replacement.
    static func importIdentity(authority: NativeIdentityAuthorityBarrier, accessGroup: String?, pkcs8: Data, publicKey: Data, replacing revision: String? = nil, requiresAppUnlock: Bool = false,
                               service: String = defaultService, account: String = defaultAccount,
                             operations: NativeKeychainOperations = .system) throws -> ClientIdentity {
        let key = try Ed25519PKCS8.decode(pkcs8, publicKey: publicKey)
        let existing = try load(authority: authority, accessGroup: accessGroup, service: service, account: account, operations: operations)
        if let existing, existing.publicKeyRaw == publicKey,
           existing.requiresAppUnlock || !requiresAppUnlock { return existing }
        if let existing {
            guard revision == existing.revision else { throw NativeIdentityError.conflict }
        } else if revision != nil { throw NativeIdentityError.changed }
        // Imports may tighten the policy, never silently remove it.
        let imported = ClientIdentity(privateKey: key,
                                      requiresAppUnlock: requiresAppUnlock || existing?.requiresAppUnlock == true)
        try persist(imported, expected: existing.map(ExpectedRecord.identity) ?? .absent, service: service, account: account, updating: existing != nil, accessGroup: accessGroup, operations: operations, authority: authority)
        return imported
    }

    static func requireAppUnlock(authority: NativeIdentityAuthorityBarrier, accessGroup: String?, revision: String, publicKey: Data,
                                 service: String = defaultService, account: String = defaultAccount,
                             operations: NativeKeychainOperations = .system) throws -> ClientIdentity {
        guard let existing = try load(authority: authority, accessGroup: accessGroup, service: service, account: account, operations: operations),
              existing.revision == revision, existing.publicKeyRaw == publicKey else { throw NativeIdentityError.changed }
        if existing.requiresAppUnlock { return existing }
        let protected = ClientIdentity(privateKey: existing.privateKey, requiresAppUnlock: true)
        try persist(protected, expected: .identity(existing), service: service, account: account, updating: true, accessGroup: accessGroup, operations: operations, authority: authority)
        return protected
    }

    #if DEBUG
    static func resetForTesting(service: String, account: String) {
        SecItemDelete(query(accessGroup: nil, service: service, account: account) as CFDictionary)
    }
    #endif

    static func query(accessGroup: String?, service: String, account: String) -> [String: Any] {
        var value: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: account]
        if let accessGroup {
            value[kSecAttrAccessGroup as String] = accessGroup
            #if os(macOS)
            // Access groups are ignored by the file Keychain on Mac (#1242).
            value[kSecUseDataProtectionKeychain as String] = true
            #endif
        }
        return value
    }
    #if os(macOS)
    private static func readLegacy(service: String, account: String, operations: NativeKeychainOperations) throws -> Data? {
        var query = query(accessGroup: nil, service: service, account: account)
        query[kSecUseDataProtectionKeychain as String] = false
        return try read(query: query, operations: operations)
    }
    #endif
    private static func read(accessGroup: String?, service: String, account: String, operations: NativeKeychainOperations) throws -> Data? {
        try read(query: query(accessGroup: accessGroup, service: service, account: account), operations: operations)
    }
    private static func read(query: [String: Any], operations: NativeKeychainOperations) throws -> Data? {
        var q = query
        let context = LAContext()
        context.interactionNotAllowed = true
        q[kSecUseAuthenticationContext as String] = context
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = operations.copyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw NativeIdentityError.keychain(status) }
        guard let data = result as? Data else { throw NativeIdentityError.malformed }
        return data
    }
    private static func persist(_ identity: ClientIdentity, expected: ExpectedRecord, service: String, account: String, updating: Bool, accessGroup: String?, operations: NativeKeychainOperations, authority: NativeIdentityAuthorityBarrier,
                                encodedRecord: Data? = nil) throws {
        let data = try encodedRecord ?? JSONEncoder().encode(Record(identity))
        let lease = try authority.acquireIdentityMutation()
        defer { lease.release() }
        // The policy decision was prepared before acquiring the nonblocking
        // writer lock. Recheck the actual Keychain context before mutation.
        let current = try read(accessGroup: accessGroup, service: service, account: account, operations: operations)
        switch expected {
        case .absent:
            guard current == nil else { throw NativeIdentityError.keychain(errSecDuplicateItem) }
        case .nativeSeed(let seed):
            guard current == seed else {
                _ = try lease.invalidate()
                throw NativeIdentityError.changed
            }
        case .identity(let expected):
            guard let current, let record = try? JSONDecoder().decode(Record.self, from: current),
                  let actual = try? record.identity(), actual.revision == expected.revision,
                  actual.publicKeyRaw == expected.publicKeyRaw,
                  actual.requiresAppUnlock == expected.requiresAppUnlock else {
                _ = try lease.invalidate()
                throw NativeIdentityError.changed
            }
        case .legacyCopy(let original):
            #if os(macOS)
            guard current == nil else { throw NativeIdentityError.keychain(errSecDuplicateItem) }
            guard try readLegacy(service: service, account: account, operations: operations) == original else {
                _ = try lease.invalidate()
                throw NativeIdentityError.changed
            }
            #else
            throw NativeIdentityError.changed
            #endif
        }
        // This commit closes public trust before any private-record write.
        // A Keychain failure never restores the older authority.
        let generation = try lease.invalidate()
        let q = query(accessGroup: accessGroup, service: service, account: account)
        let status: OSStatus
        if updating {
            status = operations.update(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        } else {
            var attributes = q
            attributes[kSecValueData as String] = data
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = operations.add(attributes as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw NativeIdentityError.keychain(status) }
        guard let verified = try read(accessGroup: accessGroup, service: service, account: account, operations: operations), verified == data else {
            throw NativeIdentityError.changed
        }
        _ = try JSONDecoder().decode(Record.self, from: verified).identity()
        try lease.install(identity.pushAuthority, generation: generation)
    }
}
