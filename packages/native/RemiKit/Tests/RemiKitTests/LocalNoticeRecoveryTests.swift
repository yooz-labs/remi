import Foundation
import Testing
import UserNotifications
@testable import RemiKit

@Suite(.serialized) @MainActor struct LocalNoticeRecoveryTests {
    private func request(_ marker: LocalNoticeMarker, title: String = "Synthetic", secure: Bool = false) throws -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = title; content.body = "Synthetic local request"
        if secure { content.categoryIdentifier = "remi.secure.v2.synthetic" }
        content.userInfo = try marker.userInfo()
        return UNNotificationRequest(identifier: marker.systemIdentifier, content: content, trigger: nil)
    }
    private func create(_ ledger: LocalNoticeLedger, owner: Data, question: Data,
                        keys: LocalNoticeKeys, settle: Bool) throws -> (LocalNoticeLedger.Ticket, LocalNoticeMarker) {
        try ledger.createOwner(owner)
        let ticket = try ledger.prepare(owner: owner, question: question)
        try ledger.beginAdd(ticket)
        if settle { try ledger.settle(ticket, succeeded: true) }
        return (ticket, try keys.marker(requestID: ticket.requestID, owner: owner,
                                       sequence: ticket.sequence, question: question))
    }
    private func setup() throws -> (URL, LocalNoticeKeys, LocalNoticeLedger,
                                     LocalNoticeLedger.Ticket, LocalNoticeMarker,
                                     LocalNoticeLedger.Ticket, LocalNoticeMarker) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("remi-local-review-\(UUID())")
        let keys = try LocalNoticeKeys(root: Data(repeating: 43, count: 32))
        let first = try keys.ownerIndex(runtimeOwner: UUID()), second = try keys.ownerIndex(runtimeOwner: UUID())
        let q1 = try keys.questionIndex(owner: first, sessionID: "same", questionID: "same")
        let q2 = try keys.questionIndex(owner: second, sessionID: "same", questionID: "same")
        let original = try LocalNoticeLedger(directory: dir)
        let (one, markerOne) = try create(original, owner: first, question: q1, keys: keys, settle: true)
        let (two, markerTwo) = try create(original, owner: second, question: q2, keys: keys, settle: false)
        original.close()
        return (dir, keys, try LocalNoticeLedger(directory: dir), one, markerOne, two, markerTwo)
    }

    @Test func reviewWithoutConfirmationChangesNothing() throws {
        let (dir, keys, ledger, one, markerOne, two, markerTwo) = try setup()
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        var removed: [[String]] = []
        let recovery = LocalNoticeRecovery(ledger: ledger, keys: keys) { removed.append($0) }
        let entries: [LocalNoticeRecovery.Entry] = [
            .init(request: try request(markerOne), deliveredAt: Date(timeIntervalSince1970: 10)),
            .init(request: try request(markerTwo), deliveredAt: nil),
        ]
        let candidates = try recovery.review(entries)
        #expect(candidates.count == 2); #expect(removed.isEmpty)
        #expect(try ledger.record(one).activity == .active)
        #expect(try ledger.record(two).activity == .active)
    }

    @Test func exactHistoricalSelectionCannotTouchAnotherOrSecureCollision() throws {
        let (dir, keys, ledger, one, markerOne, two, markerTwo) = try setup()
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        var removed: [[String]] = []
        let recovery = LocalNoticeRecovery(ledger: ledger, keys: keys) { removed.append($0) }
        let entries: [LocalNoticeRecovery.Entry] = [
            .init(request: try request(markerOne), deliveredAt: nil),
            .init(request: try request(markerTwo), deliveredAt: nil),
            .init(request: try request(markerTwo, secure: true), deliveredAt: nil),
        ]
        let candidates = try recovery.review(entries)
        #expect(candidates.count == 1)
        let selected = try #require(candidates.first)
        try recovery.confirm(selected, current: entries)
        #expect(removed == [[markerOne.systemIdentifier]])
        #expect(try ledger.classify(markerOne, keys: keys, systemIdentifier: markerOne.systemIdentifier) == .retired)
        #expect(try ledger.record(two).activity == .active)
        #expect(throws: LocalNoticeError.changed) { try ledger.record(one) }
    }

    @Test func changedDisplayOrSecureReplacementInvalidatesSelection() throws {
        let (dir, keys, ledger, one, markerOne, _, _) = try setup()
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        var removed: [[String]] = []
        let recovery = LocalNoticeRecovery(ledger: ledger, keys: keys) { removed.append($0) }
        let original: [LocalNoticeRecovery.Entry] = [.init(request: try request(markerOne), deliveredAt: nil)]
        let candidates = try recovery.review(original), selected = try #require(candidates.first)
        let changed: [LocalNoticeRecovery.Entry] = [.init(request: try request(markerOne, title: "Different"), deliveredAt: nil)]
        #expect(throws: LocalNoticeError.changed) { try recovery.confirm(selected, current: changed) }
        let secure: [LocalNoticeRecovery.Entry] = [.init(request: try request(markerOne, secure: true), deliveredAt: nil)]
        #expect(throws: LocalNoticeError.changed) { try recovery.confirm(selected, current: secure) }
        let unrelated = UNNotificationRequest(identifier: markerOne.systemIdentifier,
                                              content: UNMutableNotificationContent(), trigger: nil)
        let collision = original + [LocalNoticeRecovery.Entry(request: unrelated, deliveredAt: nil)]
        #expect(throws: LocalNoticeError.changed) { try recovery.confirm(selected, current: collision) }
        #expect(removed.isEmpty); #expect(try ledger.record(one).activity == .active)
    }

    @Test func confirmedUncertainRequestRetainsItsTrackingDebt() throws {
        let (dir, keys, ledger, _, _, two, markerTwo) = try setup()
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        var removed: [[String]] = []
        let recovery = LocalNoticeRecovery(ledger: ledger, keys: keys) { removed.append($0) }
        let entries: [LocalNoticeRecovery.Entry] = [.init(request: try request(markerTwo), deliveredAt: nil)]
        let candidates = try recovery.review(entries), selected = try #require(candidates.first)
        try recovery.confirm(selected, current: entries)
        #expect(removed == [[markerTwo.systemIdentifier]])
        let record = try ledger.record(two)
        #expect(record.activity == .invalidated); #expect(record.effect == .crashUncertain)
        #expect(try ledger.counts().uncertain == 1)
    }

    @Test func oversizedReviewDoesNotDeleteOrChangeHistoricalRequests() throws {
        let (dir, keys, ledger, one, markerOne, _, _) = try setup()
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        var removed: [[String]] = []
        let recovery = LocalNoticeRecovery(ledger: ledger, keys: keys) { removed.append($0) }
        let big = UNMutableNotificationContent()
        big.body = String(repeating: "x", count: LocalNoticeReconciler.maximumMetadataBytes + 1)
        let entries: [LocalNoticeRecovery.Entry] = [
            .init(request: try request(markerOne), deliveredAt: nil),
            .init(request: UNNotificationRequest(identifier: "synthetic-big", content: big, trigger: nil), deliveredAt: nil),
        ]
        #expect(throws: LocalNoticeError.capacity) { try recovery.review(entries) }
        #expect(removed.isEmpty); #expect(try ledger.record(one).activity == .active)
    }

    @Test func visiblePreparedMarkerQuarantinesItsHistoricalOwner() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("remi-local-review-\(UUID())")
        defer { try? FileManager.default.removeItem(at: dir) }
        let keys = try LocalNoticeKeys(root: Data(repeating: 44, count: 32))
        let owner = try keys.ownerIndex(runtimeOwner: UUID())
        let question = try keys.questionIndex(owner: owner, sessionID: "synthetic", questionID: "q")
        let original = try LocalNoticeLedger(directory: dir)
        try original.createOwner(owner)
        let ticket = try original.prepare(owner: owner, question: question)
        let marker = try keys.marker(requestID: ticket.requestID, owner: owner,
                                     sequence: ticket.sequence, question: question)
        original.close()
        let ledger = try LocalNoticeLedger(directory: dir)
        defer { ledger.close() }
        var removed: [[String]] = []
        let recovery = LocalNoticeRecovery(ledger: ledger, keys: keys) { removed.append($0) }
        let entries: [LocalNoticeRecovery.Entry] = [.init(request: try request(marker), deliveredAt: nil)]
        #expect(throws: LocalNoticeError.corrupt) { try recovery.review(entries) }
        #expect(removed.isEmpty)
        #expect(try ledger.classify(marker, keys: keys, systemIdentifier: marker.systemIdentifier) == .quarantined)
    }

    @Test func separatelyConfirmedUnseenDebtCanBeAbandonedWithoutRemovingOtherAlerts() throws {
        let (dir, keys, ledger, one, _, two, markerTwo) = try setup()
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        var removed: [[String]] = []
        let recovery = LocalNoticeRecovery(ledger: ledger, keys: keys) { removed.append($0) }
        let debts = try recovery.unassignedUncertain()
        #expect(debts.count == 1)
        let selected = try #require(debts.first)
        #expect(selected.identifierSuffix == String(two.requestID.suffix(8)))
        #expect(try ledger.record(two).activity == .active)
        try recovery.abandonUnseen(selected, current: [])
        #expect(removed.isEmpty)
        #expect(throws: LocalNoticeError.changed) { try ledger.record(two) }
        #expect(try ledger.classify(markerTwo, keys: keys, systemIdentifier: markerTwo.systemIdentifier) == .retired)
        #expect(try ledger.record(one).activity == .active)
    }

    @Test func visibleOrOversizedInventoryPreventsAbandoningUncertainDebt() throws {
        let (dir, keys, ledger, _, _, two, markerTwo) = try setup()
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        var removed: [[String]] = []
        let recovery = LocalNoticeRecovery(ledger: ledger, keys: keys) { removed.append($0) }
        let debts = try recovery.unassignedUncertain(), selected = try #require(debts.first)
        let visible: [LocalNoticeRecovery.Entry] = [.init(request: try request(markerTwo), deliveredAt: nil)]
        #expect(throws: LocalNoticeError.changed) { try recovery.abandonUnseen(selected, current: visible) }
        let big = UNMutableNotificationContent()
        big.body = String(repeating: "x", count: LocalNoticeReconciler.maximumMetadataBytes + 1)
        let oversized: [LocalNoticeRecovery.Entry] = [.init(request: UNNotificationRequest(identifier: "big", content: big, trigger: nil), deliveredAt: nil)]
        #expect(throws: LocalNoticeError.capacity) { try recovery.abandonUnseen(selected, current: oversized) }
        #expect(removed.isEmpty); #expect(try ledger.record(two).effect == .crashUncertain)
    }
}
