import Foundation
import Testing
import UserNotifications
@testable import RemiKit

@MainActor private final class OwnedInventoryBoundary {
    var pending: (@Sendable (LocalNoticeInventory.Batch) -> Void)?
    var delivered: (@Sendable (LocalNoticeInventory.Batch) -> Void)?
    var boundary: LocalNoticeInventory.Boundary {
        .init(pending: { [self] in pending = $0 }, delivered: { [self] in delivered = $0 })
    }
}
private enum InventoryTimeout: Error { case deadline }

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
        os.pending?(.pending([request("pending")]))
        os.delivered?(.delivered([]))
        let entries = try await result.value
        #expect(entries.map { $0.request.identifier } == ["pending"])
        #expect(entries.first?.deliveredAt == nil)
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
        oldPending(.pending([request("old")]))
        oldDelivered(.delivered([]))
        os.pending?(.pending([request("new")]))
        os.delivered?(.delivered([]))
        let entries = try await second.value
        #expect(entries.map { $0.request.identifier } == ["new"])
    }

    @Test func overBudgetAndWrongCallbackTypeNeverBecomeEmptyInventory() async throws {
        let os = OwnedInventoryBoundary(), reader = LocalNoticeInventory(boundary: os.boundary, timeout: .seconds(1))
        let first = Task { try await reader.read() }
        try await until { os.pending != nil && os.delivered != nil }
        os.pending?(.pending([request("big", body: String(repeating: "x", count: LocalNoticeReconciler.maximumMetadataBytes + 1))]))
        os.delivered?(.delivered([]))
        do { _ = try await first.value; Issue.record("Oversized inventory cannot be accepted") }
        catch let error as LocalNoticeError { #expect(error == .capacity) }
        os.pending = nil; os.delivered = nil
        let second = Task { try await reader.read() }
        try await until { os.pending != nil && os.delivered != nil }
        os.pending?(.delivered([]))
        do { _ = try await second.value; Issue.record("Wrong OS callback cannot become empty inventory") }
        catch let error as LocalNoticeError { #expect(error == .unavailable) }
    }
}
