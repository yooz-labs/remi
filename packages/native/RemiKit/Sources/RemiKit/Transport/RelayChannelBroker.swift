import Foundation

/// Shared across Store lifetimes. Synchronous reservations retain retirement
/// tasks before foreground dictionaries disappear; awaits never leave a room free.
final class RelayChannelBroker: @unchecked Sendable {
    static let shared = RelayChannelBroker()
    struct Lease: Sendable {
        let key: String
        let id: UUID
        let retired: Task<Void, Never>
        let resume: (@Sendable () async -> Void)?
    }
    private struct Entry {
        let id: UUID
        let oneShot: Bool
        let connection: RemiConnection?
        let closing: Task<Void, Never>?
        let resume: (@Sendable () async -> Void)?
    }
    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    static func key(device: Data, room: Data) -> String { RelayCrypto.hex(device) + ":" + RelayCrypto.hex(room) }
    private func retirement(_ prior: Entry?) -> Task<Void, Never> {
        Task { await prior?.closing?.value; await prior?.connection?.stop() }
    }
    func adopt(key: String, id: UUID, connection: RemiConnection,
               current: @escaping @Sendable () async -> Bool,
               resume: @escaping @Sendable () async -> Void) -> Task<Void, Never>? {
        lock.lock(); defer { lock.unlock() }
        let prior = entries[key]
        guard prior?.oneShot != true else { return nil }
        let closing = retirement(prior)
        entries[key] = .init(id: id, oneShot: false, connection: connection, closing: closing, resume: resume)
        return Task {
            await closing.value
            guard await current(), self.matches(key, id: id) else { await connection.stop(); return }
            await connection.start()
        }
    }
    func retire(key: String, id: UUID) {
        lock.lock(); defer { lock.unlock() }
        guard let prior = entries[key], prior.id == id, !prior.oneShot else { return }
        let closing = retirement(prior)
        entries[key] = .init(id: UUID(), oneShot: false, connection: nil, closing: closing, resume: nil)
    }
    func claim(key: String) -> Lease? {
        lock.lock(); defer { lock.unlock() }
        let prior = entries[key]
        guard prior?.oneShot != true else { return nil }
        let id = UUID(), retired = retirement(prior)
        entries[key] = .init(id: id, oneShot: true, connection: nil, closing: retired, resume: nil)
        return .init(key: key, id: id, retired: retired, resume: prior?.resume)
    }
    func release(_ lease: Lease) {
        lock.lock()
        guard entries[lease.key]?.id == lease.id else { lock.unlock(); return }
        entries.removeValue(forKey: lease.key); lock.unlock()
        if let resume = lease.resume { Task { await resume() } }
    }
    private func matches(_ key: String, id: UUID) -> Bool {
        lock.lock(); defer { lock.unlock() }; return entries[key]?.id == id
    }
}
