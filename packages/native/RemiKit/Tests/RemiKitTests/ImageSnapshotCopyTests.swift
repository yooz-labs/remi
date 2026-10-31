import CryptoKit
import Darwin
import Foundation
import Testing
@testable import RemiKit

/// These own only synthetic files. The caller still has to reserve and persist the slot,
/// protect the directory, validate media and clean up any partial destination.
@Suite struct ImageSnapshotCopyTests {
    private func withFiles(_ bytes: Data, body: (Int32, Int32, URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-image-copy-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                                attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let input = directory.appendingPathComponent("source")
        let output = directory.appendingPathComponent("snapshot")
        try bytes.write(to: input)
        let source = open(input.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        let destination = open(output.path, O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard source >= 0, destination >= 0 else { throw POSIXError(.EIO) }
        defer { close(source); close(destination) }
        try body(source, destination, output)
    }

    @Test func streamsExactBytesAndDigestAtTheLimit() throws {
        let bytes = Data(repeating: 0xa5, count: ImageStagingLimits.imageBytes)
        try withFiles(bytes) { source, destination, output in
            let result = try ImageSnapshotCopy.capture(source: source, destination: destination)
            #expect(result.byteCount == bytes.count)
            #expect(result.digest == Data(SHA256.hash(data: bytes)))
            #expect(try Data(contentsOf: output) == bytes)
        }
    }

    @Test func refusesLargerSourceWithoutClaimingOrDeletingItsDestination() throws {
        let bytes = Data(repeating: 0xa5, count: ImageStagingLimits.imageBytes + 1)
        try withFiles(bytes) { source, destination, output in
            #expect(throws: ImageSnapshotCopy.Failure.tooLarge) {
                try ImageSnapshotCopy.capture(source: source, destination: destination)
            }
            #expect(FileManager.default.fileExists(atPath: output.path))
            let saved = try Data(contentsOf: output)
            #expect(saved.isEmpty)
        }
    }

    @Test func refusesNonemptyDestinationAndSameFile() throws {
        try withFiles(Data([1, 2, 3])) { source, destination, _ in
            let marker: [UInt8] = [4]
            #expect(marker.withUnsafeBytes { write(destination, $0.baseAddress, $0.count) } == 1)
            #expect(throws: (any Error).self) { try ImageSnapshotCopy.capture(source: source, destination: destination) }
            #expect(throws: (any Error).self) { try ImageSnapshotCopy.capture(source: source, destination: source) }
        }
    }

    @Test func cancellationLeavesOwnedPartialFileForJournalledCleanup() throws {
        try withFiles(Data(repeating: 7, count: 100_000)) { source, destination, output in
            var checks = 0
            #expect(throws: ImageSnapshotCopy.Failure.cancelled) {
                try ImageSnapshotCopy.capture(source: source, destination: destination) {
                    checks += 1
                    return checks > 1
                }
            }
            #expect(FileManager.default.fileExists(atPath: output.path))
            let partial = try Data(contentsOf: output)
            #expect(!partial.isEmpty && partial.count < 100_000)
        }
    }
}
