import CryptoKit
import Darwin
import Foundation

/// Sequential bounded reads from one descriptor-confined owned copy. The caller must
/// serialize access, send only the returned bytes, and call `finish` before complete. A digest
/// mismatch refuses completion; it cannot undo already delivered partial bytes on the host.
final class ImageSnapshotReader {
    enum Failure: Error, Equatable { case unavailable, invalidRange, integrity }

    private var descriptor: Int32
    private let byteCount: Int
    private let expectedDigest: Data
    private let verifyEntry: () throws -> Void
    private let claim: ImageRecoveryJournal.SnapshotReadClaim
    private var count = 0
    private var hasher = SHA256()

    init(descriptor: Int32, byteCount: Int, digest: Data, claim: ImageRecoveryJournal.SnapshotReadClaim,
         verifyEntry: @escaping () throws -> Void) {
        self.descriptor = descriptor
        self.byteCount = byteCount
        self.expectedDigest = digest
        self.claim = claim
        self.verifyEntry = verifyEntry
    }

    func read(offset: Int, count requested: Int) throws -> Data {
        do {
            guard descriptor >= 0, offset == count, requested > 0, requested <= ImageStagingLimits.chunkBytes,
                  requested <= byteCount - count else { throw Failure.invalidRange }
            try verifyEntry()
            var data = Data(count: requested)
            try data.withUnsafeMutableBytes { buffer in
                guard let base = buffer.baseAddress else { throw Failure.unavailable }
                var filled = 0
                while filled < requested {
                    let readCount = pread(descriptor, base.advanced(by: filled), requested - filled, off_t(offset + filled))
                    if readCount < 0, errno == EINTR { continue }
                    guard readCount > 0 else { throw Failure.unavailable }
                    filled += readCount
                }
            }
            try verifyEntry()
            hasher.update(data: data)
            count += requested
            return data
        } catch {
            close()
            throw error
        }
    }

    /// Verifies the bytes returned to the sender, then releases the descriptor and cleanup lock.
    func finish() throws {
        do {
            guard descriptor >= 0, count == byteCount else { throw Failure.invalidRange }
            try verifyEntry()
            guard Data(hasher.finalize()) == expectedDigest else { throw Failure.integrity }
            close()
        } catch {
            close()
            throw error
        }
    }

    func close() {
        if descriptor >= 0 { Darwin.close(descriptor); descriptor = -1 }
        claim.release()
    }

    deinit { close() }
}
