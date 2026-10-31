import Foundation
import Testing
import UserNotifications
@testable import RemiKit

@MainActor private final class OwnedOwnerInventory {
    var entries: [LocalNoticeInventoryRecord] = []
    var hold = false
    var pending: (@Sendable (LocalNoticeInventory.Batch) -> Void)?
    var delivered: (@Sendable (LocalNoticeInventory.Batch) -> Void)?
    var boundary: LocalNoticeInventory.Boundary {
        .init(pending: { [self] _, callback in
            if hold { pending = callback } else { callback(.pending(entries)) }
        }, delivered: { [self] _, callback in
            if hold { delivered = callback } else { callback(.delivered([])) }
        })
    }
    func release() { pending?(.pending(entries)); delivered?(.delivered([])); pending = nil; delivered = nil }
}

@Suite(.serialized) @MainActor struct NativeLocalNotificationOwnerTests {
    private func fixture(uncertain: Bool = false) async throws -> (URL, String, UserDefaults, OwnedStartupKeychain,
        OwnedOwnerInventory, LocalNoticeInventoryRecord, NativeLocalNotificationOwner, () -> [[String]]) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("remi-local-owner-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let name = "live.yooz.remi.tests.local-owner." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name)), keychain = OwnedStartupKeychain()
        let os = OwnedOwnerInventory(), sentinel = LocalNoticeSentinel(defaults: defaults, domainName: name)
        var removals: [[String]] = []
        let boundary = LocalNoticeBoundary(authorized: { true }, identifierAvailable: { _ in true }, add: { _ in Issue.record("Review owner cannot schedule") },
                                           remove: { removals.append($0) })
        let reader = LocalNoticeInventory(boundary: os.boundary)
        let ready = try await LocalNoticeStartup.open(directory: directory, sentinel: sentinel,
            keyStore: .init(service: "synthetic", account: "owner"), operations: keychain.operations,
            inventory: reader, protectedDataAvailable: { true }, notificationBoundary: boundary)
        let keys = try LocalNoticeKeys(root: try #require(keychain.stored))
        let owner = try keys.ownerIndex(runtimeOwner: UUID())
        let question = try keys.questionIndex(owner: owner, sessionID: "synthetic", questionID: "q")
        try ready.ledger.createOwner(owner)
        let ticket = try ready.ledger.prepare(owner: owner, question: question)
        try ready.ledger.beginAdd(ticket)
        if !uncertain { try ready.ledger.settle(ticket, succeeded: true) }
        let marker = try keys.marker(requestID: ticket.requestID, owner: owner, sequence: ticket.sequence, question: question)
        ready.ledger.close()
        let content = UNMutableNotificationContent(); content.title = "Synthetic"; content.body = "Synthetic request"
        content.userInfo = try marker.userInfo()
        let request = UNNotificationRequest(identifier: marker.systemIdentifier, content: content, trigger: nil)
        let records = try LocalNoticeInventoryProjection.make([request], dates: [nil], budget: LocalNoticeInventoryBudget())
        let record = try #require(records.first)
        os.entries = [record]
        let manager = NativeLocalNotificationOwner(directory: directory, sentinel: sentinel,
            keyStore: .init(service: "synthetic", account: "owner"), operations: keychain.operations,
            inventory: reader, protectedDataAvailable: { true }, notificationBoundary: boundary)
        return (directory, name, defaults, keychain, os, record, manager, { removals })
    }

    @Test func reviewAndConfirmationAreSeparateAndTargetOnlySelectedAlert() async throws {
        let (dir, name, defaults, _, _, record, owner, removals) = try await fixture()
        defer { owner.stop(); defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        await owner.start()
        #expect(owner.phase == .reviewOnly)
        let alerts = try await owner.reviewEarlierAlerts()
        let alert = try #require(alerts.first)
        #expect(alerts.count == 1); #expect(alert.title == "Synthetic"); #expect(removals().isEmpty)
        let confirmation = try #require(owner.prepareAlertConfirmation(alert.id))
        #expect(removals().isEmpty)
        #expect(await owner.confirmAlert(confirmation) == .completed)
        #expect(removals() == [[record.identifier]])
        #expect(await owner.confirmAlert(confirmation) == .changed)
    }

    @Test func stoppingDuringRevalidationRevokesTheConfirmation() async throws {
        let (dir, name, defaults, _, os, _, owner, removals) = try await fixture()
        defer { owner.stop(); defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        await owner.start()
        let alerts = try await owner.reviewEarlierAlerts(), alert = try #require(alerts.first)
        let confirmation = try #require(owner.prepareAlertConfirmation(alert.id))
        os.hold = true
        let action = Task { await owner.confirmAlert(confirmation) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while os.pending == nil || os.delivered == nil {
            guard ContinuousClock.now < deadline else { throw LocalNoticeError.unavailable }
            try await Task.sleep(for: .milliseconds(5))
        }
        owner.stop(); os.release()
        #expect(await action.value == .changed)
        #expect(removals().isEmpty)
    }

    @Test func changedAlertCannotBeRemovedByAnEarlierConfirmation() async throws {
        let (dir, name, defaults, _, os, record, owner, removals) = try await fixture()
        defer { owner.stop(); defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        await owner.start()
        let alerts = try await owner.reviewEarlierAlerts(), alert = try #require(alerts.first)
        let confirmation = try #require(owner.prepareAlertConfirmation(alert.id))
        os.entries = [LocalNoticeInventoryRecord(identifier: record.identifier, title: "Changed synthetic title",
            subtitle: record.subtitle, body: record.body, deliveredAt: record.deliveredAt,
            protected: record.protected, marker: record.marker, metadataBytes: record.metadataBytes)]
        #expect(await owner.confirmAlert(confirmation) == .changed)
        #expect(removals().isEmpty)
    }

    @Test func unseenUncertainDebtNeedsASeparateConfirmationAndDoesNotRemove() async throws {
        let (dir, name, defaults, _, os, _, owner, removals) = try await fixture(uncertain: true)
        defer { owner.stop(); defaults.removePersistentDomain(forName: name); try? FileManager.default.removeItem(at: dir) }
        await owner.start()
        let debts = try owner.reviewUnassignedDebt(), debt = try #require(debts.first)
        #expect(debts.count == 1); #expect(debt.identifierSuffix.count >= 8)
        let confirmation = try #require(owner.prepareDebtConfirmation(debt.id))
        #expect(removals().isEmpty)
        os.entries = []
        #expect(await owner.confirmAbandoningDebt(confirmation) == .completed)
        #expect(removals().isEmpty)
        #expect(await owner.confirmAbandoningDebt(confirmation) == .changed)
    }
}
