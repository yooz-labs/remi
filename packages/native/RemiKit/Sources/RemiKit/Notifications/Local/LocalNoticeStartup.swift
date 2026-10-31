import Darwin
import Foundation
import RemiPush

/// Fail-closed composition for the local-only notification owner. It does not start a Store,
/// navigate, change secure-push authority, or request notification permission.
@MainActor enum LocalNoticeStartup {
    struct Ready {
        let ledger: LocalNoticeLedger
        let lifecycle: LocalNoticeLifecycle
        let recovery: LocalNoticeRecovery
        let reconciler: LocalNoticeReconciler
    }

    /// Recovery can inspect/select historical records without constructing a scheduler or
    /// adopting a prior owner. A pending count is unassigned, not a profile identity.
    final class RecoveryAccess {
        private let ledger: LocalNoticeLedger
        let recovery: LocalNoticeRecovery
        let pendingForgetCount: Int

        fileprivate init(ledger: LocalNoticeLedger, recovery: LocalNoticeRecovery, pendingForgetCount: Int) {
            self.ledger = ledger; self.recovery = recovery; self.pendingForgetCount = pendingForgetCount
        }
        func close() { ledger.close() }
        deinit { ledger.close() }
    }

    /// Opens only existing, protected state. Missing/corrupt state is not recreated, and no OS
    /// notification is read or removed until a separately confirmed recovery operation is called.
    static func openRecovery(directory: URL, keyStore: LocalNoticeKeyStore,
                             operations: NativeKeychainOperations = .system,
                             protectedDataAvailable: Bool,
                             remove: @escaping ([String]) -> Void) throws -> RecoveryAccess {
        guard protectedDataAvailable else { throw LocalNoticeBootstrap.Failure.locked }
        guard directory.isFileURL else { throw LocalNoticeBootstrap.Failure.unavailable }
        let root: Data
        do { root = try keyStore.load(operations: operations) }
        catch LocalNoticeKeyError.locked { throw LocalNoticeBootstrap.Failure.locked }
        catch LocalNoticeKeyError.missing, LocalNoticeKeyError.corrupt { throw LocalNoticeBootstrap.Failure.recoveryRequired }
        catch { throw LocalNoticeBootstrap.Failure.unavailable }
        var info = stat()
        let path = directory.appendingPathComponent("local-notifications.sqlite").path
        guard lstat(path, &info) == 0 else {
            throw errno == ENOENT ? LocalNoticeBootstrap.Failure.recoveryRequired : .unavailable
        }
        guard (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid() else { throw LocalNoticeBootstrap.Failure.recoveryRequired }
        var opened: LocalNoticeLedger?
        do {
            let keys = try LocalNoticeKeys(root: root), ledger = try LocalNoticeLedger(directory: directory, createIfMissing: false)
            opened = ledger
            let pendingCount = try ledger.pendingForgetOwners().count
            return RecoveryAccess(ledger: ledger, recovery: LocalNoticeRecovery(ledger: ledger, keys: keys, remove: remove),
                                  pendingForgetCount: pendingCount)
        } catch {
            opened?.close()
            if error as? LocalNoticeError == .corrupt { throw LocalNoticeBootstrap.Failure.recoveryRequired }
            if error as? LocalNoticeError == .capacity { throw LocalNoticeBootstrap.Failure.capacity }
            throw LocalNoticeBootstrap.Failure.unavailable
        }
    }

    static func open(directory: URL, sentinel: LocalNoticeSentinel, keyStore: LocalNoticeKeyStore,
                     operations: NativeKeychainOperations = .system, inventory: LocalNoticeInventory,
                     protectedDataAvailable: @MainActor () -> Bool,
                     notificationBoundary: LocalNoticeBoundary = .system) async throws -> Ready {
        guard protectedDataAvailable() else { throw LocalNoticeBootstrap.Failure.locked }
        guard sentinel.read() != .invalid else { throw LocalNoticeBootstrap.Failure.recoveryRequired }
        // A transient locked/unavailable Keychain is not missing. Check before requesting an
        // inventory; repeat in bootstrap after the suspension before any key is created.
        do { _ = try keyStore.load(operations: operations) }
        catch LocalNoticeKeyError.missing { }
        catch LocalNoticeKeyError.locked { throw LocalNoticeBootstrap.Failure.locked }
        catch LocalNoticeKeyError.corrupt { throw LocalNoticeBootstrap.Failure.recoveryRequired }
        catch { throw LocalNoticeBootstrap.Failure.unavailable }
        let snapshot: LocalNoticeInventory.Snapshot
        do { snapshot = try await inventory.read() }
        catch is CancellationError { throw CancellationError() }
        catch LocalNoticeError.capacity { throw LocalNoticeBootstrap.Failure.capacity }
        catch { throw LocalNoticeBootstrap.Failure.unavailable }
        try Task.checkCancellation()
        guard protectedDataAvailable() else { throw LocalNoticeBootstrap.Failure.locked }
        let priorLocalMarker = snapshot.entries.contains {
            !$0.protected && $0.identifier.hasPrefix("remi.local.v1.")
        }
        let opened = try LocalNoticeBootstrap.open(directory: directory, sentinel: sentinel.read(),
            inventory: priorLocalMarker ? .localMarkersPresent : .noLocalMarkers,
            protectedDataAvailable: true, keyStore: keyStore, operations: operations)
        do {
            try Task.checkCancellation()
            guard protectedDataAvailable() else { throw LocalNoticeBootstrap.Failure.locked }
            // A prior-process pending owner cannot be matched to any current profile. Until
            // an explicit recovery resolves that ambiguity, do not mint new local authority.
            guard try opened.ledger.pendingForgetOwners().isEmpty else { throw LocalNoticeBootstrap.Failure.pendingForget }
            try sentinel.establish()
            let reconciler = LocalNoticeReconciler(ledger: opened.ledger, keys: opened.keys, remove: notificationBoundary.remove)
            try reconciler.reconcile(snapshot.entries)
            let lifecycle = LocalNoticeLifecycle(ledger: opened.ledger, keys: opened.keys, boundary: notificationBoundary)
            let recovery = LocalNoticeRecovery(ledger: opened.ledger, keys: opened.keys, remove: notificationBoundary.remove)
            return Ready(ledger: opened.ledger, lifecycle: lifecycle, recovery: recovery, reconciler: reconciler)
        } catch {
            opened.ledger.close()
            if error is CancellationError { throw error }
            if let error = error as? LocalNoticeBootstrap.Failure { throw error }
            if error as? LocalNoticeError == .corrupt { throw LocalNoticeBootstrap.Failure.recoveryRequired }
            if error as? LocalNoticeError == .capacity { throw LocalNoticeBootstrap.Failure.capacity }
            throw LocalNoticeBootstrap.Failure.unavailable
        }
    }
}
