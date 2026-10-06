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
                } else if ![2, 3, 4].contains(version) || application != 1380798514 { throw NativePushStateError.corrupt }
                if try integer("PRAGMA user_version") == 2 {
                    try execute("CREATE TABLE machine_trust (rid BLOB PRIMARY KEY CHECK(length(rid)=16), machine_key BLOB NOT NULL CHECK(length(machine_key)=32), endpoint TEXT NOT NULL, device_key BLOB NOT NULL CHECK(length(device_key)=32), identity_revision TEXT NOT NULL CHECK(length(identity_revision)=36), requires_unlock INTEGER NOT NULL CHECK(requires_unlock IN(0,1)), generation INTEGER NOT NULL CHECK(generation>0))")
                    try execute("PRAGMA user_version=3")
                }
                if try integer("PRAGMA user_version") == 3 {
                    try execute("CREATE TABLE push_nonce (rid BLOB NOT NULL CHECK(length(rid)=16), nonce BLOB NOT NULL CHECK(length(nonce)=32), digest BLOB NOT NULL CHECK(length(digest)=32), retain_until INTEGER NOT NULL, PRIMARY KEY(rid,nonce))")
                    try execute("CREATE TABLE push_collapse (rid BLOB NOT NULL CHECK(length(rid)=16), collapse_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), digest BLOB NOT NULL CHECK(length(digest)=32), terminal INTEGER NOT NULL CHECK(terminal IN(0,1)), max_expiry INTEGER NOT NULL, retain_until INTEGER NOT NULL, PRIMARY KEY(rid,collapse_id))")
                    try execute("PRAGMA user_version=4")
                }
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
                  sqlite3_column_type(stmt, 1) == SQLITE_TEXT else {
                throw NativePushStateError.corrupt
            }
            guard sqlite3_column_type(stmt, 2) == SQLITE_INTEGER,
                  [0, 1].contains(sqlite3_column_int(stmt, 2)) else { throw NativePushStateError.corrupt }
            let protected = sqlite3_column_int(stmt, 2) == 1
            let key = Data(bytes: bytes, count: 32)
            let revision = try self.text(stmt, 1)
            try Self.validate(key, revision)
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw NativePushStateError.corrupt }
            return Authority(publicKey: key, revision: revision, requiresAppUnlock: protected)
        }
    }

    // No push caller is connected until the actual verified decoder/trust bridge.
    func authorityGeneration() throws -> Int64 {
        connectionLock.lock(); defer { connectionLock.unlock() }
        return try integer("SELECT generation FROM authority_generation WHERE slot=1")
    }
    /// Only the native verified-READY caller installs this public completed trust.
    /// Identity writers install public Dpk authority, never machine trust.
    func installMachineTrust(_ trust: MachineTrust, generation: Int64) throws {
        try Self.validateTrust(trust)
        try transaction {
            guard generation > 0, try authorityGeneration() == generation,
                  try currentAuthority() == trust.authority else { throw NativePushStateError.changed }
            if try machineTrust(rid: trust.rid) == nil {
                guard try integer("SELECT count(*) FROM machine_trust") < Int64(maximumMachines) else { throw NativePushStateError.capacity }
            }
            try statement("INSERT INTO machine_trust VALUES(?,?,?,?,?,?,?) ON CONFLICT(rid) DO UPDATE SET machine_key=excluded.machine_key,endpoint=excluded.endpoint,device_key=excluded.device_key,identity_revision=excluded.identity_revision,requires_unlock=excluded.requires_unlock,generation=excluded.generation") { stmt in
                try bind(trust.rid, to: stmt, at: 1)
                try bind(trust.machinePublicKey, to: stmt, at: 2)
                try bind(trust.endpoint, to: stmt, at: 3)
                try bind(trust.authority.publicKey, to: stmt, at: 4)
                try bind(trust.authority.revision, to: stmt, at: 5)
                guard sqlite3_bind_int(stmt, 6, trust.authority.requiresAppUnlock ? 1 : 0) == SQLITE_OK,
                      sqlite3_bind_int64(stmt, 7, generation) == SQLITE_OK else { throw NativePushStateError.unavailable }
                try complete(stmt)
            }
        }
    }
    func machineTrust(rid: Data) throws -> MachineTrust? {
        guard rid.count == 16 else { throw NativePushStateError.invalid }
        connectionLock.lock(); defer { connectionLock.unlock() }
        // One SQLite statement sees one consistent cross-process snapshot.
        return try statement("SELECT t.machine_key,t.endpoint,t.device_key,t.identity_revision,t.requires_unlock FROM machine_trust t JOIN identity_authority a ON a.slot=1 AND a.public_key=t.device_key AND a.revision=t.identity_revision AND a.requires_unlock=t.requires_unlock JOIN authority_generation g ON g.slot=1 AND g.generation=t.generation WHERE t.rid=?") { stmt in
            try bind(rid, to: stmt, at: 1)
            let status = sqlite3_step(stmt)
            if status == SQLITE_DONE { return nil }
            guard status == SQLITE_ROW, sqlite3_column_type(stmt, 4) == SQLITE_INTEGER,
                  [0, 1].contains(sqlite3_column_int(stmt, 4)) else { throw NativePushStateError.corrupt }
            let trust = MachineTrust(rid: rid, machinePublicKey: try blob(stmt, 0), endpoint: try text(stmt, 1),
                authority: Authority(publicKey: try blob(stmt, 2), revision: try text(stmt, 3), requiresAppUnlock: sqlite3_column_int(stmt, 4) == 1))
            try Self.validateTrust(trust)
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw NativePushStateError.corrupt }
            return trust
        }
    }
    func forgetMachine(rid: Data) throws {
        guard rid.count == 16 else { throw NativePushStateError.invalid }
        try transaction {
            try statement("DELETE FROM machine_trust WHERE rid=?") { stmt in
                try bind(rid, to: stmt, at: 1); try complete(stmt)
            }
            // Replay and terminal records are deliberately retained through re-pair.
        }
    }
    /// The original-byte cryptographic decoder must verify before this boundary.
    /// This transaction commits replay/lifecycle state before publication/deletion.
    /// It does not treat an outer field or notification category as verification.
    func recordVerifiedContent(_ content: ContentRecord, trust: MachineTrust, now: Int64) throws -> ContentOutcome {
        try Self.validateContent(content, now: now)
        return try transaction {
            try requireCurrentTrust(trust, rid: content.rid)
            try pruneExpired(now: now)
            if let digest = try nonceDigest(content) {
                guard digest == content.digest else { throw NativePushStateError.changed }
                return .duplicate
            }
            let previous = try collapse(content)
            if let previous {
                guard content.revision > previous.revision,
                      !previous.terminal || content.kind == 6 else { throw NativePushStateError.changed }
            }
            let needed: Int64 = previous == nil ? 2 : 1
            let count = try integer("SELECT (SELECT count(*) FROM push_nonce)+(SELECT count(*) FROM push_collapse)")
            guard count + needed <= Int64(maximumEntries) else { throw NativePushStateError.capacity }
            let terminal = content.kind == 6 || previous?.terminal == true
            let maxExpiry = max(content.expiresAt, previous?.maxExpiry ?? 0)
            let retention = max(maxExpiry + 60, previous?.retention ?? 0,
                                terminal ? content.issuedAt + 3600 + 120 : 0)
            try statement("INSERT INTO push_nonce VALUES(?,?,?,?)") { stmt in
                try bind(content.rid, to: stmt, at: 1); try bind(content.nonce, to: stmt, at: 2)
                try bind(content.digest, to: stmt, at: 3); try bind(content.expiresAt + 60, to: stmt, at: 4)
                try complete(stmt)
            }
            try statement("INSERT INTO push_collapse VALUES(?,?,?,?,?,?,?) ON CONFLICT(rid,collapse_id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,terminal=excluded.terminal,max_expiry=excluded.max_expiry,retain_until=excluded.retain_until") { stmt in
                try bind(content.rid, to: stmt, at: 1); try bind(content.collapseId, to: stmt, at: 2)
                try bind(content.revision, to: stmt, at: 3); try bind(content.digest, to: stmt, at: 4)
                try bind(terminal ? Int64(1) : 0, to: stmt, at: 5); try bind(maxExpiry, to: stmt, at: 6)
                try bind(retention, to: stmt, at: 7); try complete(stmt)
            }
            return terminal ? .dismiss : .publish
        }
    }
    /// Actions reverify the same capsule independently and require the identical
    /// latest LIVE durable digest; an accepted older nonce grants no authority.
    func reverifyLatestContent(_ content: ContentRecord, trust: MachineTrust, now: Int64) throws {
        try Self.validateContent(content, now: now)
        try transaction {
            try requireCurrentTrust(trust, rid: content.rid)
            guard content.kind != 6, let latest = try collapse(content), !latest.terminal,
                  latest.retention > now, latest.revision == content.revision,
                  latest.digest == content.digest, try nonceDigest(content) == content.digest else {
                throw NativePushStateError.changed
            }
        }
    }

    private struct CollapseRecord {
        let revision: Int64; let digest: Data; let terminal: Bool; let maxExpiry: Int64; let retention: Int64
    }
    private func requireCurrentTrust(_ trust: MachineTrust, rid: Data) throws {
        guard rid == trust.rid, try currentAuthority() == trust.authority,
              try machineTrust(rid: rid) == trust else { throw NativePushStateError.changed }
    }
    private static func validateContent(_ content: ContentRecord, now: Int64) throws {
        let safe: Int64 = 9_007_199_254_740_991
        let encoded = content.collapseId.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "=="
        guard content.rid.count == 16, content.nonce.count == 32, content.digest.count == 32,
              content.collapseId.utf8.count == 22, let collapse = Data(base64Encoded: encoded), collapse.count == 16,
              collapse.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == content.collapseId,
              content.revision > 0, content.revision <= safe, (1...6).contains(content.kind),
              now >= 0, now <= safe - 4000, content.issuedAt >= 0, content.issuedAt <= now + 60,
              content.expiresAt > content.issuedAt, content.expiresAt > now, content.expiresAt <= safe - 4000,
              content.expiresAt - content.issuedAt <= 3600 else { throw NativePushStateError.invalid }
    }
    private func pruneExpired(now: Int64) throws {
        for table in ["push_nonce", "push_collapse"] {
            try statement("DELETE FROM \(table) WHERE retain_until<=?") { stmt in
                try bind(now, to: stmt, at: 1); try complete(stmt)
            }
        }
    }
    private func nonceDigest(_ content: ContentRecord) throws -> Data? {
        try statement("SELECT digest FROM push_nonce WHERE rid=? AND nonce=?") { stmt in
            try bind(content.rid, to: stmt, at: 1); try bind(content.nonce, to: stmt, at: 2)
            let status = sqlite3_step(stmt)
            if status == SQLITE_DONE { return nil }
            guard status == SQLITE_ROW else { throw NativePushStateError.corrupt }
            let result = try blob(stmt, 0)
            guard result.count == 32, sqlite3_step(stmt) == SQLITE_DONE else { throw NativePushStateError.corrupt }
            return result
        }
    }
    private func collapse(_ content: ContentRecord) throws -> CollapseRecord? {
        try statement("SELECT revision,digest,terminal,max_expiry,retain_until FROM push_collapse WHERE rid=? AND collapse_id=?") { stmt in
            try bind(content.rid, to: stmt, at: 1); try bind(content.collapseId, to: stmt, at: 2)
            let status = sqlite3_step(stmt)
            if status == SQLITE_DONE { return nil }
            guard status == SQLITE_ROW, [0,2,3,4].allSatisfy({ sqlite3_column_type(stmt, Int32($0)) == SQLITE_INTEGER }),
                  [0,1].contains(sqlite3_column_int(stmt, 2)) else { throw NativePushStateError.corrupt }
            let value = CollapseRecord(revision: sqlite3_column_int64(stmt, 0), digest: try blob(stmt, 1),
                terminal: sqlite3_column_int(stmt, 2) == 1, maxExpiry: sqlite3_column_int64(stmt, 3), retention: sqlite3_column_int64(stmt, 4))
            guard value.revision > 0, value.revision <= 9_007_199_254_740_991, value.digest.count == 32,
                  value.maxExpiry >= 0, value.maxExpiry <= 9_007_199_254_736_991, value.retention <= 9_007_199_254_740_991,
                  value.retention >= value.maxExpiry + 60, sqlite3_step(stmt) == SQLITE_DONE else { throw NativePushStateError.corrupt }
            return value
        }
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
            try execute("DELETE FROM machine_trust")
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

    private static func validateTrust(_ trust: MachineTrust) throws {
        try validate(trust.authority.publicKey, trust.authority.revision)
        guard trust.machinePublicKey.count == 32, !NativeEd25519PublicKey.isSmallOrder(trust.machinePublicKey),
              (try? Curve25519.Signing.PublicKey(rawRepresentation: trust.machinePublicKey)) != nil,
              trust.rid == Data(SHA256.hash(data: trust.machinePublicKey).prefix(16)),
              trust.endpoint.utf8.count <= 2048,
              let url = URLComponents(string: trust.endpoint), url.scheme == "https", let host = url.host, !host.isEmpty,
              host == host.lowercased(), url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty, url.port != 443, url.string == trust.endpoint else { throw NativePushStateError.invalid }
        if let port = url.port, !(0...65535).contains(port) { throw NativePushStateError.invalid }
        // Re-emit the parsed port to reject zero prefixes and an empty port, as the shared URL origin does.
        var canonical = url
        canonical.port = url.port
        guard canonical.string == trust.endpoint else { throw NativePushStateError.invalid }
    }
    private func bind(_ value: Data, to stmt: OpaquePointer, at index: Int32) throws {
        let status = value.withUnsafeBytes { sqlite3_bind_blob(stmt, index, $0.baseAddress, Int32(value.count), Self.transient) }
        guard status == SQLITE_OK else { throw NativePushStateError.unavailable }
    }
    private func bind(_ value: String, to stmt: OpaquePointer, at index: Int32) throws {
        guard sqlite3_bind_text(stmt, index, value, -1, Self.transient) == SQLITE_OK else { throw NativePushStateError.unavailable }
    }
    private func bind(_ value: Int64, to stmt: OpaquePointer, at index: Int32) throws {
        guard sqlite3_bind_int64(stmt, index, value) == SQLITE_OK else { throw NativePushStateError.unavailable }
    }
    private func blob(_ stmt: OpaquePointer, _ index: Int32) throws -> Data {
        guard sqlite3_column_type(stmt, index) == SQLITE_BLOB, (1...32).contains(sqlite3_column_bytes(stmt, index)), let bytes = sqlite3_column_blob(stmt, index) else { throw NativePushStateError.corrupt }
        return Data(bytes: bytes, count: Int(sqlite3_column_bytes(stmt, index)))
    }
    private func text(_ stmt: OpaquePointer, _ index: Int32) throws -> String {
        guard sqlite3_column_type(stmt, index) == SQLITE_TEXT, (1...2048).contains(sqlite3_column_bytes(stmt, index)), let bytes = sqlite3_column_text(stmt, index),
              let value = String(bytes: UnsafeBufferPointer(start: bytes, count: Int(sqlite3_column_bytes(stmt, index))), encoding: .utf8) else {
            throw NativePushStateError.corrupt
        }
        return value
    }
    private func complete(_ stmt: OpaquePointer) throws {
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw NativePushStateError.unavailable }
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
