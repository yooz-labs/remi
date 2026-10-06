import CryptoKit
import Darwin
import Foundation
import SQLite3

/// Mandatory pre-mutation authority barrier for every durable identity writer.
/// Failed invalidation blocks Keychain mutation. A later Keychain failure leaves
/// authority invalidated; SQLite and Keychain are not a distributed transaction.
protocol NativeIdentityAuthorityBarrier {
    func acquireIdentityMutation() throws -> NativeIdentityMutationLease
    func reconcileObservedIdentity(publicKey: Data?, revision: String?, requiresAppUnlock: Bool?) throws
}

enum NativePushStateError: Error { case unavailable, corrupt, invalid, capacity, changed, busy }

/// Public identity authority lives in a durable SQLite transaction, separately
/// from the private Keychain record. Separate app/NSE connections observe the
/// latest committed authority. Caller-owned advisory leases serialize writers;
/// no SQLite transaction remains open during Keychain or authentication calls.
final class NativePushState: NativeIdentityAuthorityBarrier {
    struct Authority: Equatable { let publicKey: Data; let revision: String; let requiresAppUnlock: Bool }
    struct MachineTrust: Equatable {
        let rid: Data
        let machinePublicKey: Data
        let endpoint: String
        let authority: Authority
    }
    struct ContentRecord: Equatable {
        let rid: Data
        let collapseId: String
        let revision: Int64
        let kind: Int
        let nonce: Data
        let digest: Data
        let issuedAt: Int64
        let expiresAt: Int64
    }
    enum ContentOutcome: Equatable { case publish, duplicate, dismiss }
    private let maximumMachines: Int
    private let maximumEntries: Int
    private var database: OpaquePointer?
    private let mutationLock: URL
    private let connectionLock = NSRecursiveLock()
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(file: URL, maximumMachines: Int = 32, maximumEntries: Int = 2048) throws {
        guard (1...32).contains(maximumMachines), (1...2048).contains(maximumEntries) else { throw NativePushStateError.invalid }
        self.maximumMachines = maximumMachines
        self.maximumEntries = maximumEntries
        guard file.isFileURL else { throw NativePushStateError.unavailable }
        mutationLock = file.appendingPathExtension("identity-lock")
        let status = sqlite3_open_v2(file.path, &database,
                                    SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        guard status == SQLITE_OK else {
            if let database { sqlite3_close(database) }
            database = nil
            throw NativePushStateError.unavailable
        }
        do {
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            guard sqlite3_busy_timeout(database, 1000) == SQLITE_OK else { throw NativePushStateError.unavailable }
            try execute("PRAGMA journal_mode=WAL")
            try execute("PRAGMA synchronous=FULL")
            try transaction {
                let version = try integer("PRAGMA user_version")
                let application = try integer("PRAGMA application_id")
                if version == 0 && application == 0 {
                    guard try integer("SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'") == 0 else {
                        throw NativePushStateError.corrupt
                    }
                    try execute("CREATE TABLE authority_generation (slot INTEGER PRIMARY KEY CHECK(slot=1), generation INTEGER NOT NULL CHECK(generation>=0))")
                    try execute("INSERT INTO authority_generation VALUES(1,0)")
                    try execute("CREATE TABLE identity_authority (slot INTEGER PRIMARY KEY CHECK(slot=1), public_key BLOB NOT NULL CHECK(length(public_key)=32), revision TEXT NOT NULL CHECK(length(revision)=36), requires_unlock INTEGER NOT NULL CHECK(requires_unlock IN(0,1)))")
                    try execute("PRAGMA application_id=1380798514") // RMP2
                    try execute("PRAGMA user_version=2")
                } else if version == 1 && application == 1380798514 {
                    // Legacy authority has no reliable protection policy. Close
                    // it rather than assuming its private identity is unprotected.
                    guard try integer("SELECT generation FROM authority_generation WHERE slot=1") < Int64.max else {
                        throw NativePushStateError.capacity
                    }
                    try execute("ALTER TABLE identity_authority ADD COLUMN requires_unlock INTEGER NOT NULL DEFAULT 1 CHECK(requires_unlock IN(0,1))")
                    try execute("DELETE FROM identity_authority")
                    try execute("UPDATE authority_generation SET generation=generation+1 WHERE slot=1")
                    try execute("PRAGMA user_version=2")
                } else if version != 2 || application != 1380798514 { throw NativePushStateError.corrupt }
                guard try integer("SELECT generation FROM authority_generation WHERE slot=1") >= 0 else {
                    throw NativePushStateError.corrupt
                }
            }
            _ = try currentAuthority()
        } catch {
            if let database { sqlite3_close(database) }
            database = nil
            throw error
        }
    }
    deinit { if let database { sqlite3_close(database) } }

    func currentAuthority() throws -> Authority? {
        connectionLock.lock(); defer { connectionLock.unlock() }
        return try statement("SELECT public_key,revision,requires_unlock FROM identity_authority WHERE slot=1") { stmt in
            let status = sqlite3_step(stmt)
            if status == SQLITE_DONE { return nil }
            guard status == SQLITE_ROW, sqlite3_column_type(stmt, 0) == SQLITE_BLOB,
                  sqlite3_column_bytes(stmt, 0) == 32, let bytes = sqlite3_column_blob(stmt, 0),
                  sqlite3_column_type(stmt, 1) == SQLITE_TEXT, let text = sqlite3_column_text(stmt, 1) else {
                throw NativePushStateError.corrupt
            }
            guard sqlite3_column_type(stmt, 2) == SQLITE_INTEGER,
                  [0, 1].contains(sqlite3_column_int(stmt, 2)) else { throw NativePushStateError.corrupt }
            let protected = sqlite3_column_int(stmt, 2) == 1
            let key = Data(bytes: bytes, count: 32)
            let revision = String(cString: text)
            try Self.validate(key, revision)
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw NativePushStateError.corrupt }
            return Authority(publicKey: key, revision: revision, requiresAppUnlock: protected)
        }
    }

    // Fail-closed construction surface for the next red-first persistence tranche.
    // No push caller is connected until the actual verified decoder/trust bridge.
    func authorityGeneration() throws -> Int64 {
        connectionLock.lock(); defer { connectionLock.unlock() }
        return try integer("SELECT generation FROM authority_generation WHERE slot=1")
    }
    func installMachineTrust(_ trust: MachineTrust, generation: Int64) throws { throw NativePushStateError.unavailable }
    func machineTrust(rid: Data) throws -> MachineTrust? { throw NativePushStateError.unavailable }
    func forgetMachine(rid: Data) throws { throw NativePushStateError.unavailable }
    func recordVerifiedContent(_ content: ContentRecord, trust: MachineTrust, now: Int64) throws -> ContentOutcome {
        throw NativePushStateError.unavailable
    }
    func reverifyLatestContent(_ content: ContentRecord, trust: MachineTrust, now: Int64) throws {
        throw NativePushStateError.unavailable
    }

    /// An observed deletion, corruption, read failure or different revision
    /// closes prior authority. A successful later read never installs it again.
    /// External Keychain changes remain unobservable until an app reader runs;
    /// the NSE has only this public ledger and never reads the Dpk private item.
    func reconcileObservedIdentity(publicKey: Data?, revision: String?, requiresAppUnlock: Bool?) throws {
        guard let installed = try currentAuthority(),
              installed.publicKey != publicKey || installed.revision != revision || installed.requiresAppUnlock != requiresAppUnlock else { return }
        let lease = try acquireIdentityMutation()
        defer { lease.release() }
        // Another writer may have changed authority before lock acquisition.
        if let latest = try currentAuthority(),
           latest.publicKey != publicKey || latest.revision != revision || latest.requiresAppUnlock != requiresAppUnlock {
            _ = try lease.invalidateIdentityAuthority()
        }
    }

    func acquireIdentityMutation() throws -> NativeIdentityMutationLease {
        let descriptor = open(mutationLock.path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw NativePushStateError.unavailable }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let busy = errno == EWOULDBLOCK
            close(descriptor)
            throw busy ? NativePushStateError.busy : NativePushStateError.unavailable
        }
        return NativeIdentityMutationLease(state: self, descriptor: descriptor)
    }

    fileprivate func invalidate() throws -> Int64 {
        try transaction {
            let generation = try integer("SELECT generation FROM authority_generation WHERE slot=1")
            guard generation < Int64.max else { throw NativePushStateError.capacity }
            try execute("UPDATE authority_generation SET generation=generation+1 WHERE slot=1")
            try execute("DELETE FROM identity_authority")
            return generation + 1
        }
    }
    fileprivate func install(publicKey: Data, revision: String, requiresAppUnlock: Bool, generation: Int64) throws {
        try Self.validate(publicKey, revision)
        try transaction {
            guard generation > 0,
                  try integer("SELECT generation FROM authority_generation WHERE slot=1") == generation,
                  try currentAuthority() == nil else { throw NativePushStateError.changed }
            try statement("INSERT INTO identity_authority(slot,public_key,revision,requires_unlock) VALUES(1,?,?,?)") { stmt in
                let bound = publicKey.withUnsafeBytes { sqlite3_bind_blob(stmt, 1, $0.baseAddress, 32, Self.transient) }
                guard bound == SQLITE_OK,
                      sqlite3_bind_text(stmt, 2, revision, -1, Self.transient) == SQLITE_OK,
                      sqlite3_bind_int(stmt, 3, requiresAppUnlock ? 1 : 0) == SQLITE_OK,
                      sqlite3_step(stmt) == SQLITE_DONE else { throw NativePushStateError.unavailable }
            }
        }
    }

    private static func validate(_ publicKey: Data, _ revision: String) throws {
        guard publicKey.count == 32, !NativeEd25519PublicKey.isSmallOrder(publicKey),
              (try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey)) != nil,
              revision.utf8.count == 36, UUID(uuidString: revision) != nil else { throw NativePushStateError.invalid }
    }
    private func execute(_ sql: String) throws {
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else { throw NativePushStateError.unavailable }
    }
    private func statement<T>(_ sql: String, _ body: (OpaquePointer) throws -> T) throws -> T {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw NativePushStateError.corrupt
        }
        defer { sqlite3_finalize(stmt) }
        return try body(stmt)
    }
    private func integer(_ sql: String) throws -> Int64 {
        try statement(sql) { stmt in
            guard sqlite3_step(stmt) == SQLITE_ROW, sqlite3_column_type(stmt, 0) == SQLITE_INTEGER else {
                throw NativePushStateError.corrupt
            }
            let value = sqlite3_column_int64(stmt, 0)
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw NativePushStateError.corrupt }
            return value
        }
    }
    private func transaction<T>(_ body: () throws -> T) throws -> T {
        connectionLock.lock(); defer { connectionLock.unlock() }
        try execute("BEGIN IMMEDIATE")
        do { let result = try body(); try execute("COMMIT"); return result }
        catch { try? execute("ROLLBACK"); throw error }
    }
}

/// A synchronous, bounded writer lease. It cannot outlive release or authorize
/// installation for any generation except its own latest durable invalidation.
final class NativeIdentityMutationLease {
    private let state: NativePushState
    private var descriptor: Int32
    private var generation: Int64?
    fileprivate init(state: NativePushState, descriptor: Int32) {
        self.state = state; self.descriptor = descriptor
    }
    deinit { release() }
    func invalidateIdentityAuthority() throws -> Int64 {
        guard descriptor >= 0 else { throw NativePushStateError.changed }
        let token = try state.invalidate()
        generation = token
        return token
    }
    func installIdentityAuthority(publicKey: Data, revision: String, requiresAppUnlock: Bool, generation: Int64) throws {
        guard descriptor >= 0, self.generation == generation else { throw NativePushStateError.changed }
        try state.install(publicKey: publicKey, revision: revision, requiresAppUnlock: requiresAppUnlock, generation: generation)
    }
    func release() {
        guard descriptor >= 0 else { return }
        flock(descriptor, LOCK_UN)
        close(descriptor)
        descriptor = -1
        generation = nil
    }
}
