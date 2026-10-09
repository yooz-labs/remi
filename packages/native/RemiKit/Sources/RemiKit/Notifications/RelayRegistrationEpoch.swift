import Foundation

/// A synchronous send guard can inspect the latest OS-token lifetime without
/// hopping to the UI actor between its final validation and channel emission.
final class RelayRegistrationEpoch: @unchecked Sendable {
    private let lock = NSLock()
    private var value = UUID()
    func replace() { lock.lock(); defer { lock.unlock() }; value = UUID() }
    func capture() -> UUID { lock.lock(); defer { lock.unlock() }; return value }
    func matches(_ expected: UUID) -> Bool { lock.lock(); defer { lock.unlock() }; return value == expected }
}
