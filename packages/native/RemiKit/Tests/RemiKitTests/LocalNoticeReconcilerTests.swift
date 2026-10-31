import Foundation
import Testing
import UserNotifications
@testable import RemiKit

@Suite(.serialized) @MainActor struct LocalNoticeReconcilerTests {
    private func request(_ marker: LocalNoticeMarker, extraRemote: Bool = false) throws -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        var info = try marker.userInfo()
        if extraRemote { info["remiPush"] = "synthetic" }
        content.userInfo = info
        return UNNotificationRequest(identifier: marker.systemIdentifier, content: content, trigger: nil)
    }

    @Test func historicalActiveAndRemoteAreRetainedWhileOnlyTombstonesAreRemoved() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("remi-scan-\(UUID())")
        defer { try? FileManager.default.removeItem(at: dir) }
        let keys = try LocalNoticeKeys(root: Data(repeating: 31, count: 32))
        let oldOwner = try keys.ownerIndex(runtimeOwner: UUID())
        let question = try keys.questionIndex(owner: oldOwner, sessionID: "synthetic", questionID: "q")
        var ledger = try LocalNoticeLedger(directory: dir)
        try ledger.createOwner(oldOwner)
        let active = try ledger.prepare(owner: oldOwner, question: question)
        try ledger.beginAdd(active)
        let retired = try ledger.prepare(owner: oldOwner, question: question)
        try ledger.invalidate(retired); try ledger.retire(retired)
        let collided = try ledger.prepare(owner: oldOwner, question: question)
        try ledger.invalidate(collided); try ledger.retire(collided)
        ledger.close()
        ledger = try LocalNoticeLedger(directory: dir)
        defer { ledger.close() }
        let oldMarker = try keys.marker(requestID: active.requestID, owner: oldOwner,
                                        sequence: active.sequence, question: question)
        let retiredMarker = try keys.marker(requestID: retired.requestID, owner: oldOwner,
                                            sequence: retired.sequence, question: question)
        let collidedMarker = try keys.marker(requestID: collided.requestID, owner: oldOwner,
                                             sequence: collided.sequence, question: question)
        var removals: [[String]] = []
        let reconciler = LocalNoticeReconciler(ledger: ledger, keys: keys) { removals.append($0) }
        try reconciler.reconcile([request(oldMarker), request(retiredMarker), request(collidedMarker),
                                  request(collidedMarker, extraRemote: true)])
        #expect(removals == [[retiredMarker.systemIdentifier]])
        #expect(try ledger.classify(oldMarker, keys: keys, systemIdentifier: oldMarker.systemIdentifier) == .historicalActive)
        #expect(try ledger.record(active).effect == .crashUncertain)
    }

    @Test func oversizedInventoryRefusesTheEntireScan() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("remi-scan-\(UUID())")
        defer { try? FileManager.default.removeItem(at: dir) }
        let ledger = try LocalNoticeLedger(directory: dir)
        defer { ledger.close() }
        let keys = try LocalNoticeKeys(root: Data(repeating: 32, count: 32))
        var removals: [[String]] = []
        let reconciler = LocalNoticeReconciler(ledger: ledger, keys: keys) { removals.append($0) }
        let content = UNMutableNotificationContent(); content.body = String(repeating: "x", count: 2 * 1_024 * 1_024 + 1)
        let request = UNNotificationRequest(identifier: "synthetic", content: content, trigger: nil)
        #expect(throws: LocalNoticeError.capacity) { try reconciler.reconcile([request]) }
        #expect(removals.isEmpty)
    }

    @Test func aLaterHighwaterMismatchQuarantinesEarlierCleanupCandidates() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("remi-scan-\(UUID())")
        defer { try? FileManager.default.removeItem(at: dir) }
        let ledger = try LocalNoticeLedger(directory: dir)
        defer { ledger.close() }
        let keys = try LocalNoticeKeys(root: Data(repeating: 33, count: 32))
        let owner = try keys.ownerIndex(runtimeOwner: UUID())
        let question = try keys.questionIndex(owner: owner, sessionID: "synthetic", questionID: "q")
        try ledger.createOwner(owner)
        let retired = try ledger.prepare(owner: owner, question: question)
        try ledger.invalidate(retired); try ledger.retire(retired)
        let normal = try keys.marker(requestID: retired.requestID, owner: owner, sequence: retired.sequence, question: question)
        let future = try keys.marker(requestID: UUID().uuidString.lowercased(), owner: owner,
                                     sequence: retired.sequence + 1, question: question)
        var removals: [[String]] = []
        let reconciler = LocalNoticeReconciler(ledger: ledger, keys: keys) { removals.append($0) }
        try reconciler.reconcile([request(normal), request(future)])
        #expect(removals.isEmpty)
        #expect(try ledger.classify(normal, keys: keys, systemIdentifier: normal.systemIdentifier) == .quarantined)
    }
}
