#if os(iOS)
import Darwin
import Foundation
import Testing
@testable import RemiKit

/// Synthetic files only. A simulator attribute check does not prove locked-device behavior.
@Suite struct ImageFileProtectionTests {
    private func withFixture(_ body: (URL, Int32, Int32, String, ImageDirectoryLease) throws -> Void) throws {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent("remi-image-protection-\(UUID().uuidString)")
        let root = parent.appendingPathComponent("images")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: parent) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let parentFD = open(parent.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        let rootFD = open(root.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard parentFD >= 0, rootFD >= 0 else { throw POSIXError(.EIO) }
        defer { close(parentFD); close(rootFD) }
        let name = "image-\(UUID().uuidString.lowercased())"
        let file = openat(rootFD, name, O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard file >= 0 else { throw POSIXError(.EIO) }
        defer { close(file) }
        let lease = try ImageDirectoryLease(parent: parentFD, rootName: "images", directory: rootFD)
        try body(root, rootFD, file, name, lease)
    }

    @Test func appliesProtectionBeforeWritingSyntheticBytes() throws {
        try withFixture { root, _, file, name, lease in
            try ImageFileProtection.prepareRoot(lease: lease, rootURL: root)
            try ImageFileProtection.apply(lease: lease, rootURL: root, name: name, descriptor: file)
            let url = root.appendingPathComponent(name)
            let values = try url.resourceValues(forKeys: [.fileProtectionKey, .isExcludedFromBackupKey])
            #expect(values.fileProtection == .complete)
            #expect(values.isExcludedFromBackup == true)
            var byte: UInt8 = 7
            #expect(write(file, &byte, 1) == 1)
        }
    }

    @Test func refusesMismatchedOrUnownedPathWithoutChangingFile() throws {
        try withFixture { root, _, file, name, lease in
            let other = root.deletingLastPathComponent()
            #expect(throws: (any Error).self) { try ImageFileProtection.apply(lease: lease, rootURL: other, name: name, descriptor: file) }
            #expect(throws: (any Error).self) { try ImageFileProtection.apply(lease: lease, rootURL: root, name: "../other", descriptor: file) }
            var metadata = stat()
            #expect(fstat(file, &metadata) == 0 && metadata.st_size == 0)
        }
    }

    @Test func refusesAFileThatAlreadyContainsBytes() throws {
        try withFixture { root, _, file, name, lease in
            try ImageFileProtection.prepareRoot(lease: lease, rootURL: root)
            var byte: UInt8 = 7
            #expect(write(file, &byte, 1) == 1)
            #expect(throws: (any Error).self) { try ImageFileProtection.apply(lease: lease, rootURL: root, name: name, descriptor: file) }
            var metadata = stat()
            #expect(fstat(file, &metadata) == 0 && metadata.st_size == 1)
        }
    }

    @Test func verifiesProtectionAgainAfterRename() throws {
        try withFixture { root, rootFD, file, name, lease in
            try ImageFileProtection.prepareRoot(lease: lease, rootURL: root)
            try ImageFileProtection.apply(lease: lease, rootURL: root, name: name, descriptor: file)
            var byte: UInt8 = 7
            #expect(write(file, &byte, 1) == 1)
            #expect(renameat(rootFD, name, rootFD, ".image-journal") == 0)
            try ImageFileProtection.refreshAfterRename(lease: lease, rootURL: root, name: ".image-journal", descriptor: file)
            let url = root.appendingPathComponent(".image-journal")
            let values = try url.resourceValues(forKeys: [.fileProtectionKey, .isExcludedFromBackupKey])
            #expect(values.fileProtection == .complete)
            #expect(values.isExcludedFromBackup == true)
        }
    }
}
#endif
