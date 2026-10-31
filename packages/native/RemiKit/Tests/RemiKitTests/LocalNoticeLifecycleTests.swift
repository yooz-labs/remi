import Foundation
import Testing
import UserNotifications
@testable import RemiKit

/// Only the platform notification center is substituted; real lifecycle and SQLite are used.
@MainActor private final class OwnedLocalNoticeOS {
    var allowed = true
    var holdNextAdd = false
    var holdNextAuthorization = false
    var holdNextInventory = false
    var held: CheckedContinuation<Void, Never>?
    var heldAuthorization: CheckedContinuation<Void, Never>?
    var heldInventory: CheckedContinuation<Void, Never>?
    var authorizationFinished = false
    var inventoryFinished = false
    var requests: [String: UNNotificationRequest] = [:]
    var begun: [String] = []
    var removals: [[String]] = []
    var delayedRemovals: [[String]] = []
    var delayRemovals = false
    var identifiersAvailable = true
    var failNextAdd = false
    var boundary: LocalNoticeBoundary {
        .init(authorized: { [self] in
            if holdNextAuthorization {
                holdNextAuthorization = false
                await withCheckedContinuation { heldAuthorization = $0 }
            }
            authorizationFinished = true
            return allowed
        }, identifierAvailable: { [self] _ in
            if holdNextInventory {
                holdNextInventory = false
                await withCheckedContinuation { heldInventory = $0 }
            }
            inventoryFinished = true
            return identifiersAvailable
        }, add: { [self] request in
            begun.append(request.identifier)
            if holdNextAdd {
                holdNextAdd = false
                await withCheckedContinuation { held = $0 }
            }
            if failNextAdd { failNextAdd = false; throw NoticeTestTimeout.noEvent }
            requests[request.identifier] = request
        }, remove: { [self] ids in
            removals.append(ids)
            if delayRemovals { delayedRemovals.append(ids) }
            else { for id in ids { requests[id] = nil } }
        })
    }
    func finishHeldAdd() { held?.resume(); held = nil }
    func finishHeldAuthorization() { heldAuthorization?.resume(); heldAuthorization = nil }
    func finishHeldInventory() { heldInventory?.resume(); heldInventory = nil }
    func finishRemovals() {
        for ids in delayedRemovals { for id in ids { requests[id] = nil } }
        delayedRemovals.removeAll()
    }
}
private enum NoticeTestTimeout: Error { case noEvent }

@Suite(.serialized) @MainActor struct LocalNoticeLifecycleTests {
    private func until(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while !condition() {
            guard ContinuousClock.now < deadline else { throw NoticeTestTimeout.noEvent }
            try await Task.sleep(for: .milliseconds(5))
        }
    }
    private func directory() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("remi-local-lifecycle-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return dir
    }
    private func intent(owner: UUID, session: String = "session", question: String = "question", body: String = "Synthetic",
                        current: @escaping @MainActor () -> Bool = { true }) -> LocalNoticeLifecycle.Intent {
        .init(owner: owner, sessionID: session, questionID: question, title: "Synthetic", body: body,
              sound: false, summaries: false, isCurrent: current)
    }

    @Test func inFlightOldAddAndDelayedRemovalCannotEraseNewIncarnation() async throws {
        let dir = try directory(), keys = try LocalNoticeKeys(root: Data(repeating: 21, count: 32))
        let ledger = try LocalNoticeLedger(directory: dir), os = OwnedLocalNoticeOS()
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        let owner = UUID(), lifecycle = LocalNoticeLifecycle(ledger: ledger, keys: keys, boundary: os.boundary)
        let old = intent(owner: owner, body: "Old"), new = intent(owner: owner, body: "New")
        os.holdNextAdd = true; os.delayRemovals = true
        lifecycle.schedule(old)
        try await until { os.begun.count == 1 && os.held != nil }
        let oldID = try #require(os.begun.first)
        lifecycle.resolve(old.id)
        lifecycle.schedule(new)
        try await until { os.begun.count == 2 && os.requests.count == 1 }
        let newID = try #require(os.begun.last)
        #expect(oldID != newID)
        let request = try #require(os.requests[newID])
        #expect(try LocalNoticeMarker.parse(userInfo: request.content.userInfo).systemIdentifier == newID)
        #expect(!request.content.threadIdentifier.contains("session"))
        os.finishHeldAdd()
        try await until { os.removals.filter { $0 == [oldID] }.count >= 2 }
        os.finishRemovals()
        #expect(os.requests[oldID] == nil)
        #expect(os.requests[newID]?.content.body == "New")
        #expect(try ledger.counts().tickets == 1)
    }

    @Test func distinctQuestionsAreNotSuppressedAndSameLiveQuestionDoesNotRepeat() async throws {
        let dir = try directory(), keys = try LocalNoticeKeys(root: Data(repeating: 22, count: 32))
        let ledger = try LocalNoticeLedger(directory: dir), os = OwnedLocalNoticeOS()
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        let owner = UUID(), lifecycle = LocalNoticeLifecycle(ledger: ledger, keys: keys, boundary: os.boundary)
        let first = intent(owner: owner, session: "one", question: "one"), second = intent(owner: owner, session: "two", question: "two")
        lifecycle.schedule(first); lifecycle.schedule(first); lifecycle.schedule(second)
        try await until { os.requests.count == 2 }
        #expect(Set(os.begun).count == 2)
        #expect(try ledger.counts().tickets == 2)
    }

    @Test func eligibilityInvalidationCleansAnInFlightOldRequest() async throws {
        let dir = try directory(), keys = try LocalNoticeKeys(root: Data(repeating: 23, count: 32))
        let ledger = try LocalNoticeLedger(directory: dir), os = OwnedLocalNoticeOS()
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        let owner = UUID(), lifecycle = LocalNoticeLifecycle(ledger: ledger, keys: keys, boundary: os.boundary)
        os.holdNextAdd = true; lifecycle.schedule(intent(owner: owner))
        try await until { os.held != nil }
        let oldID = try #require(os.begun.first)
        lifecycle.invalidateEligibility(); os.finishHeldAdd()
        try await until { os.removals.filter { $0 == [oldID] }.count >= 2 }
        #expect(os.requests[oldID] == nil)
        #expect(try ledger.counts().tickets == 0)
    }

    @Test func disablingBeforeDispatchAtEachSuspensionNeverAdds() async throws {
        for holdAuthorization in [true, false] {
            let dir = try directory(), keys = try LocalNoticeKeys(root: Data(repeating: 34, count: 32))
            let ledger = try LocalNoticeLedger(directory: dir), os = OwnedLocalNoticeOS()
            let lifecycle = LocalNoticeLifecycle(ledger: ledger, keys: keys, boundary: os.boundary)
            os.holdNextAuthorization = holdAuthorization; os.holdNextInventory = !holdAuthorization
            lifecycle.schedule(intent(owner: UUID()))
            try await until { holdAuthorization ? os.heldAuthorization != nil : os.heldInventory != nil }
            lifecycle.invalidateEligibility()
            if holdAuthorization { os.finishHeldAuthorization() } else { os.finishHeldInventory() }
            try await until {
                (holdAuthorization ? os.authorizationFinished : os.inventoryFinished) && (try? ledger.counts().tickets) == 0
            }
            #expect(os.begun.isEmpty); #expect(os.removals.isEmpty)
            ledger.close(); try? FileManager.default.removeItem(at: dir)
        }
    }

    @Test func observedSystemDenialDuringAddClearsOnlyOldRequest() async throws {
        let dir = try directory(), keys = try LocalNoticeKeys(root: Data(repeating: 35, count: 32))
        let ledger = try LocalNoticeLedger(directory: dir), os = OwnedLocalNoticeOS()
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        let lifecycle = LocalNoticeLifecycle(ledger: ledger, keys: keys, boundary: os.boundary)
        os.holdNextAdd = true; lifecycle.schedule(intent(owner: UUID()))
        try await until { os.held != nil }
        let oldID = try #require(os.begun.first)
        os.allowed = false; os.finishHeldAdd()
        try await until { (try? ledger.counts().tickets) == 0 }
        #expect(os.requests[oldID] == nil)
        #expect(os.removals.allSatisfy { $0 == [oldID] })
        #expect(!os.removals.isEmpty)
    }

    @Test func stalledAddWarnsWithoutPretendingItSettled() async throws {
        let dir = try directory(), keys = try LocalNoticeKeys(root: Data(repeating: 25, count: 32))
        let ledger = try LocalNoticeLedger(directory: dir), os = OwnedLocalNoticeOS()
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        let owner = UUID(), lifecycle = LocalNoticeLifecycle(ledger: ledger, keys: keys,
            boundary: os.boundary, addWarningDelay: .milliseconds(20))
        let notice = intent(owner: owner)
        os.holdNextAdd = true; lifecycle.schedule(notice)
        try await until { os.held != nil && lifecycle.warning != nil }
        #expect(try ledger.counts().uncertain == 1)
        lifecycle.resolve(notice.id)
        #expect(try ledger.counts().uncertain == 1)
        os.finishHeldAdd()
        try await until { (try? ledger.counts().tickets) == 0 }
    }

    @Test func observedIdentifierCollisionNeverAddsOrRemovesExistingRequest() async throws {
        let dir = try directory(), keys = try LocalNoticeKeys(root: Data(repeating: 26, count: 32))
        let ledger = try LocalNoticeLedger(directory: dir), os = OwnedLocalNoticeOS()
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        let lifecycle = LocalNoticeLifecycle(ledger: ledger, keys: keys, boundary: os.boundary)
        os.identifiersAvailable = false
        lifecycle.schedule(intent(owner: UUID()))
        try await until { lifecycle.warning != nil }
        #expect(os.begun.isEmpty); #expect(os.removals.isEmpty)
        #expect(try ledger.counts().tickets == 1); #expect(try ledger.counts().uncertain == 0)
    }

    @Test func routeLossRetainsOldRequestUntilAcceptedReplacement() async throws {
        let dir = try directory(), keys = try LocalNoticeKeys(root: Data(repeating: 27, count: 32))
        let ledger = try LocalNoticeLedger(directory: dir), os = OwnedLocalNoticeOS()
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        let owner = UUID(), lifecycle = LocalNoticeLifecycle(ledger: ledger, keys: keys, boundary: os.boundary)
        let old = intent(owner: owner, body: "Old"), new = intent(owner: owner, body: "New")
        os.holdNextAdd = true; lifecycle.schedule(old)
        try await until { os.held != nil }
        let oldID = try #require(os.begun.first)
        lifecycle.suspend(owner: owner, sessionID: old.sessionID)
        os.finishHeldAdd()
        try await until { os.requests[oldID] != nil }
        let oldRequest = try #require(os.requests[oldID])
        let oldMarker = try LocalNoticeMarker.parse(userInfo: oldRequest.content.userInfo)
        #expect(try lifecycle.currentIdentity(for: oldMarker, systemIdentifier: oldID) == nil)
        #expect(os.removals.allSatisfy { !$0.contains(oldID) })
        lifecycle.schedule(new)
        try await until { os.requests.values.contains { $0.content.body == "New" } && os.requests[oldID] == nil }
        #expect(os.removals.contains([oldID]))
        #expect(os.requests.values.map(\.content.body) == ["New"])
        let newRequest = try #require(os.requests.values.first)
        let newMarker = try LocalNoticeMarker.parse(userInfo: newRequest.content.userInfo)
        #expect(try lifecycle.currentIdentity(for: newMarker, systemIdentifier: newRequest.identifier) == new.id)
    }

    @Test func failedReplacementDoesNotClearRetainedRequest() async throws {
        let dir = try directory(), keys = try LocalNoticeKeys(root: Data(repeating: 28, count: 32))
        let ledger = try LocalNoticeLedger(directory: dir), os = OwnedLocalNoticeOS()
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        let owner = UUID(), lifecycle = LocalNoticeLifecycle(ledger: ledger, keys: keys, boundary: os.boundary)
        let old = intent(owner: owner, body: "Old"), new = intent(owner: owner, body: "New")
        lifecycle.schedule(old)
        try await until { os.requests.count == 1 }
        let oldID = try #require(os.begun.first)
        lifecycle.suspend(owner: owner, sessionID: old.sessionID)
        os.failNextAdd = true; lifecycle.schedule(new)
        try await until { lifecycle.warning != nil && os.begun.count == 2 }
        #expect(os.requests[oldID]?.content.body == "Old")
        #expect(os.removals.allSatisfy { !$0.contains(oldID) })
        lifecycle.resolve(old.id)
        #expect(os.requests[oldID] == nil)
    }

    @Test func currentOwnerForgetCannotInvalidateAnotherOwner() async throws {
        let dir = try directory(), keys = try LocalNoticeKeys(root: Data(repeating: 24, count: 32))
        let ledger = try LocalNoticeLedger(directory: dir), os = OwnedLocalNoticeOS()
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        let first = UUID(), second = UUID(), lifecycle = LocalNoticeLifecycle(ledger: ledger, keys: keys, boundary: os.boundary)
        lifecycle.schedule(intent(owner: first, body: "First")); lifecycle.schedule(intent(owner: second, body: "Second"))
        try await until { os.requests.count == 2 }
        #expect(lifecycle.retireOwner(first))
        #expect(os.requests.values.map(\.content.body) == ["Second"])
        lifecycle.schedule(intent(owner: first, body: "Forbidden"))
        #expect(os.requests.values.map(\.content.body) == ["Second"])
    }
}
