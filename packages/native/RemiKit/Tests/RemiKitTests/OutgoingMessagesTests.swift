import Foundation
import Testing
@testable import RemiKit

@Suite struct OutgoingMessagesTests {
    @Test func aNewMessageIsSendingThenSent() {
        var outgoing = OutgoingMessages()
        outgoing.add(id: "1", content: "hello")
        #expect(outgoing.items.map(\.delivery) == [.sending])
        outgoing.markSent(id: "1")
        #expect(outgoing.items.map(\.delivery) == [.sent])
    }

    @Test func twoPendingMessagesBothStayVisibleInOrder() {
        var outgoing = OutgoingMessages()
        outgoing.add(id: "1", content: "first")
        outgoing.markSent(id: "1")
        outgoing.add(id: "2", content: "second")
        #expect(outgoing.items.map(\.content) == ["first", "second"])
    }

    @Test func aTranscriptEntryConfirmsOnlyTheOldestMatch() {
        var outgoing = OutgoingMessages()
        outgoing.add(id: "1", content: "yes")
        outgoing.add(id: "2", content: "yes")
        let first = outgoing.confirm(transcriptContent: "  yes\n")
        #expect(first)
        #expect(outgoing.items.map(\.id) == ["2"])
        let second = outgoing.confirm(transcriptContent: "yes")
        #expect(second)
        #expect(outgoing.items.isEmpty)
    }

    @Test func anUnrelatedTranscriptEntryConfirmsNothing() {
        var outgoing = OutgoingMessages()
        outgoing.add(id: "1", content: "run the tests")
        let confirmed = outgoing.confirm(transcriptContent: "something else")
        #expect(!confirmed)
        #expect(outgoing.items.count == 1)
    }

    @Test func aFailedSendIsRemoved() {
        var outgoing = OutgoingMessages()
        outgoing.add(id: "1", content: "a")
        outgoing.remove(id: "1")
        #expect(outgoing.items.isEmpty)
    }

    @Test func theQueueIsBoundedSoAStuckConnectionCannotGrowIt() {
        var outgoing = OutgoingMessages()
        for index in 0..<(OutgoingMessages.limit + 5) { outgoing.add(id: "\(index)", content: "m\(index)") }
        #expect(outgoing.items.count == OutgoingMessages.limit)
        #expect(outgoing.items.last?.id == "\(OutgoingMessages.limit + 4)")
    }

    @Test func anEntryIsVisibleOnlyForItsLifetime() {
        let start = Date(timeIntervalSince1970: 1_000)
        var outgoing = OutgoingMessages()
        outgoing.add(id: "1", content: "old", now: start)
        outgoing.add(id: "2", content: "new", now: start.addingTimeInterval(200))
        #expect(OutgoingMessages.lifetime == 300)
        #expect(outgoing.visible(now: start.addingTimeInterval(299)).map(\.id) == ["1", "2"])
        #expect(outgoing.visible(now: start.addingTimeInterval(300)).map(\.id) == ["2"])
        #expect(outgoing.visible(now: start.addingTimeInterval(501)).isEmpty)
    }

    @Test func addAndConfirmDropExpiredEntries() {
        let start = Date(timeIntervalSince1970: 1_000)
        var outgoing = OutgoingMessages()
        outgoing.add(id: "1", content: "stale", now: start)
        outgoing.add(id: "2", content: "fresh", now: start.addingTimeInterval(400))
        #expect(outgoing.items.map(\.id) == ["2"])
        outgoing.add(id: "3", content: "later", now: start.addingTimeInterval(450))
        let confirmed = outgoing.confirm(transcriptContent: "nothing", now: start.addingTimeInterval(800))
        #expect(!confirmed)
        #expect(outgoing.items.isEmpty)
    }

    @Test func anExpiredEntryIsNotConfirmed() {
        let start = Date(timeIntervalSince1970: 1_000)
        var outgoing = OutgoingMessages()
        outgoing.add(id: "1", content: "x", now: start)
        #expect(!outgoing.confirm(transcriptContent: "x", now: start.addingTimeInterval(301)))
    }
}
