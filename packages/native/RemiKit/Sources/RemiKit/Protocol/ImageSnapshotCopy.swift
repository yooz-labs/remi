import CryptoKit
import Darwin
import Foundation

/// Bounded byte copying only. The installation owner must reserve and durably journal the
/// destination first, open both descriptors without following links, protect the file, validate
/// media, and retain partial-file cleanup debt on every failure. This does not authorize sending.
enum ImageSnapshotCopy {
    enum Failure: Error, Equatable {
        case invalidFile
        case tooLarge
        case cancelled
        case io
    }

    struct Result: Sendable {
        let byteCount: Int
        let digest: Data
    }

    static func capture(source: Int32, destination: Int32, cancelled: () -> Bool = { false }) throws -> Result {
        var input = stat()
        var output = stat()
        guard fstat(source, &input) == 0, fstat(destination, &output) == 0,
              (input.st_mode & S_IFMT) == S_IFREG, (output.st_mode & S_IFMT) == S_IFREG,
              output.st_uid == geteuid(), output.st_nlink == 1, (output.st_mode & 0o7777) == 0o600,
              output.st_size == 0, input.st_size >= 0,
              !(input.st_dev == output.st_dev && input.st_ino == output.st_ino),
              lseek(source, 0, SEEK_CUR) == 0, lseek(destination, 0, SEEK_CUR) == 0 else {
            throw Failure.invalidFile
        }
        guard input.st_size <= ImageStagingLimits.imageBytes else { throw Failure.tooLarge }
        var hash = SHA256()
        var total = 0
        var buffer = [UInt8](repeating: 0, count: ImageStagingLimits.chunkBytes)
        while true {
            guard !cancelled() else { throw Failure.cancelled }
            // Read one byte beyond the remaining allowance to catch a source that grows.
            let request = min(buffer.count, ImageStagingLimits.imageBytes - total + 1)
            let count = buffer.withUnsafeMutableBytes { Darwin.read(source, $0.baseAddress, request) }
            if count < 0 {
                if errno == EINTR { continue }
                throw Failure.io
            }
            if count == 0 { break }
            guard count <= ImageStagingLimits.imageBytes - total else { throw Failure.tooLarge }
            try buffer.withUnsafeBytes { bytes in
                guard let base = bytes.baseAddress else { throw Failure.io }
                var offset = 0
                while offset < count {
                    let written = Darwin.write(destination, base.advanced(by: offset), count - offset)
                    if written < 0, errno == EINTR { continue }
                    guard written > 0 else { throw Failure.io }
                    offset += written
                }
            }
            hash.update(data: Data(buffer.prefix(count)))
            total += count
        }
        guard total > 0 else { throw Failure.invalidFile }
        guard !cancelled() else { throw Failure.cancelled }
        guard fsync(destination) == 0, fstat(destination, &output) == 0,
              (output.st_mode & S_IFMT) == S_IFREG, output.st_uid == geteuid(), output.st_nlink == 1,
              (output.st_mode & 0o7777) == 0o600, output.st_size == total else { throw Failure.io }
        return Result(byteCount: total, digest: Data(hash.finalize()))
    }
}
