import Foundation
import Testing
@testable import RemiPush

struct NativePushFileProtectionTests {
    private func root() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("remi-x2-directory-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        return url
    }

    @Test func repeatedSetupPreservesExistingContents() throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let directory = root.appendingPathComponent("native-debug")
        try NativePushFileProtection.prepareDirectory(directory)
        let sentinel = directory.appendingPathComponent("existing-ledger-marker")
        let bytes = Data("existing owned state".utf8)
        try bytes.write(to: sentinel)
        try NativePushFileProtection.prepareDirectory(directory)
        #expect(try Data(contentsOf: sentinel) == bytes)
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
    }

    @Test(arguments: ["file", "symlink"])
    func refusesNonDirectoryEntry(_ kind: String) throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let entry = root.appendingPathComponent("native-debug")
        if kind == "file" {
            try Data("owned regular file".utf8).write(to: entry)
        } else {
            let target = root.appendingPathComponent("owned-target")
            try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
            try FileManager.default.createSymbolicLink(at: entry, withDestinationURL: target)
        }
        #expect(throws: (any Error).self) {
            try NativePushFileProtection.prepareDirectory(entry)
        }
    }

    @Test func missingParentIsNotCreated() throws {
        let root = try root()
        defer { try? FileManager.default.removeItem(at: root) }
        let missing = root.appendingPathComponent("missing")
        #expect(throws: (any Error).self) {
            try NativePushFileProtection.prepareDirectory(missing.appendingPathComponent("native-debug"))
        }
        #expect(!FileManager.default.fileExists(atPath: missing.path))
    }
}
