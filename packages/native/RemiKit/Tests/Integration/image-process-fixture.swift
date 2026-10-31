import CryptoKit
import Darwin
import Foundation
@testable import RemiKit

// Synthetic qualification helper. It uses its own private case directory and key;
// it never contacts a daemon, opens an owner file, or invokes a network effect.
enum FixtureError: Error { case arguments, io, invariant }

func verify(_ condition: @autoclosure () -> Bool) throws {
    if !condition() { throw FixtureError.invariant }
}

func markAndDie(_ marker: URL) throws -> Never {
    let fd = open(marker.path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw FixtureError.io }
    var byte: UInt8 = 1
    guard write(fd, &byte, 1) == 1, fsync(fd) == 0 else { close(fd); throw FixtureError.io }
    close(fd)
    kill(getpid(), SIGKILL)
    fatalError("SIGKILL failed")
}

func run() throws {
    guard CommandLine.arguments.count == 4 else { throw FixtureError.arguments }
    let mode = CommandLine.arguments[1]
    let stage = CommandLine.arguments[2]
    guard ["reserved", "registered", "partial", "abandon_intent", "after_unlink_constructed"].contains(stage) else {
        throw FixtureError.arguments
    }
    let parent = URL(fileURLWithPath: CommandLine.arguments[3], isDirectory: true)
    let cases = parent.deletingLastPathComponent()
    let fixtureRoot = cases.deletingLastPathComponent()
    let temporaryRoot = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
    guard parent.lastPathComponent.hasPrefix("case."), cases.lastPathComponent == "cases",
          fixtureRoot.lastPathComponent.hasPrefix("remi-image-process."),
          fixtureRoot.deletingLastPathComponent().resolvingSymlinksInPath() == temporaryRoot else {
        throw FixtureError.arguments
    }
    var rootInfo = stat()
    guard lstat(fixtureRoot.path, &rootInfo) == 0, (rootInfo.st_mode & S_IFMT) == S_IFDIR,
          rootInfo.st_uid == geteuid(), (rootInfo.st_mode & 0o7777) == 0o700 else { throw FixtureError.arguments }
    var casesInfo = stat()
    guard lstat(cases.path, &casesInfo) == 0, (casesInfo.st_mode & S_IFMT) == S_IFDIR,
          casesInfo.st_uid == geteuid(), (casesInfo.st_mode & 0o7777) == 0o700 else { throw FixtureError.arguments }
    var parentInfo = stat()
    guard lstat(parent.path, &parentInfo) == 0, (parentInfo.st_mode & S_IFMT) == S_IFDIR,
          parentInfo.st_uid == geteuid(), (parentInfo.st_mode & 0o7777) == 0o700 else { throw FixtureError.arguments }
    let root = parent.appendingPathComponent("images", isDirectory: true)
    let input = parent.appendingPathComponent("source")
    let marker = parent.appendingPathComponent("phase-ready")
    let secret = Data(repeating: 0x41, count: 32)
    if mode == "crash" {
        guard try FileManager.default.contentsOfDirectory(atPath: parent.path).isEmpty else { throw FixtureError.arguments }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try Data(repeating: 0x7b, count: 100_000).write(to: input)
        try Data([5, 6, 7]).write(to: root.appendingPathComponent("unrelated"))
    }
    let parentFD = open(parent.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    let rootFD = open(root.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    guard parentFD >= 0, rootFD >= 0 else { throw FixtureError.io }
    defer { close(parentFD); close(rootFD) }
    let lease = try ImageDirectoryLease(parent: parentFD, rootName: "images", directory: rootFD)
    let disk = ImageJournalDisk(lease: lease, secret: secret)
    if mode == "crash" {
        try disk.initializeIfProvenFresh(ImageRecoveryLedger().encodeJournal(secret: secret))
        let claim = try disk.claimOwner()
        let journal = try ImageRecoveryJournal(disk: disk, secret: secret, claim: claim)
        let owner = ImageSnapshotOwner(lease: lease, journal: journal)
        let id = try journal.reserveCopy()
        if stage == "reserved" { try markAndDie(marker) }
        let source = open(input.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard source >= 0 else { throw FixtureError.io }
        defer { close(source) }
        var checks = 0
        _ = try owner.capture(id: id, source: source) {
            checks += 1
            if (stage == "registered" && checks == 1) || (stage == "partial" && checks == 2) {
                try? markAndDie(marker)
            }
            return false
        }
        if stage == "abandon_intent" || stage == "after_unlink_constructed" {
            try journal.requestLocalAbandonment(id, confirmed: true)
            if stage == "after_unlink_constructed" {
                let name = "image-\(id.uuidString.lowercased())"
                guard unlinkat(rootFD, name, 0) == 0, fsync(rootFD) == 0 else { throw FixtureError.io }
            }
            try markAndDie(marker)
        }
        throw FixtureError.arguments
    }
    guard mode == "recover", FileManager.default.fileExists(atPath: marker.path) else { throw FixtureError.arguments }
    let claim = try disk.claimOwner()
    let journal = try ImageRecoveryJournal(disk: disk, secret: secret, claim: claim)
    let records = journal.snapshot.records
    try verify(records.count == 1)
    let record = records[0]
    try verify(record.exposure == .copyOrphaned)
    let name = "image-\(record.id.uuidString.lowercased())"
    var info = stat()
    let hasSnapshot = fstatat(rootFD, name, &info, AT_SYMLINK_NOFOLLOW) == 0
    if stage == "reserved" || stage == "after_unlink_constructed" {
        try verify(!hasSnapshot && errno == ENOENT)
    } else {
        try verify(hasSnapshot && record.snapshotIdentity != nil)
        if stage == "registered" { try verify(info.st_size == 0) }
        if stage == "partial" { try verify(info.st_size > 0 && info.st_size < 100_000) }
    }
    let owner = ImageSnapshotOwner(lease: lease, journal: journal)
    try owner.abandon(id: record.id, confirmed: true)
    try verify(journal.snapshot.records.isEmpty && journal.snapshot.localSnapshotID == nil)
    let unrelated = try Data(contentsOf: root.appendingPathComponent("unrelated"))
    try verify(unrelated == Data([5, 6, 7]))
    let original = try Data(contentsOf: input)
    try verify(original == Data(repeating: 0x7b, count: 100_000))
    print("PASS \(stage)")
}

do { try run() } catch {
    // No user content, paths, or key bytes are printed on refusal.
    print("fixture refused")
    exit(1)
}
