import CryptoKit
import Darwin
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

    private func ownedProcess(_ executable: URL, _ arguments: [String], timeout: TimeInterval = 20) throws -> String {
        let process = Process()
        let output = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = output
        try process.run()
        return try collectOwnedProcess(process, output: output, timeout: timeout)
    }
    private func collectOwnedProcess(_ process: Process, output: Pipe, timeout: TimeInterval = 20) throws -> String {
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        while process.isRunning && ProcessInfo.processInfo.systemUptime < deadline { Thread.sleep(forTimeInterval: 0.01) }
        if process.isRunning {
            process.terminate()
            let cleanupDeadline = ProcessInfo.processInfo.systemUptime + 2
            while process.isRunning && ProcessInfo.processInfo.systemUptime < cleanupDeadline { Thread.sleep(forTimeInterval: 0.01) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
            throw NativePushStateError.unavailable
        }
        process.waitUntilExit()
        let bytes = output.fileHandleForReading.readDataToEndOfFile()
        guard bytes.count <= 65536, process.terminationStatus == 0,
              let text = String(data: bytes, encoding: .utf8) else { throw NativePushStateError.unavailable }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func testActualDifferentProcessObservesWriterLockAndDurableInvalidation() throws {
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let macos = source.deletingLastPathComponent()
        let helper = directory.appendingPathComponent("owned-state-helper")
        _ = try ownedProcess(URL(fileURLWithPath: "/usr/bin/xcrun"), ["swiftc",
            macos.appendingPathComponent("Remi/NativePush/NativePushState.swift").path,
            macos.appendingPathComponent("Remi/NativePush/NativeEd25519PublicKey.swift").path,
            source.appendingPathComponent("fixtures/NativePushStateProcess/main.swift").path,
            "-o", helper.path])
        let file = directory.appendingPathComponent("process.sqlite")
        let state = try NativePushState(file: file)
        let revision = UUID().uuidString
        try install(state, publicKey: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation, revision: revision)
        let held = try state.acquireIdentityMutation()
        XCTAssertEqual(try ownedProcess(helper, [file.path, "probe", "unused"]), "busy",
                       "A different actual production-store process must refuse the owned writer lock")
        held.release()
        XCTAssertEqual(try ownedProcess(helper, [file.path, "probe", "unused"]), "acquired")
        XCTAssertEqual(try ownedProcess(helper, [file.path, "observe", revision]), "current")
        XCTAssertEqual(try ownedProcess(helper, [file.path, "invalidate", "unused"]), "closed")
        XCTAssertNil(try state.currentAuthority(), "Actual child-process invalidation must close the original SQLite connection")
    }

    private func machine(_ state: NativePushState) throws -> NativePushState.MachineTrust {
        let key = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation
        let authority = try XCTUnwrap(state.currentAuthority())
        return .init(rid: Data(SHA256.hash(data: key).prefix(16)), machinePublicKey: key,
                     endpoint: "https://relay.example.invalid", authority: authority)
    }

    func testCompletedMachineTrustPersistsOnlyForExactCurrentAuthorityGeneration() throws {
        let file = directory.appendingPathComponent("trust.sqlite")
        let state = try NativePushState(file: file)
        try install(state, publicKey: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation, revision: UUID().uuidString)
        let trust = try machine(state)
        let generation = try state.authorityGeneration()
        XCTAssertNoThrow(try state.installMachineTrust(trust, generation: generation),
                         "Completed machine trust must durably commit exact native authority and generation")
        guard let saved = try? state.machineTrust(rid: trust.rid) else { return }
        XCTAssertEqual(saved, trust)
        let reopened = try NativePushState(file: file)
        XCTAssertEqual(try reopened.machineTrust(rid: trust.rid), trust)
        let wrongRid = NativePushState.MachineTrust(rid: Data(repeating: 0, count: 16), machinePublicKey: trust.machinePublicKey,
            endpoint: trust.endpoint, authority: trust.authority)
        XCTAssertThrowsError(try state.installMachineTrust(wrongRid, generation: generation), "Stored rid must derive from actual Mpk")
        let insecureEndpoint = NativePushState.MachineTrust(rid: trust.rid, machinePublicKey: trust.machinePublicKey,
            endpoint: "http://relay.example.invalid", authority: trust.authority)
        XCTAssertThrowsError(try state.installMachineTrust(insecureEndpoint, generation: generation), "Completed trust pins a canonical HTTPS origin")
        XCTAssertThrowsError(try state.installMachineTrust(trust, generation: generation - 1), "Stale generation cannot install trust")
        XCTAssertEqual(try reopened.machineTrust(rid: trust.rid), trust)
    }

    func testCompletedMachineTrustRequiresCanonicalInRangeEndpointPort() throws {
        let file = directory.appendingPathComponent("canonical-port.sqlite")
        let state = try NativePushState(file: file)
        try install(state, publicKey: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation, revision: UUID().uuidString)
        let original = try machine(state)
        let generation = try state.authorityGeneration()
        for endpoint in ["https://relay.example.invalid", "https://relay.example.invalid:0",
                         "https://relay.example.invalid:1", "https://relay.example.invalid:444",
                         "https://relay.example.invalid:65535"] {
            let trust = NativePushState.MachineTrust(rid: original.rid, machinePublicKey: original.machinePublicKey,
                endpoint: endpoint, authority: original.authority)
            XCTAssertNoThrow(try state.installMachineTrust(trust, generation: generation),
                             "Canonical shared-compatible HTTPS origin must persist: \(endpoint)")
            XCTAssertEqual(try NativePushState(file: file).machineTrust(rid: trust.rid), trust)
        }
        let saved = try XCTUnwrap(state.machineTrust(rid: original.rid))
        for endpoint in ["https://relay.example.invalid:65536", "https://relay.example.invalid:999999",
                         "https://relay.example.invalid:00444", "https://relay.example.invalid:0443",
                         "https://relay.example.invalid:443", "https://relay.example.invalid:"] {
            let refused = NativePushState.MachineTrust(rid: original.rid, machinePublicKey: original.machinePublicKey,
                endpoint: endpoint, authority: original.authority)
            XCTAssertThrowsError(try state.installMachineTrust(refused, generation: generation),
                                 "Noncanonical or out-of-range endpoint port must be refused: \(endpoint)")
            XCTAssertEqual(try NativePushState(file: file).machineTrust(rid: saved.rid), saved,
                           "Refused endpoint must preserve the durable completed pair")
        }
    }

    func testIdentityMutationClosesCompletedMachineTrustAndWriterCannotRestoreIt() throws {
        let state = try NativePushState(file: directory.appendingPathComponent("trust-close.sqlite"))
        try install(state, publicKey: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation, revision: UUID().uuidString)
        let trust = try machine(state)
        XCTAssertNoThrow(try state.installMachineTrust(trust, generation: state.authorityGeneration()),
                         "Actual SQLite must accept a completed pair before testing invalidation")
        guard (try? state.machineTrust(rid: trust.rid)) == trust else { return }
        let lease = try state.acquireIdentityMutation()
        defer { lease.release() }
        let generation = try lease.invalidateIdentityAuthority()
        XCTAssertNil(try state.machineTrust(rid: trust.rid), "Identity invalidation must close completed machine trust DURABLY")
        try lease.installIdentityAuthority(publicKey: trust.authority.publicKey, revision: UUID().uuidString,
            requiresAppUnlock: false, generation: generation)
        XCTAssertNil(try state.machineTrust(rid: trust.rid), "Verified identity writer cannot restore prior pairing implicitly")
        XCTAssertThrowsError(try state.installMachineTrust(trust, generation: generation))
    }

    func testSavedMachineCapacityRefusesWithoutEvictingExistingTrust() throws {
        let state = try NativePushState(file: directory.appendingPathComponent("trust-cap.sqlite"), maximumMachines: 1)
        try install(state, publicKey: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation, revision: UUID().uuidString)
        let first = try machine(state)
        let second = try machine(state)
        XCTAssertNoThrow(try state.installMachineTrust(first, generation: state.authorityGeneration()),
                         "First actual completed pair must fit the configured native capacity")
        guard (try? state.machineTrust(rid: first.rid)) == first else { return }
        XCTAssertThrowsError(try state.installMachineTrust(second, generation: state.authorityGeneration()),
                             "Saved-machine capacity cannot evict an existing completed pair")
        XCTAssertEqual(try state.machineTrust(rid: first.rid), first)
        XCTAssertNil(try state.machineTrust(rid: second.rid))
        try state.forgetMachine(rid: first.rid)
        XCTAssertNil(try state.machineTrust(rid: first.rid))
        XCTAssertNoThrow(try state.installMachineTrust(second, generation: state.authorityGeneration()))
    }

    // These are public metadata fixtures at the durable-state boundary. The
    // original-byte signature/sealed decoder receives separate conformance pins.
    private func content(_ trust: NativePushState.MachineTrust, nonce: UInt8 = 1, revision: Int64 = 1,
                         collapse: String = "AQEBAQEBAQEBAQEBAQEBAQ", kind: Int = 1, issued: Int64 = 1000,
                         expiry: Int64 = 1100) -> NativePushState.ContentRecord {
        let bytes = Data(repeating: nonce, count: 32)
        let digest = Data(SHA256.hash(data: bytes + Data("\(revision)|\(kind)|\(collapse)|\(issued)|\(expiry)".utf8)))
        return .init(rid: trust.rid, collapseId: collapse, revision: revision, kind: kind, nonce: bytes,
                     digest: digest, issuedAt: issued, expiresAt: expiry)
    }
    private func paired(_ state: NativePushState) throws -> NativePushState.MachineTrust {
        try install(state, publicKey: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation, revision: UUID().uuidString)
        let trust = try machine(state)
        try state.installMachineTrust(trust, generation: state.authorityGeneration())
        return trust
    }

    func testActualReplayPersistenceRejectsChangedNonceAndObsoleteActionContent() throws {
        let file = directory.appendingPathComponent("replay.sqlite")
        let state = try NativePushState(file: file)
        let trust = try paired(state)
        let first = content(trust)
        var outcome: NativePushState.ContentOutcome?
        XCTAssertNoThrow(outcome = try state.recordVerifiedContent(first, trust: trust, now: 1000),
                         "Actual SQLite must persist verified content BEFORE a notification is published")
        guard outcome != nil else { return }
        XCTAssertEqual(outcome, .publish)
        let reopened = try NativePushState(file: file)
        XCTAssertEqual(try reopened.recordVerifiedContent(first, trust: trust, now: 1000), .duplicate,
                       "An identical accepted capsule cannot redisplay after a process/store restart")
        XCTAssertNoThrow(try reopened.reverifyLatestContent(first, trust: trust, now: 1000))
        let conflict = content(trust, nonce: 1, revision: 2)
        XCTAssertThrowsError(try reopened.recordVerifiedContent(conflict, trust: trust, now: 1000), "Changed-content nonce reuse must refuse")
        let newer = content(trust, nonce: 2, revision: 2)
        XCTAssertEqual(try state.recordVerifiedContent(newer, trust: trust, now: 1000), .publish)
        XCTAssertThrowsError(try reopened.reverifyLatestContent(first, trust: trust, now: 1000), "An obsolete option capsule cannot grant action authority")
        XCTAssertNoThrow(try reopened.reverifyLatestContent(newer, trust: trust, now: 1000))
        XCTAssertEqual(try reopened.recordVerifiedContent(first, trust: trust, now: 1000), .duplicate)
    }

    func testAbsorbingDismissSurvivesForgetRepairAndMaximumRetentionHorizon() throws {
        let state = try NativePushState(file: directory.appendingPathComponent("dismiss.sqlite"))
        let trust = try paired(state)
        let first = content(trust, issued: 1060, expiry: 4660)
        var outcome: NativePushState.ContentOutcome?
        XCTAssertNoThrow(outcome = try state.recordVerifiedContent(first, trust: trust, now: 1000),
                         "Actual lifecycle storage must accept a current capsule before its signed dismiss")
        guard outcome != nil else { return }
        let dismiss = content(trust, nonce: 2, revision: 2, kind: 6, issued: 900, expiry: 1100)
        XCTAssertEqual(try state.recordVerifiedContent(dismiss, trust: trust, now: 1000), .dismiss)
        XCTAssertThrowsError(try state.reverifyLatestContent(first, trust: trust, now: 1000), "Terminal dismiss cannot leave action authority")
        try state.forgetMachine(rid: trust.rid)
        XCTAssertThrowsError(try state.recordVerifiedContent(first, trust: trust, now: 1000))
        try state.installMachineTrust(trust, generation: state.authorityGeneration())
        let resurrection = content(trust, nonce: 3, revision: 3, issued: 4621, expiry: 4721)
        XCTAssertThrowsError(try state.recordVerifiedContent(resurrection, trust: trust, now: 4621),
                             "Forget/re-pair cannot erase an absorbing tombstone before MAX seen expiry plus skew")
        let afterRetention = content(trust, nonce: 4, revision: 3, issued: 4721, expiry: 4731)
        XCTAssertEqual(try state.recordVerifiedContent(afterRetention, trust: trust, now: 4721), .publish)
    }

    func testCombinedNonceAndCollapseCapacityNeverEvictsLiveState() throws {
        let state = try NativePushState(file: directory.appendingPathComponent("replay-cap.sqlite"), maximumEntries: 4)
        let trust = try paired(state)
        let first = content(trust)
        var outcome: NativePushState.ContentOutcome?
        XCTAssertNoThrow(outcome = try state.recordVerifiedContent(first, trust: trust, now: 1000),
                         "Actual combined quota must accept the first nonce AND collapse record")
        guard outcome != nil else { return }
        let update = content(trust, nonce: 2, revision: 2, expiry: 2000)
        XCTAssertEqual(try state.recordVerifiedContent(update, trust: trust, now: 1000), .publish)
        let second = content(trust, nonce: 3, collapse: "AgICAgICAgICAgICAgICAg", expiry: 2000)
        XCTAssertThrowsError(try state.recordVerifiedContent(second, trust: trust, now: 1000),
                             "2048 policy is TOTAL nonce plus collapse rows, never a per-table allowance")
        XCTAssertNoThrow(try state.reverifyLatestContent(update, trust: trust, now: 1000), "Capacity refusal cannot evict existing live state")
        XCTAssertEqual(try state.recordVerifiedContent(first, trust: trust, now: 1000), .duplicate)
        XCTAssertEqual(try state.recordVerifiedContent(second, trust: trust, now: 1161), .publish,
                       "Only expired replay records may free capacity")
    }

    func testContentCannotCommitOrGrantActionsAfterNativeAuthorityChanges() throws {
        let state = try NativePushState(file: directory.appendingPathComponent("replay-authority.sqlite"))
        let trust = try paired(state)
        let first = content(trust)
        var outcome: NativePushState.ContentOutcome?
        XCTAssertNoThrow(outcome = try state.recordVerifiedContent(first, trust: trust, now: 1000),
                         "Actual content acceptance requires installed public authority and completed trust")
        guard outcome != nil else { return }
        try invalidate(state)
        XCTAssertThrowsError(try state.reverifyLatestContent(first, trust: trust, now: 1000))
        XCTAssertThrowsError(try state.recordVerifiedContent(content(trust, nonce: 2, revision: 2), trust: trust, now: 1000))
        try install(state, publicKey: trust.authority.publicKey, revision: trust.authority.revision)
        XCTAssertThrowsError(try state.reverifyLatestContent(first, trust: trust, now: 1000), "Identity authority installation cannot recreate completed trust")
    }

    func testConcurrentActualProcessesAcceptOneCapsuleOnlyOnce() throws {
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let macos = source.deletingLastPathComponent()
        let helper = directory.appendingPathComponent("owned-replay-helper")
        _ = try ownedProcess(URL(fileURLWithPath: "/usr/bin/xcrun"), ["swiftc",
            macos.appendingPathComponent("Remi/NativePush/NativePushState.swift").path,
            macos.appendingPathComponent("Remi/NativePush/NativeEd25519PublicKey.swift").path,
            source.appendingPathComponent("fixtures/NativePushStateProcess/main.swift").path, "-o", helper.path])
        let file = directory.appendingPathComponent("concurrent.sqlite")
        let state = try NativePushState(file: file)
        let trust = try paired(state)
        let first = content(trust)
        let json: [String: Any] = ["rid": first.rid.base64EncodedString(), "collapseId": first.collapseId,
            "revision": first.revision, "kind": first.kind, "nonce": first.nonce.base64EncodedString(),
            "digest": first.digest.base64EncodedString(), "issuedAt": first.issuedAt, "expiresAt": first.expiresAt]
        let fixture = try JSONSerialization.data(withJSONObject: json).base64EncodedString()
        var children: [(Process, Pipe)] = []
        defer {
            // Even a failed assertion/throw owns and joins every helper it launched.
            for (child, output) in children where child.isRunning {
                child.terminate()
                _ = try? collectOwnedProcess(child, output: output, timeout: 2)
            }
        }
        for _ in 0..<2 {
            let child = Process(); let output = Pipe()
            child.executableURL = helper
            child.arguments = [file.path, "record", fixture]
            child.standardOutput = output; child.standardError = output
            try child.run(); children.append((child, output))
        }
        let deadline = ProcessInfo.processInfo.systemUptime + 8
        while ProcessInfo.processInfo.systemUptime < deadline {
            if children.allSatisfy({ FileManager.default.fileExists(atPath: file.appendingPathExtension("ready-" + String($0.0.processIdentifier)).path) }) { break }
            Thread.sleep(forTimeInterval: 0.01)
        }
        XCTAssertTrue(children.allSatisfy({ FileManager.default.fileExists(atPath: file.appendingPathExtension("ready-" + String($0.0.processIdentifier)).path) }),
                      "Both actual production-store processes must reach the external start barrier")
        try Data().write(to: file.appendingPathExtension("start"))
        let outcomes = try children.map { try collectOwnedProcess($0.0, output: $0.1) }.sorted()
        XCTAssertEqual(outcomes, ["duplicate", "publish"], "A single real cross-process SQLite transaction owns publication")
        XCTAssertNoThrow(try state.reverifyLatestContent(first, trust: trust, now: 1000))
    }

    func testPositiveOldGenerationCannotInstallTrustAfterSameIdentityRecovery() throws {
        let state = try NativePushState(file: directory.appendingPathComponent("trust-recovery.sqlite"))
        let trust = try paired(state)
        let oldGeneration = try state.authorityGeneration()
        XCTAssertGreaterThan(oldGeneration, 0)
        // A verified recovery may restore the same public record. Its completed
        // pairing still belongs to the NEW durable invalidation generation.
        try install(state, publicKey: trust.authority.publicKey, revision: trust.authority.revision)
        XCTAssertGreaterThan(try state.authorityGeneration(), oldGeneration)
        XCTAssertThrowsError(try state.installMachineTrust(trust, generation: oldGeneration),
                             "A positive old generation cannot commit completed trust after recovery")
        XCTAssertNil(try state.machineTrust(rid: trust.rid))
        XCTAssertNoThrow(try state.installMachineTrust(trust, generation: state.authorityGeneration()))
        XCTAssertEqual(try state.machineTrust(rid: trust.rid), trust)
    }

}
