import Foundation
import Testing
@testable import RemiKit

@Suite(.serialized)
struct RemiOrderedTranscriptTests {
    private func fixtureTemplate() throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(
            with: FixtureConformanceTests.fixture("transcript_content")) as? [String: Any])
    }

    private func message(
        template: [String: Any], id: String, content: String
    ) throws -> TranscriptContentMessage {
        var payload = template
        payload["entryUuid"] = id
        payload["content"] = content
        return try JSONDecoder().decode(
            TranscriptContentMessage.self,
            from: JSONSerialization.data(withJSONObject: payload)
        )
    }

    @Test func emptyTranscriptHasNoEntries() {
        #expect(RemiOrderedTranscript().entries.isEmpty)
    }

    @Test func newEntriesAppendInOrder() throws {
        let template = try fixtureTemplate()
        let first = try message(template: template, id: "a", content: "first")
        let second = try message(template: template, id: "b", content: "second")
        let transcript = RemiOrderedTranscript()

        transcript.apply(first)
        transcript.apply(second)

        #expect(transcript.entries == [first, second])
    }

    @Test func duplicateReplacesAndMovesToTheEnd() throws {
        let template = try fixtureTemplate()
        let first = try message(template: template, id: "a", content: "first")
        let second = try message(template: template, id: "b", content: "second")
        let third = try message(template: template, id: "c", content: "third")
        let replacement = try message(template: template, id: "a", content: "updated")
        let transcript = RemiOrderedTranscript()
        for entry in [first, second, third, replacement] { transcript.apply(entry) }

        #expect(transcript.entries == [second, third, replacement])
    }

    @Test func interleavedDuplicatesKeepLastReplacementOrder() throws {
        let template = try fixtureTemplate()
        let firstA = try message(template: template, id: "a", content: "a1")
        let firstB = try message(template: template, id: "b", content: "b1")
        let firstC = try message(template: template, id: "c", content: "c1")
        let secondB = try message(template: template, id: "b", content: "b2")
        let secondA = try message(template: template, id: "a", content: "a2")
        let transcript = RemiOrderedTranscript()
        for entry in [firstA, firstB, firstC, secondB, secondA] { transcript.apply(entry) }

        #expect(transcript.entries == [firstC, secondB, secondA])
    }

    @Test func replayingTheSameOrderedHistoryTwiceIsIdempotent() throws {
        let template = try fixtureTemplate()
        let history = try (0..<4).map { index in
            try message(template: template, id: "entry-\(index)", content: "message-\(index)")
        }
        let singlePass = RemiOrderedTranscript()
        let replayed = RemiOrderedTranscript()
        for entry in history { singlePass.apply(entry) }
        for entry in history { replayed.apply(entry) }
        for entry in history { replayed.apply(entry) }

        #expect(replayed.entries == singlePass.entries)
    }

    @Test func suffixReturnsTheNewestEntriesInOrder() throws {
        let template = try fixtureTemplate()
        let history = try (0..<4).map { index in
            try message(template: template, id: "entry-\(index)", content: "message-\(index)")
        }
        let transcript = RemiOrderedTranscript()
        for entry in history { transcript.apply(entry) }

        #expect(transcript.suffix(2) == Array(history.suffix(2)))
    }

    @Test(arguments: [1_000, 4_000])
    func replayedDuplicatesUseLinearElementWork(_ entryCount: Int) throws {
        let template = try fixtureTemplate()
        let history = try (0..<entryCount).map { index in
            try message(template: template, id: "entry-\(index)", content: "message-\(index)")
        }
        let transcript = RemiOrderedTranscript()
        for entry in history { transcript.apply(entry) }
        let visitsBeforeReplay = transcript.testingElementVisits

        for entry in history {
            transcript.apply(try message(template: template, id: entry.entryUuid, content: "updated"))
        }

        let replayVisits = transcript.testingElementVisits - visitsBeforeReplay
        #expect(replayVisits < entryCount * 5)
        #expect(transcript.map(\.entryUuid) == history.map(\.entryUuid))
        #expect(transcript.map(\.content) == Array(repeating: "updated", count: entryCount))
    }

    @Test func machineStoreApplyUsesOrderedTranscriptWithoutRemoveAll() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/RemiKit/Store/MachineStore.swift"),
            encoding: .utf8
        )
        let applyStart = try #require(source.range(of: "private static func apply("))
        let applySource = source[applyStart.lowerBound...]
        let nextMethod = try #require(applySource.range(of: "\n    /// Whether the key"))
        let applyBody = String(applySource[..<nextMethod.lowerBound])

        #expect(applyBody.contains("transcript.apply(message)"))
        #expect(!applyBody.contains("removeAll"))
    }
}
