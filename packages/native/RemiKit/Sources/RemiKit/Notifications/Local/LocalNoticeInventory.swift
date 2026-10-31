import Foundation
import RemiPush
import UserNotifications

enum LocalNoticeInventoryLimits {
    static let maximumRequests = 4_096
    static let maximumMetadataBytes = 2 * 1_024 * 1_024
}

/// An immutable, value-only copy made synchronously inside an OS callback. It contains no
/// UNNotification, UNNotificationRequest or mutable userInfo object and is never persisted.
struct LocalNoticeInventoryRecord: Sendable, Equatable {
    let identifier: String
    let title: String
    let subtitle: String
    let body: String
    let deliveredAt: Date?
    let protected: Bool
    let marker: LocalNoticeMarker?
    let metadataBytes: Int
}

/// Only scalar counters and validity cross callback threads in production. The condition protects
/// all state; no notification object, payload, continuation or actor-owned reference is stored.
final class LocalNoticeInventoryBudget: @unchecked Sendable {
    private let condition = NSCondition()
    private var remainingEntries = LocalNoticeInventoryLimits.maximumRequests
    private var remainingBytes = LocalNoticeInventoryLimits.maximumMetadataBytes
    private var reservedBytes = 0
    private var failure: LocalNoticeError?
    private static let chunkSize = 4_096
    #if DEBUG
    /// Synthetic test seam. Read under the lock and invoked only after releasing it.
    private var ownedAfterChunkReservation: (@Sendable () -> Void)?
    func installOwnedChunkHook(_ hook: @escaping @Sendable () -> Void) {
        condition.lock(); defer { condition.unlock() }
        ownedAfterChunkReservation = hook
    }
    private func callOwnedChunkHook() {
        condition.lock(); let hook = ownedAfterChunkReservation; condition.unlock()
        hook?()
    }
    #endif

    func reserve(_ count: Int) throws {
        condition.lock(); defer { condition.unlock() }
        if let failure { throw failure }
        guard count >= 0, count <= remainingEntries else { fail(.capacity); throw LocalNoticeError.capacity }
        remainingEntries -= count
    }
    func charge(_ count: Int) throws {
        condition.lock(); defer { condition.unlock() }
        guard count >= 0, count <= LocalNoticeInventoryLimits.maximumMetadataBytes else { fail(.capacity); throw LocalNoticeError.capacity }
        while failure == nil && count > remainingBytes && reservedBytes > 0 { condition.wait() }
        if let failure { throw failure }
        guard count <= remainingBytes else { fail(.capacity); throw LocalNoticeError.capacity }
        remainingBytes -= count
    }

    /// Reserve a bounded chunk under the short scalar lock, inspect outside it, then refund the
    /// unused reservation. Other callback threads can wait for refunds; timeout/cancel wakes them.
    func chargeString(_ value: String, minimum: Int = 0) throws -> Int {
        let bytes = value.utf8
        var cursor = bytes.startIndex, total = 0
        while cursor != bytes.endIndex {
            let reservation = try reserveChunk()
            #if DEBUG
            callOwnedChunkHook()
            #endif
            let end = bytes.index(cursor, offsetBy: reservation, limitedBy: bytes.endIndex) ?? bytes.endIndex
            let used = bytes.distance(from: cursor, to: end)
            try settleChunk(reservation, used: used)
            total += used; cursor = end
        }
        if total < minimum { try charge(minimum - total); total = minimum }
        return total
    }
    private func reserveChunk() throws -> Int {
        condition.lock(); defer { condition.unlock() }
        while failure == nil && remainingBytes == 0 && reservedBytes > 0 { condition.wait() }
        if let failure { throw failure }
        guard remainingBytes > 0 else { fail(.capacity); throw LocalNoticeError.capacity }
        let amount = min(Self.chunkSize, remainingBytes)
        remainingBytes -= amount; reservedBytes += amount
        return amount
    }
    private func settleChunk(_ amount: Int, used: Int) throws {
        condition.lock(); defer { condition.unlock() }
        guard amount > 0, used >= 0, used <= amount, amount <= reservedBytes else {
            fail(.invalid); throw LocalNoticeError.invalid
        }
        reservedBytes -= amount; remainingBytes += amount - used
        condition.broadcast()
        if let failure { throw failure }
    }
    func check() throws {
        condition.lock(); defer { condition.unlock() }
        if let failure { throw failure }
    }
    func invalidate() {
        condition.lock(); defer { condition.unlock() }
        fail(.unavailable)
    }
    private func fail(_ error: LocalNoticeError) {
        if failure == nil { failure = error }
        condition.broadcast()
    }
}

/// Called only while the platform callback owns its raw request. It checks the shared budget
/// before copying data and returns independent Swift values; the raw request never escapes.
enum LocalNoticeInventoryProjection {
    static func make(_ requests: [UNNotificationRequest], dates: [Date?],
                     budget: LocalNoticeInventoryBudget) throws -> [LocalNoticeInventoryRecord] {
        guard requests.count == dates.count else { throw LocalNoticeError.invalid }
        try budget.reserve(requests.count)
        var result: [LocalNoticeInventoryRecord] = []
        for (request, date) in zip(requests, dates) {
            let content = request.content
            var metadataBytes = 0
            for value in [request.identifier, content.title, content.subtitle, content.body,
                          content.categoryIdentifier, content.threadIdentifier] {
                metadataBytes += try budget.chargeString(value)
            }
            metadataBytes += try consume(content.userInfo, budget: budget)
            // Re-encode to independent UTF-8-backed values before leaving this callback.
            func copy(_ value: String) -> String { String(decoding: value.utf8, as: UTF8.self) }
            result.append(LocalNoticeInventoryRecord(identifier: copy(request.identifier), title: copy(content.title),
                subtitle: copy(content.subtitle), body: copy(content.body), deliveredAt: date,
                protected: request.trigger != nil || RemiPushStore.isSecureNotification(content: content),
                marker: try? LocalNoticeMarker.parse(userInfo: content.userInfo), metadataBytes: metadataBytes))
        }
        try budget.check()
        return result
    }

    private static func consume(_ root: Any, budget: LocalNoticeInventoryBudget) throws -> Int {
        var stack: [Any] = [root], nodes = 0, total = 0
        while let value = stack.popLast() {
            nodes += 1
            guard nodes <= 16_384 else { throw LocalNoticeError.capacity }
            let size: Int
            switch value {
            case let value as String:
                total += try budget.chargeString(value, minimum: 8)
                continue
            case let value as Data: size = value.count
            case is NSNumber, is Date, is NSNull: size = 16
            case let value as [Any]:
                guard value.count <= 16_384 - nodes else { throw LocalNoticeError.capacity }
                stack.append(contentsOf: value); size = 16
            case let value as [AnyHashable: Any]:
                guard value.count <= (16_384 - nodes) / 2 else { throw LocalNoticeError.capacity }
                for (key, item) in value { stack.append(key.base); stack.append(item) }
                size = 16
            default: throw LocalNoticeError.invalid
            }
            // Empty values still cost work and object traversal; otherwise many zero-byte
            // elements could bypass the shared processing budget.
            let charged = max(size, 8)
            try budget.charge(charged); total += charged
        }
        return total
    }
}

/// One bounded scan of both OS inventories. Timeout or a failed half is unavailable, never an
/// empty inventory. OS objects remain inside their callback; only immutable values cross actors.
@MainActor final class LocalNoticeInventory {
    enum Batch: Sendable {
        case pending([LocalNoticeInventoryRecord])
        case delivered([LocalNoticeInventoryRecord])
        case failure(LocalNoticeError)
    }
    struct Boundary {
        let pending: (LocalNoticeInventoryBudget, @escaping @Sendable (Batch) -> Void) -> Void
        let delivered: (LocalNoticeInventoryBudget, @escaping @Sendable (Batch) -> Void) -> Void
        static var system: Self {
            .init(pending: { budget, completion in
                UNUserNotificationCenter.current().getPendingNotificationRequests { requests in
                    guard requests.count <= LocalNoticeInventoryLimits.maximumRequests else { completion(.failure(.capacity)); return }
                    do {
                        let dates = Array<Date?>(repeating: nil, count: requests.count)
                        completion(.pending(try LocalNoticeInventoryProjection.make(requests, dates: dates, budget: budget)))
                    } catch let error as LocalNoticeError { completion(.failure(error)) }
                    catch { completion(.failure(.unavailable)) }
                }
            }, delivered: { budget, completion in
                UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
                    guard notifications.count <= LocalNoticeInventoryLimits.maximumRequests else { completion(.failure(.capacity)); return }
                    do {
                        let requests = notifications.map(\.request), dates = notifications.map { Optional($0.date) }
                        completion(.delivered(try LocalNoticeInventoryProjection.make(requests, dates: dates, budget: budget)))
                    } catch let error as LocalNoticeError { completion(.failure(error)) }
                    catch { completion(.failure(.unavailable)) }
                }
            })
        }
    }
    struct Snapshot: Sendable { let entries: [LocalNoticeInventoryRecord] }
    private struct Operation {
        let id: UUID
        let continuation: CheckedContinuation<Snapshot, any Error>
        let deadline: Task<Void, Never>
        let budget: LocalNoticeInventoryBudget
        var pending: [LocalNoticeInventoryRecord]?
        var delivered: [LocalNoticeInventoryRecord]?
    }
    private let boundary: Boundary
    private let timeout: Duration
    private var operation: Operation?

    init(boundary: Boundary = .system, timeout: Duration = .seconds(2)) {
        self.boundary = boundary; self.timeout = timeout
    }

    func read() async throws -> Snapshot {
        guard operation == nil else { throw LocalNoticeError.busy }
        let id = UUID(), delay = timeout, budget = LocalNoticeInventoryBudget()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled else { continuation.resume(throwing: CancellationError()); return }
                let deadline = Task { [weak self] in
                    do { try await Task.sleep(for: delay) } catch { return }
                    self?.finish(id, result: .failure(LocalNoticeError.unavailable))
                }
                operation = Operation(id: id, continuation: continuation, deadline: deadline, budget: budget)
                boundary.pending(budget) { [weak self] batch in
                    Task { @MainActor [weak self] in self?.accept(batch, expectedPending: true, id: id) }
                }
                boundary.delivered(budget) { [weak self] batch in
                    Task { @MainActor [weak self] in self?.accept(batch, expectedPending: false, id: id) }
                }
            }
        } onCancel: { [weak self] in
            Task { @MainActor [weak self] in self?.finish(id, result: .failure(CancellationError())) }
        }
    }

    private func accept(_ batch: Batch, expectedPending: Bool, id: UUID) {
        guard var current = operation, current.id == id else { return }
        switch (expectedPending, batch) {
        case (_, .failure(let error)): finish(id, result: .failure(error)); return
        case (true, .pending(let pending)) where current.pending == nil: current.pending = pending
        case (false, .delivered(let delivered)) where current.delivered == nil: current.delivered = delivered
        default: finish(id, result: .failure(LocalNoticeError.unavailable)); return
        }
        operation = current
        guard let pending = current.pending, let delivered = current.delivered else { return }
        finish(id, result: .success(Snapshot(entries: pending + delivered)))
    }

    private func finish(_ id: UUID, result: Result<Snapshot, any Error>) {
        guard let current = operation, current.id == id else { return }
        operation = nil
        current.budget.invalidate()
        current.deadline.cancel()
        current.continuation.resume(with: result)
    }
}
