import Testing
@testable import RemiUI

@Suite struct RemiTranscriptGroupingTests {
    private func tool(_ id: String, _ name: String = "shell") -> RemiTranscriptEntry {
        .tool(id: id, name: name, summary: "summary \(id)")
    }

    private func tools(_ count: Int, prefix: String = "t") -> [RemiTranscriptEntry] {
        (1...count).map { tool("\(prefix)\($0)") }
    }

    private func shape(_ rows: [RemiTranscriptRow]) -> [String] {
        rows.map { row in
            switch row {
            case .entry(let entry): entry.id
            case .toolGroup(let group): "[\(group.count)]"
            }
        }
    }

    private let message = RemiTranscriptEntry.agent(id: "a", text: "hello")

    @Test func runsOfOneAndTwoStayIndividual() {
        #expect(shape(RemiTranscriptGrouping.rows(for: [message] + tools(2) + [message])) == ["a", "t1", "t2", "a"])
        #expect(shape(RemiTranscriptGrouping.rows(for: [tool("x"), message, tool("y"), message])) == ["x", "a", "y", "a"])
    }

    @Test func aRunOfThreeGroups() {
        let entries = [message] + tools(3) + [message]
        let rows = RemiTranscriptGrouping.rows(for: entries)
        #expect(shape(rows) == ["a", "[3]", "a"])
        guard case .toolGroup(let group) = rows[1] else { Issue.record("no group"); return }
        #expect(group.entries.map(\.id) == ["t1", "t2", "t3"])
        #expect(group.title == "3 tool calls")
    }

    @Test func separateRunsAreSeparateGroupsAndBoundariesHold() {
        let entries = tools(4, prefix: "p") + [message] + tools(3, prefix: "q") + [.user(id: "u", text: "hi")] + tools(2, prefix: "r")
        #expect(shape(RemiTranscriptGrouping.rows(for: entries)) == ["[4]", "a", "[3]", "u", "r1", "r2"])
    }

    @Test func noEntryIsDroppedOrReordered() {
        let entries = tools(5, prefix: "a") + [message] + tools(7, prefix: "b")
        let flattened = RemiTranscriptGrouping.rows(for: entries).flatMap { row -> [String] in
            switch row {
            case .entry(let entry): [entry.id]
            case .toolGroup(let group): group.entries.map(\.id)
            }
        }
        #expect(flattened == entries.map(\.id))
    }

    @Test func theNewestEntryIsNeverHidden() {
        let rows = RemiTranscriptGrouping.rows(for: tools(12))
        #expect(shape(rows) == ["[11]", "t12"])
        // With two entries before the newest, the run is too short to group.
        #expect(shape(RemiTranscriptGrouping.rows(for: tools(3))) == ["t1", "t2", "t3"])
    }

    @Test func pinnedEntriesSplitARun() {
        let rows = RemiTranscriptGrouping.rows(for: tools(9) + [message], pinnedEntryIDs: ["t5"])
        #expect(shape(rows) == ["[4]", "t5", "[4]", "a"])
        let pinnedAtEdge = RemiTranscriptGrouping.rows(for: tools(5) + [message], pinnedEntryIDs: ["t1"])
        #expect(shape(pinnedAtEdge) == ["t1", "[4]", "a"])
    }

    @Test func pinningSplitsARunIntoShortRunsThatStayIndividual() {
        let rows = RemiTranscriptGrouping.rows(for: tools(5) + [message], pinnedEntryIDs: ["t3"])
        #expect(shape(rows) == ["t1", "t2", "t3", "t4", "t5", "a"])
    }

    @Test func groupIDIsStableWhileEntriesAreAppended() {
        func firstGroupID(_ entries: [RemiTranscriptEntry]) -> String? {
            for row in RemiTranscriptGrouping.rows(for: entries) {
                if case .toolGroup(let group) = row { return group.id }
            }
            return nil
        }
        let base = tools(4)
        let id = firstGroupID(base + [message])
        #expect(id == "tool-group:t1")
        #expect(firstGroupID(base + [tool("t5")] + [message]) == id)
        #expect(firstGroupID(base + tools(3, prefix: "z") + [message, message]) == id)
        #expect(firstGroupID(base + [message, message, tool("n")]) == id)
    }

    @Test func subtitleListsDistinctNamesInOrderAndTruncates() {
        let entries = [tool("1", "shell"), tool("2", "read"), tool("3", "shell"), tool("4", "edit"), message]
        guard case .toolGroup(let group) = RemiTranscriptGrouping.rows(for: entries)[0] else {
            Issue.record("no group"); return
        }
        #expect(group.toolNames == ["shell", "read", "edit"])
        #expect(group.subtitle == "shell, read, edit")

        let many = ["a", "b", "c", "d", "e"].enumerated().map { tool("\($0.offset)", $0.element) } + [message]
        guard case .toolGroup(let long) = RemiTranscriptGrouping.rows(for: many)[0] else {
            Issue.record("no group"); return
        }
        #expect(long.subtitle == "a, b, c, +2 more")
    }

    @Test func toolNamesAreEscapedAndBlankNamesFallBack() {
        let entries = [tool("1", "bad\u{202E}name"), tool("2", "  "), tool("3", "x"), message]
        guard case .toolGroup(let group) = RemiTranscriptGrouping.rows(for: entries)[0] else {
            Issue.record("no group"); return
        }
        #expect(group.toolNames.count == 3)
        #expect(group.toolNames[1] == "Tool")
        #expect(!group.subtitle.contains("\u{202E}"))
    }

    @Test func accessibilityStrings() {
        #expect(RemiTranscriptGrouping.accessibilityLabel(count: 12, isExpanded: false) == "12 tool calls, collapsed")
        #expect(RemiTranscriptGrouping.accessibilityLabel(count: 3, isExpanded: true) == "3 tool calls, expanded")
        #expect(RemiTranscriptGrouping.accessibilityHint(isExpanded: false) == "Shows the individual tool calls")
    }

    @Test func emptyInputGivesNoRows() {
        #expect(RemiTranscriptGrouping.rows(for: []).isEmpty)
    }
}
