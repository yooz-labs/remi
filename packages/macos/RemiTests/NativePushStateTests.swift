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
        XCTAssertNoThrow(try first.installIdentityAuthority(publicKey: publicKey, revision: revision),
                         "Actual SQLite authority installation must commit durable public context")
        let second = try NativePushState(file: file)
        XCTAssertEqual(try second.currentAuthority(), .init(publicKey: publicKey, revision: revision),
                       "Another actual SQLite connection must observe the durable authority")
        XCTAssertNoThrow(try second.invalidateIdentityAuthority())
        XCTAssertNil(try first.currentAuthority(), "Invalidation must be visible to the original connection")
    }

    func testMalformedPublicAuthorityCannotReplaceExistingContext() throws {
        let state = try NativePushState(file: directory.appendingPathComponent("push.sqlite"))
        let key = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let revision = UUID().uuidString
        XCTAssertNoThrow(try state.installIdentityAuthority(publicKey: key, revision: revision))
        XCTAssertThrowsError(try state.installIdentityAuthority(publicKey: Data(repeating: 0, count: 32), revision: revision))
        XCTAssertThrowsError(try state.installIdentityAuthority(publicKey: key, revision: "invalid"))
        XCTAssertEqual(try state.currentAuthority(), .init(publicKey: key, revision: revision),
                       "Refused authority must preserve the prior durable record")
    }

    func testUnavailableFilesystemNeverCreatesVolatileAuthority() throws {
        let file = directory.appendingPathComponent("missing/parent/push.sqlite")
        XCTAssertThrowsError(try NativePushState(file: file))
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }
}
