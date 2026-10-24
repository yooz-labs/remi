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

    private func firstGroup(_ rows: [RemiTranscriptRow]) -> RemiToolGroup? {
        for row in rows {
            if case .toolGroup(let group) = row { return group }
        }
        return nil
    }

    @Test func rowIDMapsAHiddenEntryToItsCollapsedGroup() {
        let rows = RemiTranscriptGrouping.rows(for: [message] + tools(5) + [message])
        let groupID = "tool-group:t1"
        #expect(RemiTranscriptGrouping.rowID(for: "t3", in: rows, expanded: []) == groupID)
        #expect(RemiTranscriptGrouping.rowID(for: "t1", in: rows, expanded: []) == groupID)
        #expect(RemiTranscriptGrouping.rowID(for: "a", in: rows, expanded: []) == "a")
        #expect(RemiTranscriptGrouping.rowID(for: "missing", in: rows, expanded: []) == nil)
    }

    @Test func rowIDIsTheEntryItselfOnceTheGroupIsOpen() {
        let rows = RemiTranscriptGrouping.rows(for: [message] + tools(5) + [message])
        #expect(RemiTranscriptGrouping.rowID(for: "t3", in: rows, expanded: ["t2"]) == "t3")
    }

    @Test func togglingOpensAndClosesAGroup() throws {
        let rows = RemiTranscriptGrouping.rows(for: tools(5) + [message])
        let group = try #require(firstGroup(rows))
        let opened = RemiTranscriptGrouping.toggled(group, in: [])
        #expect(RemiTranscriptGrouping.isExpanded(group, in: opened))
        let closed = RemiTranscriptGrouping.toggled(group, in: opened)
        #expect(closed.isEmpty)
        #expect(!RemiTranscriptGrouping.isExpanded(group, in: closed))
    }

    @Test func expansionSurvivesAPinAtTheStartOfTheRun() throws {
        let entries = tools(6) + [message]
        let open = RemiTranscriptGrouping.toggled(try #require(firstGroup(RemiTranscriptGrouping.rows(for: entries))), in: [])
        let pinned = RemiTranscriptGrouping.rows(for: entries, pinnedEntryIDs: ["t1"])
        let group = try #require(firstGroup(pinned))
        #expect(group.id == "tool-group:t2")
        #expect(RemiTranscriptGrouping.isExpanded(group, in: open))
    }

    @Test func expansionSurvivesAPinInTheMiddleOfTheRun() throws {
        let entries = tools(9) + [message]
        let open = RemiTranscriptGrouping.toggled(try #require(firstGroup(RemiTranscriptGrouping.rows(for: entries))), in: [])
        let groups = RemiTranscriptGrouping.rows(for: entries, pinnedEntryIDs: ["t5"]).compactMap { row -> RemiToolGroup? in
            if case .toolGroup(let group) = row { group } else { nil }
        }
        #expect(groups.count == 2)
        #expect(groups.allSatisfy { RemiTranscriptGrouping.isExpanded($0, in: open) })
    }

    @Test func expansionSurvivesPrependedHistoryAndAppendedEntries() throws {
        let entries = tools(5) + [message]
        let open = RemiTranscriptGrouping.toggled(try #require(firstGroup(RemiTranscriptGrouping.rows(for: entries))), in: [])
        let older = RemiTranscriptGrouping.rows(for: tools(3, prefix: "old") + entries)
        let grown = try #require(firstGroup(older))
        #expect(grown.id == "tool-group:old1")
        #expect(RemiTranscriptGrouping.isExpanded(grown, in: open))
        let appended = try #require(firstGroup(RemiTranscriptGrouping.rows(for: tools(5) + [tool("t6"), message])))
        #expect(RemiTranscriptGrouping.isExpanded(appended, in: open))
    }

    @Test func aRestoredPositionInsideACollapsedRunMapsToItsGroup() {
        let entries = [message] + tools(6) + [message]
        #expect(RemiTranscriptGrouping.restoredRowID("t4", entries: entries) == "tool-group:t1")
        #expect(RemiTranscriptGrouping.restoredRowID("t4", entries: entries, expanded: ["t2"]) == "t4")
        #expect(RemiTranscriptGrouping.restoredRowID("t4", entries: entries, pinnedEntryIDs: ["t4"]) == "t4")
        #expect(RemiTranscriptGrouping.restoredRowID("a", entries: entries) == "a")
        #expect(RemiTranscriptGrouping.restoredRowID("gone", entries: entries) == "gone")
        #expect(RemiTranscriptGrouping.restoredRowID(nil, entries: entries) == nil)
    }

    @Test func aDifferentGroupStaysClosed() throws {
        let entries = tools(4, prefix: "p") + [message] + tools(4, prefix: "q") + [message]
        let groups = RemiTranscriptGrouping.rows(for: entries).compactMap { row -> RemiToolGroup? in
            if case .toolGroup(let group) = row { group } else { nil }
        }
        let open = RemiTranscriptGrouping.toggled(groups[0], in: [])
        #expect(!RemiTranscriptGrouping.isExpanded(groups[1], in: open))
    }
}
