import Testing
@testable import RemiUI

@Suite struct RemiTranscriptDisplayRowsTests {
    private func tool(_ id: String) -> RemiTranscriptEntry {
        .tool(id: id, name: "shell", summary: "summary \(id)")
    }

    // This is the original view's expansion semantics, kept independent of the new helper.
    private func originalShape(_ rows: [RemiTranscriptRow], expanded: Set<String>) -> [String] {
        rows.flatMap { row -> [String] in
            switch row {
            case .entry(let entry):
                ["entry:\(entry.id)"]
            case .toolGroup(let group):
                ["header:\(group.id):\(RemiTranscriptGrouping.isExpanded(group, in: expanded))"]
                    + (RemiTranscriptGrouping.isExpanded(group, in: expanded)
                       ? group.entries.map { "member:\($0.id)" } : [])
            }
        }
    }

    private func shape(_ rows: [RemiTranscriptDisplayRow]) -> [String] {
        rows.map { row in
            switch row {
            case .entry(let entry): "entry:\(entry.id)"
            case .groupHeader(let group, let isExpanded): "header:\(group.id):\(isExpanded)"
            case .groupMember(let entry): "member:\(entry.id)"
            }
        }
    }

    @Test func orderIDsAndExpansion() {
        let entries: [RemiTranscriptEntry] = [.user(id: "u", text: "hello")]
            + (1...4).map { tool("t\($0)") } + [.agent(id: "a", text: "done")]
        let rows = RemiTranscriptGrouping.rows(for: entries)
        let closed = RemiTranscriptGrouping.displayRows(for: rows, expanded: [])
        #expect(shape(closed) == ["entry:u", "header:tool-group:t1:false", "entry:a"])
        let open = RemiTranscriptGrouping.displayRows(for: rows, expanded: ["t3"])
        #expect(shape(open) == ["entry:u", "header:tool-group:t1:true", "member:t1", "member:t2", "member:t3", "member:t4", "entry:a"])
        #expect(open.map(\.id) == ["u", "tool-group:t1", "t1", "t2", "t3", "t4", "a"])
        #expect(Set(open.map(\.id)).count == open.count)
    }

    @Test func randomizedSequencesMatchOriginalAndScrollTargets() {
        var state: UInt64 = 0x1820
        func next(_ bound: UInt64) -> Int {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return Int((state >> 32) % bound)
        }
        for iteration in 0..<200 {
            var entries: [RemiTranscriptEntry] = []
            for i in 0..<next(100) {
                let id = "\(iteration)-\(i)"
                entries.append(next(4) == 0 ? .agent(id: id, text: "message") : tool(id))
            }
            let pins = Set(entries.filter { _ in next(11) == 0 }.map(\.id))
            let expanded = Set(entries.filter { _ in next(9) == 0 }.map(\.id))
            let rows = RemiTranscriptGrouping.rows(for: entries, pinnedEntryIDs: pins)
            let display = RemiTranscriptGrouping.displayRows(for: rows, expanded: expanded)
            #expect(shape(display) == originalShape(rows, expanded: expanded))
            #expect(Set(display.map(\.id)).count == display.count)
            for entry in entries {
                let expected = RemiTranscriptGrouping.rowID(for: entry.id, in: rows, expanded: expanded)
                let resolved = display.first { row in
                    switch row {
                    case .entry(let shown), .groupMember(let shown): shown.id == entry.id
                    case .groupHeader(let group, let open): !open && group.entries.contains { $0.id == entry.id }
                    }
                }?.id
                #expect(resolved == expected)
            }
            #expect(RemiTranscriptGrouping.rowID(for: "missing", in: rows, expanded: expanded) == nil)
        }
    }
}
