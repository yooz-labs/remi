import Darwin
import Foundation
import SQLite3

/// Private cleanup index for local iPhone notifications (#1720). It grants no push or answer authority.
/// Removal APIs have no completion: retirement records invalidation, never a claim of OS removal.
final class LocalNoticeLedger: @unchecked Sendable {
    enum Effect: Int64, Sendable { case prepared = 1, adding, settledSuccess, settledError, crashUncertain }
    enum Activity: Int64, Sendable { case active = 1, invalidated }
    enum Classification: Equatable { case currentActive, historicalActive, invalidated, retired, unknown, quarantined }
    struct Ticket: Sendable, Equatable {
        let requestID: String
        let owner: Data
        let question: Data
        let sequence: Int64
    }
    struct Record: Sendable, Equatable {
        let ticket: Ticket
        let effect: Effect
        let activity: Activity
        let removalRequested: Bool
    }

    static let maximumRows = 1_024
    static let maximumUncertain = 128
    static let maximumLogicalBytes = 256 * 1_024
    static let maximumPhysicalBytes: Int64 = 8 * 1_024 * 1_024
    // 512 4-KiB pages leaves room for a complete rollback journal and cleanup work.
    private static let maximumPages: Int64 = 512
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    private let lock = NSRecursiveLock()
    private var file: URL
    private var database: OpaquePointer?
    private var directoryFD: Int32 = -1
    private var directoryPath = ""
    private var directoryDevice: dev_t = 0
    private var directoryInode: ino_t = 0
    private var ownerLock: Int32 = -1
    /// Historical indexes survive restart for cleanup, but are never adopted as current authority.
    private var currentOwners: Set<Data> = []

    init(directory: URL, createIfMissing: Bool = true) throws {
        guard directory.isFileURL else { throw LocalNoticeError.invalid }
        self.file = directory.appendingPathComponent("local-notifications.sqlite")
        let fm = FileManager.default
        do {
            var initial = stat()
            if lstat(directory.path, &initial) == 0 {
                guard (initial.st_mode & S_IFMT) == S_IFDIR, initial.st_uid == getuid() else { throw LocalNoticeError.unavailable }
            } else if errno == ENOENT {
                guard createIfMissing else { throw LocalNoticeError.unavailable }
                try fm.createDirectory(at: directory, withIntermediateDirectories: true,
                    attributes: Self.protection(mode: 0o700))
            } else { throw LocalNoticeError.unavailable }
            directoryFD = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
            var opened = stat()
            guard directoryFD >= 0, fstat(directoryFD, &opened) == 0,
                  (opened.st_mode & S_IFMT) == S_IFDIR, opened.st_uid == getuid(),
                  fchmod(directoryFD, S_IRWXU) == 0 else { throw LocalNoticeError.unavailable }
            directoryDevice = opened.st_dev; directoryInode = opened.st_ino
            var canonical = [CChar](repeating: 0, count: Int(MAXPATHLEN))
            guard fcntl(directoryFD, F_GETPATH, &canonical) == 0 else { throw LocalNoticeError.unavailable }
            directoryPath = String(cString: canonical)
            try verifyDirectory()
            file = URL(fileURLWithPath: directoryPath, isDirectory: true).appendingPathComponent("local-notifications.sqlite")
            try fm.setAttributes(Self.protection(mode: 0o700), ofItemAtPath: directoryPath)
            #if os(iOS)
            var protectedDirectory = URL(fileURLWithPath: directoryPath, isDirectory: true)
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try protectedDirectory.setResourceValues(values)
            #endif
            ownerLock = openat(directoryFD, "local-notifications.lock", O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
            guard ownerLock >= 0, flock(ownerLock, LOCK_EX | LOCK_NB) == 0 else { throw LocalNoticeError.busy }
            var lockStat = stat()
            guard fstat(ownerLock, &lockStat) == 0, (lockStat.st_mode & S_IFMT) == S_IFREG,
                  lockStat.st_uid == getuid(), fchmod(ownerLock, S_IRUSR | S_IWUSR) == 0 else { throw LocalNoticeError.unavailable }
            try Self.checkExistingFile(file)
            if !createIfMissing { try checkExistingDatabaseHeader() }
            try verifyDirectory()
            let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW | (createIfMissing ? SQLITE_OPEN_CREATE : 0)
            let status = sqlite3_open_v2(file.path, &database, flags, nil)
            guard status == SQLITE_OK else { throw Self.sqliteError(status) }
            try verifyDirectory()
            try fm.setAttributes(Self.protection(mode: 0o600), ofItemAtPath: file.path)
            guard sqlite3_busy_timeout(database, 1_000) == SQLITE_OK else { throw LocalNoticeError.unavailable }
            try execute("PRAGMA journal_mode=DELETE")
            try execute("PRAGMA synchronous=FULL")
            try execute("PRAGMA temp_store=MEMORY")
            try execute("PRAGMA foreign_keys=ON")
            guard try integer("PRAGMA page_size") <= 4_096,
                  try integer("PRAGMA max_page_count=512") <= Self.maximumPages else { throw LocalNoticeError.capacity }
            try transaction(checkBudget: false) {
                let version = try integer("PRAGMA user_version"), application = try integer("PRAGMA application_id")
                if version == 0 && application == 0 {
                    guard createIfMissing else { throw LocalNoticeError.corrupt }
                    guard try integer("SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'") == 0 else { throw LocalNoticeError.corrupt }
                    try execute("CREATE TABLE owner (id BLOB PRIMARY KEY CHECK(length(id)=32), highwater INTEGER NOT NULL CHECK(highwater>=0), retired INTEGER NOT NULL CHECK(retired IN(0,1)), quarantined INTEGER NOT NULL CHECK(quarantined IN(0,1)))")
                    try execute("CREATE TABLE ticket (id TEXT PRIMARY KEY CHECK(length(id)=36), owner BLOB NOT NULL REFERENCES owner(id), question BLOB NOT NULL CHECK(length(question)=32), seq INTEGER NOT NULL CHECK(seq>0), effect INTEGER NOT NULL CHECK(effect BETWEEN 1 AND 5), activity INTEGER NOT NULL CHECK(activity IN(1,2)), removal INTEGER NOT NULL CHECK(removal IN(0,1)), UNIQUE(owner,seq))")
                    try execute("CREATE TABLE retired_range (owner BLOB NOT NULL REFERENCES owner(id), lo INTEGER NOT NULL CHECK(lo>0), hi INTEGER NOT NULL CHECK(hi>=lo), PRIMARY KEY(owner,lo))")
                    try execute("PRAGMA application_id=1380797520") // RMLP
                    try execute("PRAGMA user_version=1")
                } else if ![1, 2].contains(version) || application != 1380797520 { throw LocalNoticeError.corrupt }
                if version != 2 {
                    try execute("ALTER TABLE owner ADD COLUMN pending_forget INTEGER NOT NULL DEFAULT 0 CHECK(pending_forget IN(0,1))")
                    try execute("PRAGMA user_version=2")
                }
                // Only the exclusive owner can open this store, so prior ADDING calls have lost their process.
                try execute("UPDATE ticket SET effect=5 WHERE effect=2")
                try validate()
            }
            try budget()
        } catch {
            if let database { sqlite3_close(database) }; database = nil
            if ownerLock >= 0 { _ = flock(ownerLock, LOCK_UN); Darwin.close(ownerLock); ownerLock = -1 }
            if directoryFD >= 0 { Darwin.close(directoryFD); directoryFD = -1 }
            throw error
        }
    }

    deinit { close() }

    func close() {
        lock.lock(); defer { lock.unlock() }
        if let database { sqlite3_close(database); self.database = nil }
        if ownerLock >= 0 { _ = flock(ownerLock, LOCK_UN); Darwin.close(ownerLock); ownerLock = -1 }
        if directoryFD >= 0 { Darwin.close(directoryFD); directoryFD = -1 }
    }

    /// SQLite still opens its canonical pathname, not a descriptor-relative VFS. The production
    /// caller supplies only a fixed child of iOS's app-private container; this check rejects a
    /// detected replacement but does not claim protection against a concurrent in-container writer.
    private func verifyDirectory() throws {
        var held = stat(), current = stat()
        guard directoryFD >= 0, fstat(directoryFD, &held) == 0, lstat(directoryPath, &current) == 0,
              (held.st_mode & S_IFMT) == S_IFDIR, (current.st_mode & S_IFMT) == S_IFDIR,
              held.st_uid == getuid(), current.st_uid == getuid(), held.st_dev == directoryDevice,
              held.st_ino == directoryInode, current.st_dev == directoryDevice,
              current.st_ino == directoryInode else { throw LocalNoticeError.unavailable }
    }

    private static func protection(mode: Int) -> [FileAttributeKey: Any] {
        var result: [FileAttributeKey: Any] = [.posixPermissions: mode]
        #if os(iOS)
        result[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
        #endif
        return result
    }
    private static func checkExistingFile(_ file: URL) throws {
        var info = stat()
        if lstat(file.path, &info) == 0 {
            guard (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid() else { throw LocalNoticeError.unavailable }
        } else if errno != ENOENT { throw LocalNoticeError.unavailable }
    }

    /// Recovery must not initialize an absent or empty file before detecting prior-state loss.
    private func checkExistingDatabaseHeader() throws {
        let descriptor = openat(directoryFD, "local-notifications.sqlite", O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw LocalNoticeError.unavailable }
        defer { Darwin.close(descriptor) }
        var info = stat(), bytes = [UInt8](repeating: 0, count: 16)
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid() else {
            throw LocalNoticeError.unavailable
        }
        let count = bytes.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, $0.count) }
        guard count >= 0 else { throw LocalNoticeError.unavailable }
        guard count == 16, bytes == Array("SQLite format 3\0".utf8) else { throw LocalNoticeError.corrupt }
    }

    func createOwner(_ owner: Data) throws {
        try withLock {
            guard owner.count == 32 else { throw LocalNoticeError.invalid }
            try transaction {
                try statement("INSERT INTO owner(id,highwater,retired,quarantined) VALUES(?1,0,0,0)") { stmt in
                    try bind(owner, to: stmt, at: 1); try done(stmt)
                }
            }
            currentOwners.insert(owner)
        }
    }

    func prepare(owner: Data, question: Data, requestID: String = UUID().uuidString.lowercased()) throws -> Ticket {
        try withLock {
            guard owner.count == 32, question.count == 32, let uuid = UUID(uuidString: requestID),
                  uuid.uuidString.lowercased() == requestID else { throw LocalNoticeError.invalid }
            guard currentOwners.contains(owner) else { throw LocalNoticeError.changed }
            return try transaction {
                let current = try ownerState(owner)
                guard !current.retired, !current.quarantined else { throw LocalNoticeError.changed }
                guard current.highwater < Int64.max else { throw LocalNoticeError.capacity }
                let sequence = current.highwater + 1
                try statement("UPDATE owner SET highwater=?1 WHERE id=?2 AND highwater=?3 AND retired=0") { stmt in
                    try bind(sequence, to: stmt, at: 1); try bind(owner, to: stmt, at: 2)
                    try bind(current.highwater, to: stmt, at: 3); try done(stmt)
                    guard sqlite3_changes(database) == 1 else { throw LocalNoticeError.changed }
                }
                try statement("INSERT INTO ticket(id,owner,question,seq,effect,activity,removal) VALUES(?1,?2,?3,?4,1,1,0)") { stmt in
                    try bind(requestID, to: stmt, at: 1); try bind(owner, to: stmt, at: 2)
                    try bind(question, to: stmt, at: 3); try bind(sequence, to: stmt, at: 4); try done(stmt)
                }
                return Ticket(requestID: requestID, owner: owner, question: question, sequence: sequence)
            }
        }
    }

    /// Commits the effect boundary before the caller invokes the OS add adapter.
    func beginAdd(_ ticket: Ticket) throws {
        try withLock {
            try transaction {
                let record = try exact(ticket)
                let owner = try ownerState(ticket.owner)
                guard currentOwners.contains(ticket.owner), record.effect == .prepared, record.activity == .active,
                      !owner.retired, !owner.quarantined else { throw LocalNoticeError.changed }
                guard try integer("SELECT count(*) FROM ticket WHERE effect IN (2,5)") < Int64(Self.maximumUncertain) else { throw LocalNoticeError.capacity }
                try update(ticket, sql: "UPDATE ticket SET effect=2 WHERE id=?1")
            }
        }
    }
    func invalidate(_ ticket: Ticket) throws {
        try withLock {
            guard currentOwners.contains(ticket.owner) else { throw LocalNoticeError.changed }
            try transaction { _ = try exact(ticket); try update(ticket, sql: "UPDATE ticket SET activity=2 WHERE id=?1") }
        }
    }
    /// Settlement records only the callback result, not delivery or removal.
    func settle(_ ticket: Ticket, succeeded: Bool) throws {
        try withLock {
            try transaction {
                guard try exact(ticket).effect == .adding else { throw LocalNoticeError.changed }
                try update(ticket, sql: succeeded ? "UPDATE ticket SET effect=3, removal=0 WHERE id=?1" : "UPDATE ticket SET effect=4, removal=0 WHERE id=?1")
            }
        }
    }
    /// Call only after both exact-ID OS removal methods were invoked, not when they were confirmed.
    func removalWasRequested(_ ticket: Ticket) throws {
        try withLock {
            try transaction {
                let record = try exact(ticket)
                guard record.activity == .invalidated, [.settledSuccess, .settledError].contains(record.effect) else { throw LocalNoticeError.changed }
                try update(ticket, sql: "UPDATE ticket SET removal=1 WHERE id=?1")
            }
        }
    }
    func retire(_ ticket: Ticket) throws {
        try withLock {
            try transaction {
                let record = try exact(ticket)
                guard record.activity == .invalidated else { throw LocalNoticeError.changed }
                guard record.effect == .prepared || ([.settledSuccess, .settledError].contains(record.effect) && record.removalRequested) else { throw LocalNoticeError.changed }
                try update(ticket, sql: "DELETE FROM ticket WHERE id=?1")
                try insertRetired(owner: ticket.owner, sequence: ticket.sequence)
            }
        }
    }
    func record(_ ticket: Ticket) throws -> Record { try withLock { try exact(ticket) } }

    /// Only the exact owner index is used for listing; no endpoint or current session census is inferred.
    func records(owner: Data) throws -> [Record] {
        try withLock {
            guard owner.count == 32 else { throw LocalNoticeError.invalid }
            let ids: [String] = try statement("SELECT id FROM ticket WHERE owner=?1 ORDER BY seq") { stmt in
                try bind(owner, to: stmt, at: 1)
                var values: [String] = []
                while true {
                    let code = sqlite3_step(stmt); if code == SQLITE_DONE { break }
                    guard code == SQLITE_ROW, sqlite3_column_type(stmt, 0) == SQLITE_TEXT,
                          let raw = sqlite3_column_text(stmt, 0) else { throw LocalNoticeError.corrupt }
                    let id = String(cString: raw)
                    guard let uuid = UUID(uuidString: id), uuid.uuidString.lowercased() == id,
                          values.count < Self.maximumRows else { throw LocalNoticeError.corrupt }
                    values.append(id)
                }
                return values
            }
            return try ids.map { id in
                guard let value = try recordIfPresent(id) else { throw LocalNoticeError.changed }
                return value
            }
        }
    }

    /// Durable retirement evidence is separate from any currently active in-memory view.
    func classify(_ marker: LocalNoticeMarker, keys: LocalNoticeKeys, systemIdentifier: String) throws -> Classification {
        try withLock {
            guard keys.verifies(marker, systemIdentifier: systemIdentifier) else { return .unknown }
            let owner = try ownerStateIfPresent(marker.ownerIndex)
            guard let owner else { return .unknown }
            guard !owner.quarantined else { return .quarantined }
            if marker.sequence > owner.highwater {
                try quarantine(marker.ownerIndex)
                return .quarantined
            }
            if let existing = try recordIfPresent(marker.requestID) {
                guard existing.ticket.owner == marker.ownerIndex, existing.ticket.question == marker.questionIndex,
                      existing.ticket.sequence == marker.sequence else {
                    try quarantine(marker.ownerIndex)
                    return .quarantined
                }
                if existing.activity == .invalidated { return .invalidated }
                return currentOwners.contains(marker.ownerIndex) ? .currentActive : .historicalActive
            }
            return try inRetired(owner: marker.ownerIndex, sequence: marker.sequence) ? .retired : .unknown
        }
    }

    /// Verify a currently visible historical request without associating its owner with any profile.
    /// A visible PREPARED request contradicts the durable add boundary and quarantines that owner.
    func selectableHistoricalTicket(_ marker: LocalNoticeMarker, keys: LocalNoticeKeys,
                                    systemIdentifier: String) throws -> Ticket? {
        try withLock {
            guard try classify(marker, keys: keys, systemIdentifier: systemIdentifier) == .historicalActive else { return nil }
            let ticket = Ticket(requestID: marker.requestID, owner: marker.ownerIndex,
                                question: marker.questionIndex, sequence: marker.sequence)
            let record = try exact(ticket)
            switch record.effect {
            case .settledSuccess, .settledError, .crashUncertain: return ticket
            case .prepared, .adding:
                try quarantine(marker.ownerIndex)
                throw LocalNoticeError.corrupt
            }
        }
    }

    /// The caller has revalidated one explicitly confirmed, currently visible local request.
    /// No historical owner is adopted, and an uncertain add remains tracked after removal.
    func invalidateSelectedHistorical(_ marker: LocalNoticeMarker, keys: LocalNoticeKeys,
                                      systemIdentifier: String) throws -> Record {
        try withLock {
            guard let ticket = try selectableHistoricalTicket(marker, keys: keys, systemIdentifier: systemIdentifier)
            else { throw LocalNoticeError.changed }
            return try transaction {
                let record = try exact(ticket), owner = try ownerState(ticket.owner)
                guard !currentOwners.contains(ticket.owner), !owner.quarantined, record.activity == .active,
                      [.settledSuccess, .settledError, .crashUncertain].contains(record.effect)
                else { throw LocalNoticeError.changed }
                try update(ticket, sql: "UPDATE ticket SET activity=2 WHERE id=?1")
                return try exact(ticket)
            }
        }
    }

    /// Unassigned tracking records contain no stored destination or profile association.
    func unassignedUncertainTickets() throws -> [Ticket] {
        try withLock {
            let ids = try statement("SELECT id FROM ticket WHERE effect=5 ORDER BY id") { stmt in
                var values: [String] = []
                while true {
                    let result = sqlite3_step(stmt)
                    if result == SQLITE_DONE { return values }
                    guard result == SQLITE_ROW else { throw Self.sqliteError(result) }
                    guard values.count < Self.maximumUncertain, let text = sqlite3_column_text(stmt, 0)
                    else { throw LocalNoticeError.corrupt }
                    values.append(String(cString: text))
                }
            }
            var values: [Ticket] = []
            for id in ids {
                guard let record = try recordIfPresent(id) else { throw LocalNoticeError.changed }
                let owner = try ownerState(record.ticket.owner)
                if !currentOwners.contains(record.ticket.owner) && !owner.quarantined { values.append(record.ticket) }
            }
            return values
        }
    }

    /// Only the separately confirmed, exact, currently unseen historical debt may use this.
    /// Retirement revokes taps and leaves a compact tombstone; it does not confirm OS removal.
    func abandonSelectedUncertain(_ ticket: Ticket) throws {
        try withLock {
            guard !currentOwners.contains(ticket.owner) else { throw LocalNoticeError.changed }
            try transaction {
                let record = try exact(ticket), owner = try ownerState(ticket.owner)
                guard !owner.quarantined, record.effect == .crashUncertain else { throw LocalNoticeError.changed }
                try update(ticket, sql: "DELETE FROM ticket WHERE id=?1")
                try insertRetired(owner: ticket.owner, sequence: ticket.sequence)
            }
        }
    }

    /// Current-process forget may retire exactly this owner; historical owners are not matched by endpoint/key.
    func invalidateOwner(_ owner: Data) throws {
        try withLock {
            guard currentOwners.contains(owner) else { throw LocalNoticeError.changed }
            try transaction {
                _ = try ownerState(owner)
                try statement("UPDATE owner SET retired=1,pending_forget=1 WHERE id=?1 AND (retired=0 OR pending_forget=1)") { stmt in
                    try bind(owner, to: stmt, at: 1); try done(stmt)
                    guard sqlite3_changes(database) == 1 else { throw LocalNoticeError.changed }
                }
                try statement("UPDATE ticket SET activity=2 WHERE owner=?1") { stmt in try bind(owner, to: stmt, at: 1); try done(stmt) }
            }
        }
    }

    /// Opaque owner indexes only. A historical index is not associated with a current profile.
    func pendingForgetOwners() throws -> [Data] {
        try withLock {
            try statement("SELECT id FROM owner WHERE pending_forget=1 ORDER BY id") { stmt in
                var values: [Data] = []
                while true {
                    let result = sqlite3_step(stmt)
                    if result == SQLITE_DONE { return values }
                    guard result == SQLITE_ROW else { throw Self.sqliteError(result) }
                    guard values.count < Self.maximumRows else { throw LocalNoticeError.corrupt }
                    values.append(try blob(stmt, at: 0))
                }
            }
        }
    }

    /// Call only after the current-process Store observes the profile deletion. A prior
    /// process's pending index cannot be mapped to a current profile or completed here.
    func finishForget(_ owner: Data) throws {
        try withLock {
            guard currentOwners.contains(owner) else { throw LocalNoticeError.changed }
            let retiredEmpty = try transaction {
                try statement("UPDATE owner SET pending_forget=0 WHERE id=?1 AND retired=1 AND pending_forget=1") { stmt in
                    try bind(owner, to: stmt, at: 1); try done(stmt)
                    guard sqlite3_changes(database) == 1 else { throw LocalNoticeError.changed }
                }
                // An owner with no allocations cannot have issued a marker or own tickets.
                try statement("DELETE FROM owner WHERE id=?1 AND highwater=0 AND retired=1 AND pending_forget=0 AND NOT EXISTS(SELECT 1 FROM ticket WHERE owner=?1) AND NOT EXISTS(SELECT 1 FROM retired_range WHERE owner=?1)") { stmt in
                    try bind(owner, to: stmt, at: 1); try done(stmt)
                }
                return sqlite3_changes(database) == 1
            }
            if retiredEmpty { currentOwners.remove(owner) }
        }
    }

    func counts() throws -> (owners: Int, tickets: Int, ranges: Int, uncertain: Int) {
        try withLock {
            (Int(try integer("SELECT count(*) FROM owner")), Int(try integer("SELECT count(*) FROM ticket")),
             Int(try integer("SELECT count(*) FROM retired_range")), Int(try integer("SELECT count(*) FROM ticket WHERE effect IN (2,5)")))
        }
    }

    private func quarantine(_ owner: Data) throws {
        try transaction {
            try statement("UPDATE owner SET quarantined=1 WHERE id=?1") { stmt in
                try bind(owner, to: stmt, at: 1); try done(stmt)
                guard sqlite3_changes(database) == 1 else { throw LocalNoticeError.changed }
            }
        }
    }
    private func ownerState(_ owner: Data) throws -> (highwater: Int64, retired: Bool, quarantined: Bool) {
        guard let value = try ownerStateIfPresent(owner) else { throw LocalNoticeError.changed }; return value
    }
    private func ownerStateIfPresent(_ owner: Data) throws -> (highwater: Int64, retired: Bool, quarantined: Bool)? {
        try statement("SELECT highwater,retired,quarantined FROM owner WHERE id=?1") { stmt in
            try bind(owner, to: stmt, at: 1)
            let result = sqlite3_step(stmt)
            if result == SQLITE_DONE { return nil }
            guard result == SQLITE_ROW, sqlite3_column_type(stmt, 0) == SQLITE_INTEGER,
                  sqlite3_column_type(stmt, 1) == SQLITE_INTEGER,
                  sqlite3_column_type(stmt, 2) == SQLITE_INTEGER else { throw LocalNoticeError.corrupt }
            let highwater = sqlite3_column_int64(stmt, 0), retired = sqlite3_column_int64(stmt, 1)
            let quarantined = sqlite3_column_int64(stmt, 2)
            guard highwater >= 0, [0, 1].contains(retired), [0, 1].contains(quarantined),
                  sqlite3_step(stmt) == SQLITE_DONE else { throw LocalNoticeError.corrupt }
            return (highwater, retired == 1, quarantined == 1)
        }
    }
    private func exact(_ ticket: Ticket) throws -> Record {
        guard let result = try recordIfPresent(ticket.requestID), result.ticket == ticket else { throw LocalNoticeError.changed }
        return result
    }
    private func recordIfPresent(_ id: String) throws -> Record? {
        try statement("SELECT owner,question,seq,effect,activity,removal FROM ticket WHERE id=?1") { stmt in
            try bind(id, to: stmt, at: 1)
            let result = sqlite3_step(stmt)
            if result == SQLITE_DONE { return nil }
            guard result == SQLITE_ROW else { throw LocalNoticeError.corrupt }
            let owner = try blob(stmt, at: 0), question = try blob(stmt, at: 1)
            guard [2, 3, 4, 5].allSatisfy({ sqlite3_column_type(stmt, Int32($0)) == SQLITE_INTEGER }),
                  let effect = Effect(rawValue: sqlite3_column_int64(stmt, 3)),
                  let activity = Activity(rawValue: sqlite3_column_int64(stmt, 4)) else { throw LocalNoticeError.corrupt }
            let seq = sqlite3_column_int64(stmt, 2), removal = sqlite3_column_int64(stmt, 5)
            guard seq > 0, [0, 1].contains(removal), sqlite3_step(stmt) == SQLITE_DONE else { throw LocalNoticeError.corrupt }
            return Record(ticket: Ticket(requestID: id, owner: owner, question: question, sequence: seq),
                effect: effect, activity: activity, removalRequested: removal == 1)
        }
    }
    private func insertRetired(owner: Data, sequence: Int64) throws {
        var lo = sequence, hi = sequence
        let ranges: [(Int64, Int64)] = try statement("SELECT lo,hi FROM retired_range WHERE owner=?1 AND lo<=?2 AND hi>=?3 ORDER BY lo") { stmt in
            try bind(owner, to: stmt, at: 1); try bind(sequence == Int64.max ? sequence : sequence + 1, to: stmt, at: 2)
            try bind(sequence - 1, to: stmt, at: 3)
            var result: [(Int64, Int64)] = []
            while true {
                let code = sqlite3_step(stmt); if code == SQLITE_DONE { break }
                guard code == SQLITE_ROW, sqlite3_column_type(stmt, 0) == SQLITE_INTEGER, sqlite3_column_type(stmt, 1) == SQLITE_INTEGER else { throw LocalNoticeError.corrupt }
                result.append((sqlite3_column_int64(stmt, 0), sqlite3_column_int64(stmt, 1)))
            }
            return result
        }
        for range in ranges {
            guard range.0 > 0, range.1 >= range.0 else { throw LocalNoticeError.corrupt }
            lo = min(lo, range.0); hi = max(hi, range.1)
            try statement("DELETE FROM retired_range WHERE owner=?1 AND lo=?2") { stmt in
                try bind(owner, to: stmt, at: 1); try bind(range.0, to: stmt, at: 2); try done(stmt)
            }
        }
        try statement("INSERT INTO retired_range(owner,lo,hi) VALUES(?1,?2,?3)") { stmt in
            try bind(owner, to: stmt, at: 1); try bind(lo, to: stmt, at: 2); try bind(hi, to: stmt, at: 3); try done(stmt)
        }
    }
    private func inRetired(owner: Data, sequence: Int64) throws -> Bool {
        try statement("SELECT count(*) FROM retired_range WHERE owner=?1 AND lo<=?2 AND hi>=?2") { stmt in
            try bind(owner, to: stmt, at: 1); try bind(sequence, to: stmt, at: 2)
            guard sqlite3_step(stmt) == SQLITE_ROW, sqlite3_column_type(stmt, 0) == SQLITE_INTEGER else { throw LocalNoticeError.corrupt }
            let count = sqlite3_column_int64(stmt, 0); guard count == 0 || count == 1 else { throw LocalNoticeError.corrupt }
            return count == 1
        }
    }
    private func update(_ ticket: Ticket, sql: String) throws {
        try statement(sql) { stmt in
            try bind(ticket.requestID, to: stmt, at: 1); try done(stmt)
            guard sqlite3_changes(database) == 1 else { throw LocalNoticeError.changed }
        }
    }
    private func validate() throws {
        guard try integer("SELECT count(*) FROM ticket WHERE seq>(SELECT highwater FROM owner WHERE id=ticket.owner)") == 0,
              try integer("SELECT count(*) FROM owner WHERE pending_forget=1 AND retired=0") == 0,
              try integer("SELECT count(*) FROM retired_range WHERE hi>(SELECT highwater FROM owner WHERE id=retired_range.owner)") == 0,
              try integer("SELECT count(*) FROM retired_range a JOIN retired_range b ON a.owner=b.owner AND a.lo<b.lo AND a.hi>=b.lo") == 0,
              try integer("SELECT count(*) FROM ticket t JOIN retired_range r ON t.owner=r.owner AND t.seq BETWEEN r.lo AND r.hi") == 0,
              try integer("SELECT count(*) FROM ticket WHERE effect IN (2,5)") <= Int64(Self.maximumUncertain) else { throw LocalNoticeError.corrupt }
    }
    private func budget() throws {
        let owners = try integer("SELECT count(*) FROM owner"), tickets = try integer("SELECT count(*) FROM ticket")
        let ranges = try integer("SELECT count(*) FROM retired_range")
        guard owners + tickets + ranges <= Int64(Self.maximumRows), owners * 64 + tickets * 192 + ranges * 64 <= Int64(Self.maximumLogicalBytes) else { throw LocalNoticeError.capacity }
        var total: Int64 = 0
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let path = file.path + suffix
            var info = stat()
            if lstat(path, &info) == 0 {
                guard (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(), info.st_size >= 0 else { throw LocalNoticeError.unavailable }
                total += info.st_size
            } else if errno != ENOENT { throw LocalNoticeError.unavailable }
        }
        guard total <= Self.maximumPhysicalBytes else { throw LocalNoticeError.capacity }
    }
    private func withLock<T>(_ operation: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }; return try operation()
    }
    private func transaction<T>(checkBudget: Bool = true, _ operation: () throws -> T) throws -> T {
        try verifyDirectory()
        try execute("BEGIN IMMEDIATE")
        do {
            let result = try operation()
            if checkBudget { try budget() }
            try verifyDirectory()
            try execute("COMMIT"); return result
        } catch {
            try? execute("ROLLBACK"); throw error
        }
    }
    private func execute(_ sql: String) throws {
        let result = sqlite3_exec(database, sql, nil, nil, nil)
        guard result == SQLITE_OK else { throw Self.sqliteError(result) }
    }
    private func integer(_ sql: String) throws -> Int64 {
        try statement(sql) { stmt in
            guard sqlite3_step(stmt) == SQLITE_ROW, sqlite3_column_type(stmt, 0) == SQLITE_INTEGER else { throw LocalNoticeError.corrupt }
            let result = sqlite3_column_int64(stmt, 0); guard sqlite3_step(stmt) == SQLITE_DONE else { throw LocalNoticeError.corrupt }; return result
        }
    }
    private func statement<T>(_ sql: String, _ body: (OpaquePointer) throws -> T) throws -> T {
        var stmt: OpaquePointer?
        let result = sqlite3_prepare_v2(database, sql, -1, &stmt, nil)
        guard result == SQLITE_OK else { throw Self.sqliteError(result) }
        guard let stmt else { throw LocalNoticeError.unavailable }
        defer { sqlite3_finalize(stmt) }; return try body(stmt)
    }
    private func bind(_ value: Data, to stmt: OpaquePointer, at index: Int32) throws {
        let status = value.withUnsafeBytes { sqlite3_bind_blob(stmt, index, $0.baseAddress, Int32(value.count), Self.transient) }
        guard status == SQLITE_OK else { throw LocalNoticeError.unavailable }
    }
    private func bind(_ value: String, to stmt: OpaquePointer, at index: Int32) throws {
        guard sqlite3_bind_text(stmt, index, value, -1, Self.transient) == SQLITE_OK else { throw LocalNoticeError.unavailable }
    }
    private func bind(_ value: Int64, to stmt: OpaquePointer, at index: Int32) throws {
        guard sqlite3_bind_int64(stmt, index, value) == SQLITE_OK else { throw LocalNoticeError.unavailable }
    }
    private func blob(_ stmt: OpaquePointer, at index: Int32) throws -> Data {
        guard sqlite3_column_type(stmt, index) == SQLITE_BLOB, sqlite3_column_bytes(stmt, index) == 32,
              let value = sqlite3_column_blob(stmt, index) else { throw LocalNoticeError.corrupt }
        return Data(bytes: value, count: 32)
    }
    private func done(_ stmt: OpaquePointer) throws {
        let result = sqlite3_step(stmt)
        guard result == SQLITE_DONE else { throw Self.sqliteError(result) }
    }
    private static func sqliteError(_ status: Int32) -> LocalNoticeError {
        switch status & 0xff {
        case SQLITE_CORRUPT, SQLITE_NOTADB: .corrupt
        case SQLITE_FULL: .capacity
        default: .unavailable
        }
    }
}
