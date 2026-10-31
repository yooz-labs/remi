import CryptoKit
import Darwin
import Foundation
import Testing
@testable import RemiKit

/// Synthetic design qualification only. This is not a production reset, Keychain,
/// notification-center integration, or proof of power-loss durability.
@Suite(.serialized) struct LocalNoticeResetQualificationTests {
    private func directory() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("remi-reset-qualification-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return dir
    }

    @Test func actualLedgerLockExcludesIndependentOwnerEvenWhenDatabaseIsCorrupt() throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let ledger = try LocalNoticeLedger(directory: dir)
        let path = dir.appendingPathComponent("local-notifications.lock").path
        let fd = open(path, O_RDWR | O_NOFOLLOW)
        try #require(fd >= 0)
        defer { _ = flock(fd, LOCK_UN); _ = Darwin.close(fd); ledger.close() }
        #expect(flock(fd, LOCK_EX | LOCK_NB) == -1)
        #expect(errno == EWOULDBLOCK || errno == EAGAIN)
        ledger.close()
        #expect(flock(fd, LOCK_EX | LOCK_NB) == 0)
        #expect(throws: LocalNoticeError.busy) { _ = try LocalNoticeLedger(directory: dir, createIfMissing: false) }
        #expect(flock(fd, LOCK_UN) == 0)
        try Data("synthetic corruption".utf8).write(to: dir.appendingPathComponent("local-notifications.sqlite"))
        #expect(throws: (any Error).self) { _ = try LocalNoticeLedger(directory: dir, createIfMissing: false) }
        // A corrupt open releases its own lock. A reset owner must acquire a shared
        // outer lock independently; the existing ledger does not provide it.
        #expect(flock(fd, LOCK_EX | LOCK_NB) == 0)
    }

    @Test func actualLedgerRejectsSyntheticJournalSymlink() throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let untouched = dir.appendingPathComponent("other-synthetic-file")
        let content = Data("do not modify".utf8)
        try content.write(to: untouched)
        let journal = dir.appendingPathComponent("local-notifications.sqlite")
        try FileManager.default.createSymbolicLink(at: journal, withDestinationURL: untouched)
        #expect(throws: (any Error).self) { _ = try LocalNoticeLedger(directory: dir, createIfMissing: false) }
        #expect(try Data(contentsOf: untouched) == content)
    }

    private enum Recovery: Equatable { case ready(String), reviewRequired }
    private struct Intent: Codable, Equatable {
        let old: String
        let replacement: String
        let captured: [String]
    }
    private struct Item {
        let id: String
        let local: Bool
        let reserved: Bool
    }
    /// Test-only filesystem stand-in for generation-specific Keychain accounts.
    /// No production keychain function is called or modified.
    private struct Candidate {
        let root: URL
        var pointer: URL { root.appendingPathComponent("active") }
        var fence: URL { root.appendingPathComponent("reset-fence") }
        var intent: URL { root.appendingPathComponent("reset-intent.json") }
        var checkpoint: URL { root.appendingPathComponent("reset-complete.json") }
        func generation(_ id: String) -> URL { root.appendingPathComponent(id, isDirectory: true) }
        func key(_ id: String) -> URL { generation(id).appendingPathComponent("synthetic-key") }
        func marker(_ id: String) -> URL { generation(id).appendingPathComponent("proof.json") }
        func writePointer(_ id: String) throws { try Data(id.utf8).write(to: pointer, options: .atomic) }
        func writeFence(_ value: String) throws { try Data(value.utf8).write(to: fence, options: .atomic) }
        func writeIntent(old: String, replacement: String, captured: [String]) throws {
            var entry = stat()
            guard old == "old", replacement == "new", captured.count <= 128,
                  Set(captured).count == captured.count,
                  lstat(intent.path, &entry) == -1, errno == ENOENT else { throw LocalNoticeError.changed }
            try writeFence("resetting")
            try JSONEncoder().encode(Intent(old: old, replacement: replacement, captured: captured)).write(to: intent, options: .withoutOverwriting)
        }
        func complete() throws {
            guard readRegular(fence) == Data("resetting".utf8), let bytes = readRegular(intent),
                  let expected = try? JSONDecoder().decode(Intent.self, from: bytes),
                  expected.old == "old", expected.replacement == "new",
                  readRegular(pointer) == Data(expected.replacement.utf8), validated(expected.replacement) else {
                throw LocalNoticeError.changed
            }
            try bytes.write(to: checkpoint, options: .withoutOverwriting)
        }
        func clearIntentAfterCheckpoint() throws {
            guard readRegular(fence) == Data("resetting".utf8), let bytes = readRegular(intent), let completed = readRegular(checkpoint),
                  let expected = try? JSONDecoder().decode(Intent.self, from: bytes),
                  let verified = try? JSONDecoder().decode(Intent.self, from: completed), expected == verified,
                  readRegular(pointer) == Data(expected.replacement.utf8), validated(expected.replacement) else {
                throw LocalNoticeError.changed
            }
            try FileManager.default.removeItem(at: intent)
        }
        func finish() throws {
            var entry = stat()
            guard lstat(intent.path, &entry) == -1, errno == ENOENT,
                  readRegular(fence) == Data("resetting".utf8), let bytes = readRegular(checkpoint),
                  let expected = try? JSONDecoder().decode(Intent.self, from: bytes),
                  expected.old == "old", expected.replacement == "new",
                  readRegular(pointer) == Data(expected.replacement.utf8), validated(expected.replacement) else {
                throw LocalNoticeError.changed
            }
            try writeFence("stable")
        }
        func createKey(_ id: String, byte: UInt8) throws {
            let folder = generation(id)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            // .withoutOverwriting makes a collision a failure, not a replacement.
            try Data(repeating: byte, count: 32).write(to: key(id), options: .withoutOverwriting)
        }
        @discardableResult func createLedger(_ id: String, saveProof: Bool = true) throws -> LocalNoticeMarker {
            let bytes = try Data(contentsOf: key(id))
            let keys = try LocalNoticeKeys(root: bytes)
            let ledger = try LocalNoticeLedger(directory: generation(id))
            defer { ledger.close() }
            let owner = try keys.ownerIndex(runtimeOwner: UUID())
            let question = try keys.questionIndex(owner: owner, sessionID: "synthetic-session", questionID: "synthetic-question")
            try ledger.createOwner(owner)
            let ticket = try ledger.prepare(owner: owner, question: question)
            let proof = try keys.marker(requestID: ticket.requestID, owner: owner, sequence: ticket.sequence, question: question)
            if saveProof { try save(proof, id: id) }
            return proof
        }
        func save(_ proof: LocalNoticeMarker, id: String) throws {
            try JSONEncoder().encode(proof).write(to: marker(id), options: .withoutOverwriting)
        }
        func readRegular(_ url: URL) -> Data? {
            var info = stat()
            guard lstat(url.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
                  info.st_uid == getuid() else { return nil }
            return try? Data(contentsOf: url)
        }
        func validated(_ id: String) -> Bool {
            var folder = stat()
            guard lstat(generation(id).path, &folder) == 0, (folder.st_mode & S_IFMT) == S_IFDIR,
                  folder.st_uid == getuid(), let bytes = readRegular(key(id)),
                  let keys = try? LocalNoticeKeys(root: bytes),
                  let encoded = readRegular(marker(id)),
                  let proof = try? JSONDecoder().decode(LocalNoticeMarker.self, from: encoded),
                  keys.verifies(proof, systemIdentifier: proof.systemIdentifier),
                  let ledger = try? LocalNoticeLedger(directory: generation(id), createIfMissing: false) else { return false }
            defer { ledger.close() }
            return (try? ledger.classify(proof, keys: keys, systemIdentifier: proof.systemIdentifier)) == .historicalActive
        }
        func start() -> Recovery {
            // A reset intent is a fence even if the old pair is still intact or
            // the replacement pointer appears valid. Never auto-complete it.
            var entry = stat()
            guard readRegular(fence) == Data("stable".utf8),
                  lstat(intent.path, &entry) == -1, errno == ENOENT else { return .reviewRequired }
            guard let data = readRegular(pointer), let id = String(data: data, encoding: .utf8),
                  ["old", "new"].contains(id), validated(id) else { return .reviewRequired }
            if id == "new" {
                guard let bytes = readRegular(checkpoint),
                      let recorded = try? JSONDecoder().decode(Intent.self, from: bytes),
                      recorded.old == "old", recorded.replacement == id else { return .reviewRequired }
            }
            return .ready(id)
        }
        func capturedIDs(_ values: [Item]) -> [String] {
            values.filter { $0.local && $0.reserved }.map(\.id)
        }
        func removals(captured: [String], current: [Item]) -> [String] {
            let authorized = Set(captured)
            return current.filter { authorized.contains($0.id) && $0.local && $0.reserved }.map(\.id)
        }
    }

    @Test func resetIntentFencesEverySyntheticInterruptionAndNeverAdoptsPartialReplacement() throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let c = Candidate(root: dir)
        try c.createKey("old", byte: 17); try c.createLedger("old"); try c.writePointer("old"); try c.writeFence("stable")
        #expect(c.start() == .ready("old"))
        try c.writeFence("resetting")
        #expect(c.start() == .reviewRequired) // death after fence but before intent
        try c.writeIntent(old: "old", replacement: "new", captured: ["remi.local.v1.synthetic"])
        #expect(c.start() == .reviewRequired) // death after confirmation
        try c.createKey("new", byte: 23)
        #expect(c.start() == .reviewRequired) // death after key but before DB
        let newProof = try c.createLedger("new", saveProof: false)
        #expect(c.start() == .reviewRequired) // death after DB but before proof
        #expect(!c.validated("new"))
        try c.save(newProof, id: "new")
        #expect(c.validated("new"))
        #expect(c.start() == .reviewRequired) // death after DB/proof but before pointer
        #expect(throws: LocalNoticeError.changed) { try c.clearIntentAfterCheckpoint() }
        try c.writePointer("new")
        #expect(c.start() == .reviewRequired) // death after pointer but before checkpoint
        #expect(throws: LocalNoticeError.changed) { try c.clearIntentAfterCheckpoint() }
        let savedIntent = try Data(contentsOf: c.intent)
        try FileManager.default.removeItem(at: c.intent)
        #expect(c.start() == .reviewRequired) // a missing intent is not a completion proof
        try savedIntent.write(to: c.intent, options: .withoutOverwriting)
        try c.complete()
        #expect(c.start() == .reviewRequired) // death after checkpoint but before fence clear
        try c.clearIntentAfterCheckpoint()
        #expect(c.start() == .reviewRequired) // death after intent removal, before stable fence
        try c.finish()
        #expect(c.start() == .ready("new"))
        #expect(c.validated("old")) // no old-generation deletion occurs in this model
    }

    @Test func mismatchedGenerationCollisionAndExactScopeFailClosed() throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let c = Candidate(root: dir)
        try c.createKey("old", byte: 31); try c.createLedger("old"); try c.writePointer("old"); try c.writeFence("stable")
        #expect(c.start() == .ready("old"))
        let oldProof = try Data(contentsOf: c.marker("old"))
        try c.createKey("new", byte: 37); try c.createLedger("new")
        #expect(throws: (any Error).self) { try c.createKey("new", byte: 41) }
        try oldProof.write(to: c.marker("new"), options: .atomic)
        try c.writePointer("new")
        #expect(c.start() == .reviewRequired) // old marker cannot authenticate as new
        let original = [Item(id: "selected", local: true, reserved: true),
                        Item(id: "remote", local: false, reserved: true),
                        Item(id: "unrelated", local: true, reserved: false)]
        let captured = c.capturedIDs(original)
        #expect(captured == ["selected"])
        let later = [Item(id: "selected", local: true, reserved: true),
                     Item(id: "late", local: true, reserved: true),
                     Item(id: "remote", local: false, reserved: true)]
        #expect(c.removals(captured: captured, current: later) == ["selected"])
        #expect(c.removals(captured: captured, current: [Item(id: "selected", local: false, reserved: true)]).isEmpty)
        try c.writePointer("old")
        try FileManager.default.createSymbolicLink(at: c.intent, withDestinationURL: dir.appendingPathComponent("missing"))
        #expect(c.start() == .reviewRequired) // even a dangling intent symlink is not absence
        try FileManager.default.removeItem(at: c.intent)
        let originalKey = try Data(contentsOf: c.key("old"))
        let otherKey = dir.appendingPathComponent("other-synthetic-key")
        try originalKey.write(to: otherKey)
        try FileManager.default.removeItem(at: c.key("old"))
        try FileManager.default.createSymbolicLink(at: c.key("old"), withDestinationURL: otherKey)
        #expect(c.start() == .reviewRequired)
        #expect(try Data(contentsOf: otherKey) == originalKey)
    }
}
