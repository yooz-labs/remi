import CryptoKit
import Foundation
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
        XCTAssertEqual(try second.currentAuthority(), .init(publicKey: publicKey, revision: revision),
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
        XCTAssertThrowsError(try lease.installIdentityAuthority(publicKey: Data(repeating: 0, count: 32), revision: revision, generation: 0))
        XCTAssertThrowsError(try lease.installIdentityAuthority(publicKey: key, revision: "invalid", generation: 0))
        XCTAssertEqual(try state.currentAuthority(), .init(publicKey: key, revision: revision),
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
        try lease.installIdentityAuthority(publicKey: publicKey, revision: revision, generation: generation)
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
        XCTAssertThrowsError(try lease.installIdentityAuthority(publicKey: key, revision: revision, generation: old))
        XCTAssertNil(try state.currentAuthority())
        XCTAssertNoThrow(try lease.installIdentityAuthority(publicKey: key, revision: revision, generation: fresh))
        XCTAssertEqual(try state.currentAuthority(), .init(publicKey: key, revision: revision))
    }


    func testCurrentGenerationRejectsMalformedAuthorityWithoutPublishingIt() throws {
        let state = try NativePushState(file: directory.appendingPathComponent("push.sqlite"))
        let lease = try state.acquireIdentityMutation()
        defer { lease.release() }
        let generation = try lease.invalidateIdentityAuthority()
        let key = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let revision = UUID().uuidString
        XCTAssertThrowsError(try lease.installIdentityAuthority(publicKey: Data(repeating: 0, count: 32), revision: revision, generation: generation),
                             "An actual current lease cannot authorize a small-order device key")
        XCTAssertThrowsError(try lease.installIdentityAuthority(publicKey: key, revision: "invalid", generation: generation))
        XCTAssertNil(try state.currentAuthority())
        XCTAssertNoThrow(try lease.installIdentityAuthority(publicKey: key, revision: revision, generation: generation))
        XCTAssertEqual(try state.currentAuthority(), .init(publicKey: key, revision: revision))
    }

}
