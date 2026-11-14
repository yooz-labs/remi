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

    @Test func compactionKeepsOrderAndSupportsUpdatesAndAppendsAfterward() throws {
        let template = try fixtureTemplate()
        let initial = try (0..<64).map { index in
            try message(template: template, id: "entry-\(index)", content: "initial-\(index)")
        }
        let transcript = RemiOrderedTranscript()
        for entry in initial { transcript.apply(entry) }

        let replacementOrder = [
            1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31,
            33, 35, 37, 39, 41, 43, 45, 47, 49, 51, 53, 55, 57, 59, 61, 63,
            0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30,
            32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62,
        ]
        for index in replacementOrder {
            transcript.apply(try message(
                template: template,
                id: "entry-\(index)",
                content: "replacement-\(index)"
            ))
        }

        #expect(transcript.count == 64)
        #expect(transcript.map(\.entryUuid) == replacementOrder.map { "entry-\($0)" })

        for index in [10, 20, 30, 40, 50, 60] {
            transcript.apply(try message(
                template: template,
                id: "entry-\(index)",
                content: "after-compaction-\(index)"
            ))
        }
        for index in [64, 65] {
            transcript.apply(try message(
                template: template,
                id: "entry-\(index)",
                content: "new-\(index)"
            ))
        }

        let expectedOrder = [
            "entry-1", "entry-3", "entry-5", "entry-7", "entry-9", "entry-11", "entry-13", "entry-15",
            "entry-17", "entry-19", "entry-21", "entry-23", "entry-25", "entry-27", "entry-29", "entry-31",
            "entry-33", "entry-35", "entry-37", "entry-39", "entry-41", "entry-43", "entry-45", "entry-47",
            "entry-49", "entry-51", "entry-53", "entry-55", "entry-57", "entry-59", "entry-61", "entry-63",
            "entry-0", "entry-2", "entry-4", "entry-6", "entry-8", "entry-12", "entry-14", "entry-16",
            "entry-18", "entry-22", "entry-24", "entry-26", "entry-28", "entry-32", "entry-34", "entry-36",
            "entry-38", "entry-42", "entry-44", "entry-46", "entry-48", "entry-52", "entry-54", "entry-56",
            "entry-58", "entry-62", "entry-10", "entry-20", "entry-30", "entry-40", "entry-50", "entry-60",
            "entry-64", "entry-65",
        ]
        let actualOrder = transcript.map(\.entryUuid)
        #expect(transcript.count == 66)
        #expect(actualOrder == expectedOrder)
        #expect(Set(actualOrder).count == actualOrder.count)
        #expect(transcript.suffix(5).map(\.entryUuid) == [
            "entry-40", "entry-50", "entry-60", "entry-64", "entry-65",
        ])
    }

    @Test func secondReplayRunsOverCompactedHistoryWithoutDuplicates() throws {
        let template = try fixtureTemplate()
        let history = try (0..<200).map { index in
            try message(template: template, id: "entry-\(index)", content: "message-\(index)")
        }
        let singlePass = RemiOrderedTranscript()
        let replayed = RemiOrderedTranscript()
        for entry in history { singlePass.apply(entry) }
        for entry in history { replayed.apply(entry) }
        for entry in history { replayed.apply(entry) }
        for entry in history { replayed.apply(entry) }

        #expect(replayed.count == history.count)
        #expect(replayed.entries == singlePass.entries)
        #expect(replayed.suffix(5) == Array(history.suffix(5)))
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

    @Test func machineStoreTranscriptPathsUseTheOrderedStore() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/RemiKit/Store/MachineStore.swift"),
            encoding: .utf8
        )
        let receiveStart = try #require(source.range(of: "case .transcript(let message):"))
        let receiveSource = source[receiveStart.lowerBound...]
        let receiveEnd = try #require(receiveSource.range(of: "\n        case .sessionViews"))
        let receiveBody = String(receiveSource[..<receiveEnd.lowerBound])

        let finishStart = try #require(source.range(of: "private func finishTranscriptLoad("))
        let finishSource = source[finishStart.lowerBound...]
        let finishEnd = try #require(finishSource.range(of: "\n    /// Whether the key"))
        let finishBody = String(finishSource[..<finishEnd.lowerBound])

        #expect(receiveBody.contains("staged.apply(message)"))
        #expect(receiveBody.contains("transcript.apply(message)"))
        #expect(finishBody.contains("transcript.apply(message)"))
        #expect(!receiveBody.contains("removeAll"))
        #expect(!finishBody.contains("removeAll"))
    }
}
