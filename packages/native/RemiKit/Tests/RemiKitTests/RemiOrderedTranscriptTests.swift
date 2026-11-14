import Foundation
import Testing
@testable import RemiKit

@MainActor
struct RemiOrderedTranscriptTests {
    private func message(_ id: String, _ content: String) throws -> TranscriptContentMessage {
        try SessionAddressingTests().entry(sessionID: "ordered-transcript-test", id: id, text: content)
    }

    @Test func emptyTranscriptHasNoEntries() {
        let transcript = RemiOrderedTranscript()
        #expect(transcript.entries.isEmpty)
        #expect(transcript.count == 0)
        #expect(transcript.suffix(0).isEmpty)
        #expect(transcript.suffix(4).isEmpty)
    }

    @Test func newEntriesAppendInOrder() throws {
        let first = try message("a", "first")
        let second = try message("b", "second")
        let transcript = RemiOrderedTranscript()

        transcript.apply(first)
        transcript.apply(second)

        #expect(transcript.count == 2)
        #expect(transcript.entries == [first, second])
    }

    @Test func duplicateReplacesAndMovesToTheEnd() throws {
        let first = try message("a", "first")
        let second = try message("b", "second")
        let third = try message("c", "third")
        let replacement = try message("a", "updated")
        let transcript = RemiOrderedTranscript()
        for entry in [first, second, third, replacement] { transcript.apply(entry) }

        #expect(transcript.count == 3)
        #expect(transcript.entries == [second, third, replacement])
    }

    @Test func interleavedDuplicatesKeepLastReplacementOrder() throws {
        let firstA = try message("a", "a1")
        let firstB = try message("b", "b1")
        let firstC = try message("c", "c1")
        let secondB = try message("b", "b2")
        let secondA = try message("a", "a2")
        let transcript = RemiOrderedTranscript()
        for entry in [firstA, firstB, firstC, secondB, secondA] { transcript.apply(entry) }

        #expect(transcript.entries == [firstC, secondB, secondA])
    }

    @Test func compactionKeepsOrderAndSupportsUpdatesAndAppendsAfterward() throws {
        let initial = try (0..<64).map { index in
            try message("entry-\(index)", "initial-\(index)")
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
            transcript.apply(try message("entry-\(index)", "replacement-\(index)"))
        }

        #expect(transcript.count == 64)
        #expect(transcript.map(\.entryUuid) == replacementOrder.map { "entry-\($0)" })

        for index in [10, 20, 30, 40, 50, 60] {
            transcript.apply(try message("entry-\(index)", "after-compaction-\(index)"))
        }
        for index in [64, 65] {
            transcript.apply(try message("entry-\(index)", "new-\(index)"))
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
        let history = try (0..<200).map { index in
            try message("entry-\(index)", "message-\(index)")
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
        let history = try (0..<4).map { index in
            try message("entry-\(index)", "message-\(index)")
        }
        let singlePass = RemiOrderedTranscript()
        let replayed = RemiOrderedTranscript()
        for entry in history { singlePass.apply(entry) }
        for entry in history { replayed.apply(entry) }
        for entry in history { replayed.apply(entry) }

        #expect(replayed.entries == singlePass.entries)
    }

    @Test func suffixReturnsTheNewestEntriesInOrder() throws {
        let history = try (0..<4).map { index in
            try message("entry-\(index)", "message-\(index)")
        }
        let transcript = RemiOrderedTranscript()
        for entry in history { transcript.apply(entry) }

        #expect(transcript.count == history.count)
        #expect(transcript.suffix(0).isEmpty)
        #expect(transcript.suffix(2) == Array(history.suffix(2)))
        #expect(transcript.suffix(history.count + 2) == history)
    }

    // The counter is self-reported, so the source guard also rejects common uncounted scans.
#if DEBUG
    @Test(arguments: [1_000, 4_000])
    func replayedDuplicatesUseLinearElementWork(_ entryCount: Int) throws {
        let history = try (0..<entryCount).map { index in
            try message("entry-\(index)", "message-\(index)")
        }
        let transcript = RemiOrderedTranscript()
        for entry in history { transcript.apply(entry) }
        let visitsBeforeReplay = transcript.testingElementVisits

        for entry in history {
            transcript.apply(try message(entry.entryUuid, "updated"))
        }

        let replayVisits = transcript.testingElementVisits - visitsBeforeReplay
        #expect(replayVisits < entryCount * 5)
        #expect(transcript.map(\.entryUuid) == history.map(\.entryUuid))
        #expect(transcript.map(\.content) == Array(repeating: "updated", count: entryCount))
    }
#endif

    @Test func machineStoreTranscriptPathsUseTheOrderedStore() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let machineStore = try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/RemiKit/Store/MachineStore.swift"),
            encoding: .utf8
        )
        let orderedStore = try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/RemiKit/RemiOrderedTranscript.swift"),
            encoding: .utf8
        )
        let receiveStart = try #require(machineStore.range(of: "case .transcript(let message):"))
        let receiveSource = machineStore[receiveStart.lowerBound...]
        let receiveEnd = try #require(receiveSource.range(of: "\n        case .sessionViews"))
        let receiveBody = String(receiveSource[..<receiveEnd.lowerBound])

        let finishStart = try #require(machineStore.range(of: "private func finishTranscriptLoad("))
        let finishSource = machineStore[finishStart.lowerBound...]
        let finishEnd = try #require(finishSource.range(of: "\n    /// Whether the key"))
        let finishBody = String(finishSource[..<finishEnd.lowerBound])
        let transcriptCode = codeLines(orderedStore)
        // Membership in the loading set is constant-time and is not a transcript scan.
        let storeCode = codeLines(receiveBody + "\n" + finishBody)
            .replacingOccurrences(of: "transcriptsLoading.contains(key)", with: "")

        for forbidden in ["removeAll", "firstIndex", ".contains(", "remove(at:"] {
            #expect(!transcriptCode.contains(forbidden), "ordered transcript must not scan with \(forbidden)")
            #expect(!storeCode.contains(forbidden), "MachineStore transcript paths must not scan with \(forbidden)")
        }
        let indexZeroInsert = try NSRegularExpression(pattern: #"\.insert\([^)]*\bat:\s*0\s*\)"#)
        let fullStoreRange = NSRange(storeCode.startIndex..<storeCode.endIndex, in: storeCode)
        #expect(indexZeroInsert.firstMatch(in: storeCode, range: fullStoreRange) == nil)
        #expect(receiveBody.components(separatedBy: "transcript.apply(").count - 1 == 2)
        #expect(finishBody.contains("transcript.apply(message)"))
        #expect(!transcriptCode.isEmpty)
    }

    private func codeLines(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { line in
                let code = line.drop(while: { $0 == " " || $0 == "\t" })
                return !code.hasPrefix("//")
            }
            .joined(separator: "\n")
    }
}
