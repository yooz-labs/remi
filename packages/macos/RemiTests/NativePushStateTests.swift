import CryptoKit
import Foundation
import SQLite3
import XCTest

final class NativePushStateTests: XCTestCase {
    private var directory: URL!
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi1200-state-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    }
    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directory)
    }

    func testAuthorityPersistsAndInvalidatesAcrossIndependentSQLiteConnections() throws {
        let file = directory.appendingPathComponent("push.sqlite")
        let first = try NativePushState(file: file)
        let publicKey = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let revision = UUID().uuidString
        XCTAssertNil(try first.currentAuthority())
        XCTAssertNoThrow(try install(first, publicKey: publicKey, revision: revision),
                         "Actual SQLite authority installation must commit durable public context")
        let second = try NativePushState(file: file)
        XCTAssertEqual(try second.currentAuthority(), .init(publicKey: publicKey, revision: revision, requiresAppUnlock: false),
                       "Another actual SQLite connection must observe the durable authority")
        XCTAssertNoThrow(try invalidate(second))
        XCTAssertNil(try first.currentAuthority(), "Invalidation must be visible to the original connection")
    }

    func testMalformedPublicAuthorityCannotReplaceExistingContext() throws {
        let state = try NativePushState(file: directory.appendingPathComponent("push.sqlite"))
        let key = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let revision = UUID().uuidString
        XCTAssertNoThrow(try install(state, publicKey: key, revision: revision))
        let lease = try state.acquireIdentityMutation()
        defer { lease.release() }
        XCTAssertThrowsError(try lease.installIdentityAuthority(publicKey: Data(repeating: 0, count: 32), revision: revision, requiresAppUnlock: false, generation: 0))
        XCTAssertThrowsError(try lease.installIdentityAuthority(publicKey: key, revision: "invalid", requiresAppUnlock: false, generation: 0))
        XCTAssertEqual(try state.currentAuthority(), .init(publicKey: key, revision: revision, requiresAppUnlock: false),
                       "Refused authority must preserve the prior durable record")
    }

    func testUnavailableFilesystemNeverCreatesVolatileAuthority() throws {
        let file = directory.appendingPathComponent("missing/parent/push.sqlite")
        XCTAssertThrowsError(try NativePushState(file: file))
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    private func install(_ state: NativePushState, publicKey: Data, revision: String) throws {
        let lease = try state.acquireIdentityMutation()
        defer { lease.release() }
        let generation = try lease.invalidateIdentityAuthority()
        try lease.installIdentityAuthority(publicKey: publicKey, revision: revision, requiresAppUnlock: false, generation: generation)
    }
    private func invalidate(_ state: NativePushState) throws {
        let lease = try state.acquireIdentityMutation()
        defer { lease.release() }
        _ = try lease.invalidateIdentityAuthority()
    }

    func testMutationLockRefusesBusyWriterAndReleasedLeaseCannotInstall() throws {
        let file = directory.appendingPathComponent("push.sqlite")
        let first = try NativePushState(file: file)
        let second = try NativePushState(file: file)
        var lease: NativeIdentityMutationLease?
        XCTAssertNoThrow(lease = try first.acquireIdentityMutation())
        XCTAssertNotNil(lease, "The actual file lock must be acquired")
        guard let lease else { return }
        XCTAssertThrowsError(try second.acquireIdentityMutation(), "Another writer must fail visibly while the owned lock is held")
        lease.release()
        XCTAssertNoThrow(try second.acquireIdentityMutation().release())
        XCTAssertThrowsError(try lease.invalidateIdentityAuthority(), "A released lease cannot mutate authority")
    }

    func testStaleGenerationCannotReinstallAuthority() throws {
        let state = try NativePushState(file: directory.appendingPathComponent("push.sqlite"))
        let lease = try state.acquireIdentityMutation()
        defer { lease.release() }
        let old = try lease.invalidateIdentityAuthority()
        let fresh = try lease.invalidateIdentityAuthority()
        let key = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let revision = UUID().uuidString
        XCTAssertGreaterThan(fresh, old)
        XCTAssertThrowsError(try lease.installIdentityAuthority(publicKey: key, revision: revision, requiresAppUnlock: false, generation: old))
        XCTAssertNil(try state.currentAuthority())
        XCTAssertNoThrow(try lease.installIdentityAuthority(publicKey: key, revision: revision, requiresAppUnlock: false, generation: fresh))
        XCTAssertEqual(try state.currentAuthority(), .init(publicKey: key, revision: revision, requiresAppUnlock: false))
    }


    func testCurrentGenerationRejectsMalformedAuthorityWithoutPublishingIt() throws {
        let state = try NativePushState(file: directory.appendingPathComponent("push.sqlite"))
        let lease = try state.acquireIdentityMutation()
        defer { lease.release() }
        let generation = try lease.invalidateIdentityAuthority()
        let key = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let revision = UUID().uuidString
        XCTAssertThrowsError(try lease.installIdentityAuthority(publicKey: Data(repeating: 0, count: 32), revision: revision, requiresAppUnlock: false, generation: generation),
                             "An actual current lease cannot authorize a small-order device key")
        XCTAssertThrowsError(try lease.installIdentityAuthority(publicKey: key, revision: "invalid", requiresAppUnlock: false, generation: generation))
        XCTAssertNil(try state.currentAuthority())
        XCTAssertNoThrow(try lease.installIdentityAuthority(publicKey: key, revision: revision, requiresAppUnlock: false, generation: generation))
        XCTAssertEqual(try state.currentAuthority(), .init(publicKey: key, revision: revision, requiresAppUnlock: false))
    }


    func testLegacyAuthorityWithoutPolicyClosesDuringSchemaUpgrade() throws {
        let file = directory.appendingPathComponent("legacy.sqlite")
        var database: OpaquePointer?
        XCTAssertEqual(sqlite3_open(file.path, &database), SQLITE_OK)
        defer { sqlite3_close(database) }
        let key = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let hex = key.map { String(format: "%02x", $0) }.joined()
        let revision = UUID().uuidString
        // Exact committed pre-policy schema, not a simulated ledger evaluator.
        let sql = """
        CREATE TABLE authority_generation (slot INTEGER PRIMARY KEY CHECK(slot=1), generation INTEGER NOT NULL CHECK(generation>=0));
        INSERT INTO authority_generation VALUES(1,2);
        CREATE TABLE identity_authority (slot INTEGER PRIMARY KEY CHECK(slot=1), public_key BLOB NOT NULL CHECK(length(public_key)=32), revision TEXT NOT NULL CHECK(length(revision)=36));
        INSERT INTO identity_authority VALUES(1,X'\(hex)','\(revision)');
        PRAGMA application_id=1380798514;
        PRAGMA user_version=1;
        """
        XCTAssertEqual(sqlite3_exec(database, sql, nil, nil, nil), SQLITE_OK)
        let upgraded = try NativePushState(file: file)
        XCTAssertNil(try upgraded.currentAuthority(), "A legacy record lacking protection metadata cannot grant actions")
        let lease = try upgraded.acquireIdentityMutation()
        defer { lease.release() }
        XCTAssertGreaterThan(try lease.invalidateIdentityAuthority(), 2)
    }

}
