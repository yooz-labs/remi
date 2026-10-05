import Foundation
import SQLite3

/// Mandatory pre-mutation authority barrier for every durable identity writer.
/// A failure blocks Keychain mutation. A later Keychain failure leaves this
/// authority invalidated; SQLite and Keychain are not a distributed transaction.
protocol NativeIdentityAuthorityBarrier {
    func acquireIdentityMutation() throws -> NativeIdentityMutationLease
}

enum NativePushStateError: Error { case unavailable, corrupt, invalid, capacity, changed, busy }

/// #1200 A scaffolding: opens an actual private/shared SQLite file. Authority
/// operations remain fail-closed until the separately committed behavior pins
/// drive transactional implementation. No identity writer is wired yet.
final class NativePushState: NativeIdentityAuthorityBarrier {
    struct Authority: Equatable { let publicKey: Data; let revision: String }
    private var database: OpaquePointer?

    init(file: URL) throws {
        guard file.isFileURL else { throw NativePushStateError.unavailable }
        let status = sqlite3_open_v2(file.path, &database,
                                    SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        guard status == SQLITE_OK else {
            if let database { sqlite3_close(database) }
            database = nil
            throw NativePushStateError.unavailable
        }
    }
    deinit { if let database { sqlite3_close(database) } }

    func currentAuthority() throws -> Authority? { nil }
    func acquireIdentityMutation() throws -> NativeIdentityMutationLease { throw NativePushStateError.unavailable }
}

final class NativeIdentityMutationLease {
    func invalidateIdentityAuthority() throws -> Int64 { throw NativePushStateError.unavailable }
    func installIdentityAuthority(publicKey: Data, revision: String, generation: Int64) throws {
        throw NativePushStateError.unavailable
    }
    func release() {}
}
