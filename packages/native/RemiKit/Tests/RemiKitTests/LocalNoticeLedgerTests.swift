import Foundation
import Testing
@testable import RemiKit

@Suite(.serialized) struct LocalNoticeLedgerTests {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("remi-local-notice-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return url
    }
    private func indexes(_ keys: LocalNoticeKeys, owner: UUID = UUID(), session: String = "synthetic-session", question: String = "synthetic-question") throws -> (Data, Data) {
        let index = try keys.ownerIndex(runtimeOwner: owner)
        return (index, try keys.questionIndex(owner: index, sessionID: session, questionID: question))
    }
    private func marker(_ keys: LocalNoticeKeys, _ ticket: LocalNoticeLedger.Ticket) throws -> LocalNoticeMarker {
        try keys.marker(requestID: ticket.requestID, owner: ticket.owner, sequence: ticket.sequence, question: ticket.question)
    }

    @Test func preparedAndSettledRetirementRequiresExactProof() throws {
        let dir = try directory()
        let keys = try LocalNoticeKeys(root: Data(repeating: 7, count: 32)), (owner, question) = try indexes(keys)
        let ledger = try LocalNoticeLedger(directory: dir)
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        try ledger.createOwner(owner)
        let uninvoked = try ledger.prepare(owner: owner, question: question)
        let uninvokedMarker = try marker(keys, uninvoked)
        #expect(try ledger.classify(uninvokedMarker, keys: keys, systemIdentifier: uninvokedMarker.systemIdentifier) == .currentActive)
        #expect(throws: LocalNoticeError.changed) { try ledger.retire(uninvoked) }
        try ledger.invalidate(uninvoked); try ledger.retire(uninvoked)
        #expect(try ledger.classify(uninvokedMarker, keys: keys, systemIdentifier: uninvokedMarker.systemIdentifier) == .retired)

        let dispatched = try ledger.prepare(owner: owner, question: question)
        let dispatchedMarker = try marker(keys, dispatched)
        try ledger.beginAdd(dispatched); try ledger.invalidate(dispatched)
        #expect(throws: LocalNoticeError.changed) { try ledger.retire(dispatched) }
        try ledger.settle(dispatched, succeeded: true)
        #expect(throws: LocalNoticeError.changed) { try ledger.retire(dispatched) }
        try ledger.removalWasRequested(dispatched); try ledger.retire(dispatched)
        #expect(try ledger.classify(dispatchedMarker, keys: keys, systemIdentifier: dispatchedMarker.systemIdentifier) == .retired)
        let counts = try ledger.counts(); #expect(counts.tickets == 0); #expect(counts.ranges == 1)
    }

    @Test func inFlightIsUncertainAfterRestartAndHistoricalActiveIsNotAdopted() throws {
        let dir = try directory()
        let keys = try LocalNoticeKeys(root: Data(repeating: 8, count: 32)), (owner, question) = try indexes(keys)
        var ledger: LocalNoticeLedger? = try LocalNoticeLedger(directory: dir)
        defer { ledger?.close(); try? FileManager.default.removeItem(at: dir) }
        try ledger?.createOwner(owner)
        let activeLedger = try #require(ledger)
        let active = try activeLedger.prepare(owner: owner, question: question)
        try ledger?.beginAdd(active)
        let activeMarker = try marker(keys, active)
        ledger?.close(); ledger = nil
        let reopened = try LocalNoticeLedger(directory: dir)
        defer { reopened.close() }
        #expect(try reopened.record(active).effect == .crashUncertain)
        #expect(try reopened.classify(activeMarker, keys: keys, systemIdentifier: activeMarker.systemIdentifier) == .historicalActive)
        #expect(throws: LocalNoticeError.changed) { try reopened.invalidate(active) }
        #expect(throws: LocalNoticeError.changed) { try reopened.prepare(owner: owner, question: question) }
        #expect(try reopened.counts().uncertain == 1)
    }

    @Test func currentForgetDoesNotAdoptOrInvalidateAnotherOwner() throws {
        let dir = try directory()
        let keys = try LocalNoticeKeys(root: Data(repeating: 9, count: 32))
        let (first, firstQuestion) = try indexes(keys), (second, secondQuestion) = try indexes(keys)
        let ledger = try LocalNoticeLedger(directory: dir)
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        try ledger.createOwner(first); try ledger.createOwner(second)
        let firstTicket = try ledger.prepare(owner: first, question: firstQuestion)
        let secondTicket = try ledger.prepare(owner: second, question: secondQuestion)
        try ledger.invalidateOwner(first)
        #expect(try ledger.record(firstTicket).activity == .invalidated)
        #expect(try ledger.record(secondTicket).activity == .active)
        #expect(try ledger.records(owner: first).map(\.ticket) == [firstTicket])
        #expect(try ledger.records(owner: second).map(\.ticket) == [secondTicket])
        #expect(throws: LocalNoticeError.changed) { try ledger.prepare(owner: first, question: firstQuestion) }
        let marker = try marker(keys, secondTicket)
        #expect(try ledger.classify(marker, keys: keys, systemIdentifier: marker.systemIdentifier) == .currentActive)
    }

    @Test func interruptedForgetIsDurableAndCannotBeAdoptedByAnotherProcess() throws {
        let dir = try directory(), keys = try LocalNoticeKeys(root: Data(repeating: 36, count: 32))
        let (oldOwner, oldQuestion) = try indexes(keys), (otherOwner, otherQuestion) = try indexes(keys)
        var ledger: LocalNoticeLedger? = try LocalNoticeLedger(directory: dir)
        defer { ledger?.close(); try? FileManager.default.removeItem(at: dir) }
        try ledger?.createOwner(oldOwner); try ledger?.createOwner(otherOwner)
        let current = try #require(ledger)
        let old = try current.prepare(owner: oldOwner, question: oldQuestion)
        let other = try current.prepare(owner: otherOwner, question: otherQuestion)
        try current.invalidateOwner(oldOwner)
        #expect(try current.pendingForgetOwners() == [oldOwner])
        #expect(try current.record(old).activity == .invalidated)
        #expect(try current.record(other).activity == .active)
        current.close(); ledger = nil
        let restarted = try LocalNoticeLedger(directory: dir)
        defer { restarted.close() }
        #expect(try restarted.pendingForgetOwners() == [oldOwner])
        #expect(throws: LocalNoticeError.changed) { try restarted.finishForget(oldOwner) }
        #expect(try restarted.pendingForgetOwners() == [oldOwner])
        #expect(try restarted.record(other).activity == .active)
    }

    @Test func currentOwnerForgetCanCompleteOnlyOnce() throws {
        let dir = try directory(), keys = try LocalNoticeKeys(root: Data(repeating: 37, count: 32))
        let (owner, _) = try indexes(keys), ledger = try LocalNoticeLedger(directory: dir)
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        try ledger.createOwner(owner); try ledger.invalidateOwner(owner)
        #expect(try ledger.pendingForgetOwners() == [owner])
        try ledger.finishForget(owner)
        #expect(try ledger.pendingForgetOwners().isEmpty)
        #expect(throws: LocalNoticeError.changed) { try ledger.finishForget(owner) }
    }

    @Test func retirementCompactsThousandsWithoutCrossingLiveHole() throws {
        let dir = try directory()
        let keys = try LocalNoticeKeys(root: Data(repeating: 10, count: 32)), (owner, question) = try indexes(keys)
        let ledger = try LocalNoticeLedger(directory: dir)
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        try ledger.createOwner(owner)
        let held = try ledger.prepare(owner: owner, question: question), heldMarker = try marker(keys, held)
        var last: LocalNoticeMarker?
        for _ in 0..<2_048 {
            let next = try ledger.prepare(owner: owner, question: question)
            try ledger.beginAdd(next); try ledger.settle(next, succeeded: true); try ledger.invalidate(next)
            try ledger.removalWasRequested(next); try ledger.retire(next)
            last = try marker(keys, next)
        }
        let counts = try ledger.counts()
        #expect(counts.owners == 1); #expect(counts.tickets == 1); #expect(counts.ranges == 1)
        #expect(try ledger.classify(heldMarker, keys: keys, systemIdentifier: heldMarker.systemIdentifier) == .currentActive)
        let latest = try #require(last)
        #expect(try ledger.classify(latest, keys: keys, systemIdentifier: latest.systemIdentifier) == .retired)
        try ledger.invalidate(held); try ledger.retire(held)
        #expect(try ledger.counts().ranges == 1)
    }

    @Test func thousandsOfPreDispatchResolutionsRemainBounded() throws {
        let dir = try directory()
        let keys = try LocalNoticeKeys(root: Data(repeating: 30, count: 32)), (owner, question) = try indexes(keys)
        let ledger = try LocalNoticeLedger(directory: dir)
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        try ledger.createOwner(owner)
        let held = try ledger.prepare(owner: owner, question: question)
        for _ in 0..<2_048 {
            let ticket = try ledger.prepare(owner: owner, question: question)
            try ledger.invalidate(ticket); try ledger.retire(ticket)
        }
        let counts = try ledger.counts()
        #expect(counts.owners == 1); #expect(counts.tickets == 1); #expect(counts.ranges == 1)
        #expect(try ledger.classify(marker(keys, held), keys: keys, systemIdentifier: "remi.local.v1." + held.requestID) == .currentActive)
        let distinct = try ledger.prepare(owner: owner, question: question)
        #expect(try ledger.record(distinct).effect == .prepared)
    }

    @Test func forgedOrSwappedMarkersCannotClaimRetirement() throws {
        let dir = try directory()
        let keys = try LocalNoticeKeys(root: Data(repeating: 11, count: 32)), (owner, question) = try indexes(keys)
        let ledger = try LocalNoticeLedger(directory: dir)
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        try ledger.createOwner(owner)
        let ticket = try ledger.prepare(owner: owner, question: question), genuine = try marker(keys, ticket)
        var altered = genuine.authentication; altered[0] ^= 1
        let forged = LocalNoticeMarker(version: genuine.version, requestID: genuine.requestID, ownerIndex: genuine.ownerIndex,
            sequence: genuine.sequence, questionIndex: genuine.questionIndex, authentication: altered)
        #expect(try ledger.classify(forged, keys: keys, systemIdentifier: forged.systemIdentifier) == .unknown)
        #expect(try ledger.classify(genuine, keys: keys, systemIdentifier: "other") == .unknown)
        let future = try keys.marker(requestID: UUID().uuidString.lowercased(), owner: owner, sequence: ticket.sequence + 1, question: question)
        #expect(try ledger.classify(future, keys: keys, systemIdentifier: future.systemIdentifier) == .quarantined)
        #expect(throws: LocalNoticeError.changed) { try ledger.prepare(owner: owner, question: question) }
    }

    @Test func sameStoreCannotBeOwnedByTwoProcessesOrInstances() throws {
        let dir = try directory()
        let first = try LocalNoticeLedger(directory: dir)
        defer { first.close(); try? FileManager.default.removeItem(at: dir) }
        #expect(throws: LocalNoticeError.busy) { try LocalNoticeLedger(directory: dir) }
        withExtendedLifetime(first) {}
    }

    @Test func atMost128UnsettledAddsCanBecomeCrashUncertain() throws {
        let dir = try directory(), keys = try LocalNoticeKeys(root: Data(repeating: 12, count: 32))
        let (owner, question) = try indexes(keys), ledger = try LocalNoticeLedger(directory: dir)
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        try ledger.createOwner(owner)
        for _ in 0..<LocalNoticeLedger.maximumUncertain {
            let ticket = try ledger.prepare(owner: owner, question: question)
            try ledger.beginAdd(ticket)
        }
        let overflow = try ledger.prepare(owner: owner, question: question)
        #expect(throws: LocalNoticeError.capacity) { try ledger.beginAdd(overflow) }
        #expect(try ledger.record(overflow).effect == .prepared)
        #expect(try ledger.counts().uncertain == LocalNoticeLedger.maximumUncertain)
    }

    @Test func historicalOwnersRemainSeparateWhenSameEndpointIsRepaired() throws {
        let dir = try directory(), keys = try LocalNoticeKeys(root: Data(repeating: 13, count: 32))
        let (oldX, oldQuestion) = try indexes(keys, session: "same-session", question: "same-question")
        let (oldY, otherQuestion) = try indexes(keys, session: "same-session", question: "same-question")
        var first: LocalNoticeLedger? = try LocalNoticeLedger(directory: dir)
        defer { first?.close(); try? FileManager.default.removeItem(at: dir) }
        try first?.createOwner(oldX); try first?.createOwner(oldY)
        let firstLedger = try #require(first)
        let oldXTicket = try firstLedger.prepare(owner: oldX, question: oldQuestion)
        let oldYTicket = try firstLedger.prepare(owner: oldY, question: otherQuestion)
        let oldXMarker = try marker(keys, oldXTicket), oldYMarker = try marker(keys, oldYTicket)
        first?.close(); first = nil
        let second = try LocalNoticeLedger(directory: dir); defer { second.close() }
        let (newX, newQuestion) = try indexes(keys, session: "same-session", question: "same-question")
        try second.createOwner(newX)
        let newTicket = try second.prepare(owner: newX, question: newQuestion)
        try second.invalidateOwner(newX)
        #expect(try second.record(newTicket).activity == .invalidated)
        #expect(try second.classify(oldXMarker, keys: keys, systemIdentifier: oldXMarker.systemIdentifier) == .historicalActive)
        #expect(try second.classify(oldYMarker, keys: keys, systemIdentifier: oldYMarker.systemIdentifier) == .historicalActive)
        #expect(throws: LocalNoticeError.changed) { try second.invalidateOwner(oldX) }
        #expect(throws: LocalNoticeError.changed) { try second.invalidateOwner(oldY) }
    }

    @Test func indexTuplesAreDomainSeparatedAndLengthBounded() throws {
        let keys = try LocalNoticeKeys(root: Data(repeating: 14, count: 32)), owner = try keys.ownerIndex(runtimeOwner: UUID())
        let left = try keys.questionIndex(owner: owner, sessionID: "a|b", questionID: "c")
        let right = try keys.questionIndex(owner: owner, sessionID: "a", questionID: "b|c")
        #expect(left != right)
        #expect(throws: LocalNoticeError.invalid) { try keys.questionIndex(owner: owner, sessionID: String(repeating: "x", count: 513), questionID: "q") }
        #expect(throws: LocalNoticeError.invalid) { try LocalNoticeKeys(root: Data(count: 31)) }
    }


    @Test func outOfOrderRetirementsNeverBridgeAnActiveSequence() throws {
        let dir = try directory(), keys = try LocalNoticeKeys(root: Data(repeating: 15, count: 32))
        let (owner, question) = try indexes(keys), ledger = try LocalNoticeLedger(directory: dir)
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        try ledger.createOwner(owner)
        let first = try ledger.prepare(owner: owner, question: question)
        let held = try ledger.prepare(owner: owner, question: question)
        let third = try ledger.prepare(owner: owner, question: question)
        try ledger.invalidate(first); try ledger.retire(first)
        try ledger.invalidate(third); try ledger.retire(third)
        #expect(try ledger.counts().ranges == 2)
        let heldMarker = try marker(keys, held)
        #expect(try ledger.classify(heldMarker, keys: keys, systemIdentifier: heldMarker.systemIdentifier) == .currentActive)
        try ledger.invalidate(held); try ledger.retire(held)
        #expect(try ledger.counts().ranges == 1)
    }

    @Test func fullJournalNeverEvictsCurrentTickets() throws {
        let dir = try directory(), keys = try LocalNoticeKeys(root: Data(repeating: 16, count: 32))
        let (owner, question) = try indexes(keys), ledger = try LocalNoticeLedger(directory: dir)
        defer { ledger.close(); try? FileManager.default.removeItem(at: dir) }
        try ledger.createOwner(owner)
        var tickets: [LocalNoticeLedger.Ticket] = []
        for _ in 0..<(LocalNoticeLedger.maximumRows - 1) { tickets.append(try ledger.prepare(owner: owner, question: question)) }
        #expect(try ledger.counts().tickets == LocalNoticeLedger.maximumRows - 1)
        #expect(throws: LocalNoticeError.capacity) { try ledger.prepare(owner: owner, question: question) }
        let last = try #require(tickets.last)
        #expect(try ledger.record(last).activity == .active)
        try ledger.invalidate(tickets[0]); try ledger.retire(tickets[0])
        try ledger.invalidate(tickets[1]); try ledger.retire(tickets[1])
        _ = try ledger.prepare(owner: owner, question: question)
        #expect(try ledger.record(last).activity == .active)
    }

    @Test func symlinkedJournalIsRefusedWithoutChangingItsTarget() throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let target = dir.appendingPathComponent("sentinel"), link = dir.appendingPathComponent("local-notifications.sqlite")
        let bytes = Data("owned-sentinel".utf8); try bytes.write(to: target)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        #expect(throws: LocalNoticeError.unavailable) { try LocalNoticeLedger(directory: dir) }
        #expect(try Data(contentsOf: target) == bytes)
    }


    @Test func opaqueMarkerRejectsExtraFieldsAndCannotDecodeAsLegacyDestination() throws {
        let keys = try LocalNoticeKeys(root: Data(repeating: 17, count: 32)), (owner, question) = try indexes(keys)
        let marker = try keys.marker(requestID: UUID().uuidString.lowercased(), owner: owner, sequence: 1, question: question)
        let info = try marker.userInfo(), decoded = try LocalNoticeMarker.parse(userInfo: info)
        #expect(decoded == marker)
        #expect(keys.verifies(decoded, systemIdentifier: marker.systemIdentifier))
        #expect(!marker.systemIdentifier.contains("synthetic-session"))
        #expect(!marker.systemIdentifier.contains("synthetic-question"))
        let legacyBytes = try JSONSerialization.data(withJSONObject: info)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(RemiNavigationDestination.self, from: legacyBytes) }
        var modified = info; modified["machineID"] = "untrusted"
        #expect(throws: LocalNoticeError.invalid) { try LocalNoticeMarker.parse(userInfo: modified) }
        #expect(throws: LocalNoticeError.invalid) { try LocalNoticeMarker.parse(userInfo: ["remiLocal": "bad"]) }
    }


    @Test func symlinkedDirectoryIsRefusedBeforeOpeningJournal() throws {
        let parent = try directory(); defer { try? FileManager.default.removeItem(at: parent) }
        let actual = parent.appendingPathComponent("actual"), link = parent.appendingPathComponent("link")
        try FileManager.default.createDirectory(at: actual, withIntermediateDirectories: false)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: actual)
        #expect(throws: LocalNoticeError.unavailable) { try LocalNoticeLedger(directory: link) }
        #expect(!FileManager.default.fileExists(atPath: actual.appendingPathComponent("local-notifications.sqlite").path))
    }

    @Test func detectedDirectorySwapBlocksFurtherWritesWithoutTouchingReplacement() throws {
        let parent = try directory(); defer { try? FileManager.default.removeItem(at: parent) }
        let original = parent.appendingPathComponent("original"), moved = parent.appendingPathComponent("moved")
        let replacement = parent.appendingPathComponent("replacement")
        try FileManager.default.createDirectory(at: original, withIntermediateDirectories: false)
        try FileManager.default.createDirectory(at: replacement, withIntermediateDirectories: false)
        let sentinel = replacement.appendingPathComponent("sentinel"), bytes = Data("owned-sentinel".utf8)
        try bytes.write(to: sentinel)
        let ledger = try LocalNoticeLedger(directory: original)
        defer { ledger.close() }
        try FileManager.default.moveItem(at: original, to: moved)
        try FileManager.default.createSymbolicLink(at: original, withDestinationURL: replacement)
        #expect(throws: LocalNoticeError.unavailable) { try ledger.createOwner(Data(repeating: 3, count: 32)) }
        #expect(try Data(contentsOf: sentinel) == bytes)
        #expect(!FileManager.default.fileExists(atPath: replacement.appendingPathComponent("local-notifications.sqlite").path))
    }

}
