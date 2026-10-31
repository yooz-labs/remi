import Foundation
import Testing
import UserNotifications
@testable import RemiKit

@MainActor private final class OwnedInventoryBoundary {
    var pending: (@Sendable (LocalNoticeInventory.Batch) -> Void)?
    var delivered: (@Sendable (LocalNoticeInventory.Batch) -> Void)?
    var pendingBudget: LocalNoticeInventoryBudget?
    var deliveredBudget: LocalNoticeInventoryBudget?
    var boundary: LocalNoticeInventory.Boundary {
        .init(pending: { [self] budget, callback in pendingBudget = budget; pending = callback },
              delivered: { [self] budget, callback in deliveredBudget = budget; delivered = callback })
    }
    func sendPending(_ requests: [UNNotificationRequest]) throws {
        do {
            let records = try LocalNoticeInventoryProjection.make(requests, dates: Array(repeating: nil, count: requests.count),
                                                                   budget: try #require(pendingBudget))
            pending?(.pending(records))
        } catch let error as LocalNoticeError { pending?(.failure(error)) }
    }
    func sendDelivered(_ requests: [UNNotificationRequest], dates: [Date?]) throws {
        do {
            let records = try LocalNoticeInventoryProjection.make(requests, dates: dates, budget: try #require(deliveredBudget))
            delivered?(.delivered(records))
        } catch let error as LocalNoticeError { delivered?(.failure(error)) }
    }
}
private enum InventoryTimeout: Error { case deadline }

/// Synthetic scheduling gate owns only a flag and semaphore, never notification objects.
private final class OwnedInventoryChunkGate: @unchecked Sendable {
    private let lock = NSLock(), semaphore = DispatchSemaphore(value: 0)
    private var enteredValue = false, releasedValue = false, finishedValue = false
    var entered: Bool { lock.lock(); defer { lock.unlock() }; return enteredValue }
    var released: Bool { lock.lock(); defer { lock.unlock() }; return releasedValue }
    var finished: Bool { lock.lock(); defer { lock.unlock() }; return finishedValue }
    func holdOnce() {
        lock.lock()
        guard !enteredValue else { lock.unlock(); return }
        enteredValue = true; lock.unlock()
        _ = semaphore.wait(timeout: .now() + 2)
    }
    func release() {
        lock.lock(); releasedValue = true; lock.unlock(); semaphore.signal()
    }
    func finish() { lock.lock(); finishedValue = true; lock.unlock() }
}

private final class OwnedBudgetOutcomes: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func set(_ name: String, _ result: String) { lock.lock(); values[name] = result; lock.unlock() }
    func get(_ name: String) -> String? { lock.lock(); defer { lock.unlock() }; return values[name] }
}

@Suite(.serialized) @MainActor struct LocalNoticeInventoryTests {
    private func until(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !condition() {
            guard ContinuousClock.now < deadline else { throw InventoryTimeout.deadline }
            try await Task.sleep(for: .milliseconds(5))
        }
    }
    private func request(_ identifier: String, body: String = "Synthetic") -> UNNotificationRequest {
        let content = UNMutableNotificationContent(); content.body = body
        return UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
    }

    @Test func returnsOnlyAfterBothCompleteInventories() async throws {
        let os = OwnedInventoryBoundary(), reader = LocalNoticeInventory(boundary: os.boundary, timeout: .seconds(1))
        let result = Task { try await reader.read() }
        try await until { os.pending != nil && os.delivered != nil }
        try os.sendPending([request("pending")])
        let date = Date(timeIntervalSince1970: 10)
        try os.sendDelivered([request("delivered")], dates: [date])
        let entries = try await result.value.entries
        #expect(entries.map(\.identifier) == ["pending", "delivered"])
        #expect(entries.first?.deliveredAt == nil)
        #expect(entries.last?.deliveredAt == date)
    }

    @Test func timeoutIsUnavailableAndLateCallbacksCannotContaminateNextScan() async throws {
        let os = OwnedInventoryBoundary(), reader = LocalNoticeInventory(boundary: os.boundary, timeout: .milliseconds(30))
        let first = Task { try await reader.read() }
        try await until { os.pending != nil && os.delivered != nil }
        let oldPending = try #require(os.pending), oldDelivered = try #require(os.delivered)
        do { _ = try await first.value; Issue.record("A stalled scan cannot become empty") }
        catch let error as LocalNoticeError { #expect(error == .unavailable) }
        os.pending = nil; os.delivered = nil
        let second = Task { try await reader.read() }
        try await until { os.pending != nil && os.delivered != nil }
        // Old callbacks carry the old token and cannot satisfy the new operation.
        let old = try LocalNoticeInventoryProjection.make([request("old")], dates: [nil], budget: LocalNoticeInventoryBudget())
        oldPending(.pending(old))
        oldDelivered(.delivered([]))
        try os.sendPending([request("new")]); try os.sendDelivered([], dates: [])
        let entries = try await second.value.entries
        #expect(entries.map(\.identifier) == ["new"])
    }

    @Test func overBudgetAndWrongCallbackTypeNeverBecomeEmptyInventory() async throws {
        let os = OwnedInventoryBoundary(), reader = LocalNoticeInventory(boundary: os.boundary, timeout: .seconds(1))
        let first = Task { try await reader.read() }
        try await until { os.pending != nil && os.delivered != nil }
        try os.sendPending([request("big", body: String(repeating: "x", count: LocalNoticeReconciler.maximumMetadataBytes + 1))])
        try os.sendDelivered([], dates: [])
        do { _ = try await first.value; Issue.record("Oversized inventory cannot be accepted") }
        catch let error as LocalNoticeError { #expect(error == .capacity) }
        os.pending = nil; os.delivered = nil
        let second = Task { try await reader.read() }
        try await until { os.pending != nil && os.delivered != nil }
        os.pending?(.delivered([]))
        do { _ = try await second.value; Issue.record("Wrong OS callback cannot become empty inventory") }
        catch let error as LocalNoticeError { #expect(error == .unavailable) }
    }

    @Test func concurrentReadIsBusyAndCancellationReleasesTheSingleFlight() async throws {
        let os = OwnedInventoryBoundary(), reader = LocalNoticeInventory(boundary: os.boundary, timeout: .seconds(1))
        let first = Task { try await reader.read() }
        try await until { os.pending != nil && os.delivered != nil }
        do { _ = try await reader.read(); Issue.record("A concurrent scan must not replace the active scan") }
        catch let error as LocalNoticeError { #expect(error == .busy) }
        let oldPending = try #require(os.pending), oldDelivered = try #require(os.delivered)
        first.cancel()
        do { _ = try await first.value; Issue.record("Cancelled inventory must not succeed") }
        catch is CancellationError { }
        os.pending = nil; os.delivered = nil
        let second = Task { try await reader.read() }
        try await until { os.pending != nil && os.delivered != nil }
        let old = try LocalNoticeInventoryProjection.make([request("old")], dates: [nil], budget: LocalNoticeInventoryBudget())
        oldPending(.pending(old))
        oldDelivered(.delivered([]))
        os.pending?(.pending([])); os.delivered?(.delivered([]))
        #expect(try await second.value.entries.isEmpty)
    }

    @Test func bothHalvesShareOneMetadataBudget() async throws {
        let os = OwnedInventoryBoundary(), reader = LocalNoticeInventory(boundary: os.boundary, timeout: .seconds(1))
        let result = Task { try await reader.read() }
        try await until { os.pending != nil && os.delivered != nil }
        let portion = String(repeating: "x", count: LocalNoticeReconciler.maximumMetadataBytes / 2 + 1)
        try os.sendPending([request("first", body: portion)])
        try os.sendDelivered([request("second", body: portion)], dates: [nil])
        do { _ = try await result.value; Issue.record("Combined metadata cannot exceed the shared budget") }
        catch let error as LocalNoticeError { #expect(error == .capacity) }
    }

    @Test func bothHalvesShareOneRequestCountBudget() async throws {
        let os = OwnedInventoryBoundary(), reader = LocalNoticeInventory(boundary: os.boundary, timeout: .seconds(1))
        let result = Task { try await reader.read() }
        try await until { os.pending != nil && os.delivered != nil }
        let one = request("synthetic"), count = LocalNoticeReconciler.maximumRequests / 2 + 1
        try os.sendPending(Array(repeating: one, count: count))
        try os.sendDelivered(Array(repeating: one, count: count), dates: Array(repeating: nil, count: count))
        do { _ = try await result.value; Issue.record("Combined request count cannot exceed the shared budget") }
        catch let error as LocalNoticeError { #expect(error == .capacity) }
    }

    @Test func projectionContainsIndependentValuesAndProtectsSecureCategories() throws {
        let keys = try LocalNoticeKeys(root: Data(repeating: 47, count: 32))
        let owner = try keys.ownerIndex(runtimeOwner: UUID())
        let question = try keys.questionIndex(owner: owner, sessionID: "synthetic", questionID: "q")
        let marker = try keys.marker(requestID: UUID().uuidString.lowercased(), owner: owner, sequence: 1, question: question)
        let content = UNMutableNotificationContent()
        content.title = "Original"; content.body = "Synthetic"
        content.categoryIdentifier = "remi.secure.v2.synthetic"
        content.userInfo = try marker.userInfo()
        let request = UNNotificationRequest(identifier: marker.systemIdentifier, content: content, trigger: nil)
        let records = try LocalNoticeInventoryProjection.make([request], dates: [nil], budget: LocalNoticeInventoryBudget())
        let record = try #require(records.first)
        content.title = "Changed"; content.userInfo = [:]
        #expect(record.title == "Original"); #expect(record.marker == marker); #expect(record.protected)
    }

    @Test func emptyMetadataElementsStillConsumeTheSharedWorkBudget() throws {
        let content = UNMutableNotificationContent()
        content.userInfo = ["values": Array(repeating: "", count: 2_048)]
        let request = UNNotificationRequest(identifier: "synthetic", content: content, trigger: nil)
        let requests = Array(repeating: request, count: 150)
        #expect(throws: LocalNoticeError.capacity) {
            try LocalNoticeInventoryProjection.make(requests, dates: Array(repeating: nil, count: requests.count),
                                                     budget: LocalNoticeInventoryBudget())
        }
    }

    @Test func heldCallbackChunkDoesNotBlockTimeoutOrGrantLateAuthority() async throws {
        let gate = OwnedInventoryChunkGate()
        let boundary = LocalNoticeInventory.Boundary(pending: { budget, completion in
            budget.installOwnedChunkHook { gate.holdOnce() }
            DispatchQueue.global().async {
                defer { gate.finish() }
                let content = UNMutableNotificationContent(); content.body = String(repeating: "x", count: 8_192)
                let request = UNNotificationRequest(identifier: "synthetic-held", content: content, trigger: nil)
                do { completion(.pending(try LocalNoticeInventoryProjection.make([request], dates: [nil], budget: budget))) }
                catch let error as LocalNoticeError { completion(.failure(error)) }
                catch { completion(.failure(.unavailable)) }
            }
        }, delivered: { _, completion in completion(.delivered([])) })
        let reader = LocalNoticeInventory(boundary: boundary, timeout: .milliseconds(50))
        let result = Task { try await reader.read() }
        // Bound the synthetic worker even if a regression blocks MainActor's timeout path.
        let fallback = DispatchWorkItem(block: { @Sendable in gate.release() })
        DispatchQueue.global().asyncAfter(deadline: .now() + 1, execute: fallback)
        try await until { gate.entered }
        do { _ = try await result.value; Issue.record("A held half cannot become a complete inventory") }
        catch let error as LocalNoticeError { #expect(error == .unavailable) }
        #expect(!gate.released, "Timeout must not wait for the held callback traversal")
        gate.release(); fallback.cancel()
        try await until { gate.finished }
    }

    @Test func ownedFallbackCanRunOutsideMainActor() async throws {
        let gate = OwnedInventoryChunkGate()
        let fallback = DispatchWorkItem(block: { @Sendable in gate.release() })
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(20), execute: fallback)
        try await until { gate.released }
    }

    @Test func concurrentCallbackWaitsForUnusedChunkRefundWithoutFalseOverflow() async throws {
        let budget = LocalNoticeInventoryBudget(), gate = OwnedInventoryChunkGate(), outcomes = OwnedBudgetOutcomes()
        budget.installOwnedChunkHook { gate.holdOnce() }
        DispatchQueue.global().async {
            do { _ = try budget.chargeString("x"); outcomes.set("first", "ok") }
            catch { outcomes.set("first", "failed") }
        }
        try await until { gate.entered }
        DispatchQueue.global().async {
            outcomes.set("second", "started")
            do { try budget.charge(LocalNoticeInventoryLimits.maximumMetadataBytes - 1); outcomes.set("second", "ok") }
            catch { outcomes.set("second", "failed") }
        }
        try await until { outcomes.get("second") != nil && budget.ownedCounters().waiting > 0 }
        gate.release()
        try await until { outcomes.get("first") != nil && outcomes.get("second") != "started" }
        #expect(outcomes.get("first") == "ok"); #expect(outcomes.get("second") == "ok")
        let counters = budget.ownedCounters()
        #expect(counters.remaining == 0 && counters.reserved == 0 && counters.waiting == 0)
    }

    @Test func invalidationWakesCallbackWaitingForReservedBudget() async throws {
        let budget = LocalNoticeInventoryBudget(), gate = OwnedInventoryChunkGate(), outcomes = OwnedBudgetOutcomes()
        budget.installOwnedChunkHook { gate.holdOnce() }
        DispatchQueue.global().async {
            do { _ = try budget.chargeString("x"); outcomes.set("first", "unexpected") }
            catch { outcomes.set("first", "stopped") }
        }
        try await until { gate.entered }
        DispatchQueue.global().async {
            outcomes.set("second", "started")
            do { try budget.charge(LocalNoticeInventoryLimits.maximumMetadataBytes); outcomes.set("second", "unexpected") }
            catch { outcomes.set("second", "stopped") }
        }
        try await until { outcomes.get("second") != nil && budget.ownedCounters().waiting > 0 }
        budget.invalidate()
        try await until { outcomes.get("second") == "stopped" }
        gate.release()
        try await until { outcomes.get("first") == "stopped" }
        let counters = budget.ownedCounters()
        #expect(counters.remaining >= 0 && counters.reserved == 0 && counters.waiting == 0)
    }
}
