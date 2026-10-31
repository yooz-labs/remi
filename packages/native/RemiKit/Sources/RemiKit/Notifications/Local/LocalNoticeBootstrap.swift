import Darwin
import Foundation
import RemiPush

/// Cold-start decisions for the local notification journal. Never rotates a key on a read error.
enum LocalNoticeBootstrap {
    enum Sentinel: Equatable { case absent, present, invalid }
    enum Inventory { case noLocalMarkers, localMarkersPresent, unavailable }
    enum Failure: Error, Equatable { case locked, recoveryRequired, unavailable, capacity, pendingForget }
    /// Production callers use only this OS-provided app-container location, never a wire or project path.
    static func appPrivateDirectory() throws -> URL {
        #if os(iOS)
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                               appropriateFor: nil, create: true)
        return root.appendingPathComponent("LocalQuestionNotices", isDirectory: true)
        #else
        throw Failure.unavailable
        #endif
    }
    struct Ready {
        let keys: LocalNoticeKeys
        let ledger: LocalNoticeLedger
        /// The caller must persist the non-secret sentinel before scheduling any OS add.
        let needsSentinel: Bool
    }

    /// Inventory is the app-owned local OS boundary after excluding remote/remiPush requests.
    /// An unavailable or oversized scan is not evidence of an empty notification center.
    static func open(directory: URL, sentinel: Sentinel, inventory: Inventory, protectedDataAvailable: Bool,
                     keyStore: LocalNoticeKeyStore,
                     operations: NativeKeychainOperations = .system) throws -> Ready {
        guard directory.isFileURL else { throw Failure.unavailable }
        guard protectedDataAvailable else { throw Failure.locked }
        if case .unavailable = inventory { throw Failure.unavailable }
        return try openWithInventory(directory: directory, sentinel: sentinel, inventory: inventory,
                                     keyStore: keyStore, operations: operations)
    }

    private static func openWithInventory(directory: URL, sentinel: Sentinel, inventory: Inventory,
                                          keyStore: LocalNoticeKeyStore,
                                          operations: NativeKeychainOperations) throws -> Ready {
        if case .invalid = sentinel { throw Failure.recoveryRequired }
        let path = directory.appendingPathComponent("local-notifications.sqlite").path
        var info = stat()
        let journalExists: Bool
        if lstat(path, &info) == 0 {
            guard (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid() else { throw Failure.recoveryRequired }
            journalExists = true
        } else if errno == ENOENT { journalExists = false }
        else { throw Failure.unavailable }
        let hasMarkers: Bool
        switch inventory {
        case .noLocalMarkers: hasMarkers = false
        case .localMarkersPresent: hasMarkers = true
        case .unavailable: throw Failure.unavailable
        }
        let hasSentinel: Bool
        switch sentinel {
        case .absent: hasSentinel = false
        case .present: hasSentinel = true
        case .invalid: throw Failure.recoveryRequired
        }
        let root: Data
        do { root = try keyStore.load(operations: operations) }
        catch LocalNoticeKeyError.locked { throw Failure.locked }
        catch LocalNoticeKeyError.missing {
            guard !journalExists, !hasSentinel, !hasMarkers else { throw Failure.recoveryRequired }
            do { root = try keyStore.createAfterFreshInstallOrConfirmedReset(operations: operations) }
            catch LocalNoticeKeyError.locked { throw Failure.locked }
            catch { throw Failure.unavailable }
            return try makeReady(directory: directory, root: root, needsSentinel: true, createIfMissing: true)
        } catch LocalNoticeKeyError.corrupt { throw Failure.recoveryRequired }
        catch { throw Failure.unavailable }
        // A key left by an interrupted first launch can create the first journal only if
        // no sentinel or local marker indicates prior state. No older notification is adopted.
        if !journalExists && (hasSentinel || hasMarkers) { throw Failure.recoveryRequired }
        return try makeReady(directory: directory, root: root, needsSentinel: !hasSentinel, createIfMissing: !journalExists)
    }

    private static func makeReady(directory: URL, root: Data, needsSentinel: Bool, createIfMissing: Bool) throws -> Ready {
        do { return Ready(keys: try LocalNoticeKeys(root: root), ledger: try LocalNoticeLedger(directory: directory, createIfMissing: createIfMissing), needsSentinel: needsSentinel) }
        catch LocalNoticeError.corrupt { throw Failure.recoveryRequired }
        catch { throw Failure.unavailable }
    }
}
