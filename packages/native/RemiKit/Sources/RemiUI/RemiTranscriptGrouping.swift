import Foundation

/// A run of consecutive tool entries shown as one expandable row (#1647).
public struct RemiToolGroup: Identifiable, Equatable, Sendable {
    /// Stable while entries are appended: it comes from the first entry of the run, and a
    /// run only grows at its end.
    public let id: String
    public let entries: [RemiTranscriptEntry]

    public init(entries: [RemiTranscriptEntry]) {
        self.entries = entries
        id = "tool-group:" + (entries.first?.id ?? "")
    }

    public var count: Int { entries.count }

    /// Distinct tool names in order of first use, escaped for display.
    public var toolNames: [String] {
        var seen = Set<String>()
        var names: [String] = []
        for entry in entries {
            guard case .tool(_, let name, _) = entry else { continue }
            let shown = RemiDisplayText.escape(
                name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Tool" : name
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            )
            if seen.insert(shown).inserted { names.append(shown) }
        }
        return names
    }

    /// "12 tool calls".
    public var title: String { RemiTranscriptGrouping.title(count: count) }

    /// "shell, read, edit", cut to the first few names with a count of the rest.
    public var subtitle: String {
        let names = toolNames
        let limit = RemiTranscriptGrouping.maximumNamedTools
        guard names.count > limit else { return names.joined(separator: ", ") }
        return names.prefix(limit).joined(separator: ", ") + ", +\(names.count - limit) more"
    }
}

/// One row of the transcript after grouping.
public enum RemiTranscriptRow: Identifiable, Equatable, Sendable {
    case entry(RemiTranscriptEntry)
    case toolGroup(RemiToolGroup)

    public var id: String {
        switch self {
        case .entry(let entry): entry.id
        case .toolGroup(let group): group.id
        }
    }
}

public enum RemiTranscriptGrouping {
    /// A run shorter than this stays as individual rows.
    public static let minimumRun = 3
    /// The most tool names the subtitle lists before "+N more".
    public static let maximumNamedTools = 3

    /// Groups each run of `minimumRun` or more consecutive tool entries.
    ///
    /// Entries in `pinnedEntryIDs` (search matches, the selected result) and the newest
    /// entry are never grouped: they split a run, so jump-to-latest and search navigation
    /// always find a visible row with the entry's own id. Order is preserved, and no entry
    /// is dropped.
    public static func rows(
        for entries: [RemiTranscriptEntry],
        pinnedEntryIDs: Set<String> = []
    ) -> [RemiTranscriptRow] {
        let newestID = entries.last?.id
        var rows: [RemiTranscriptRow] = []
        var run: [RemiTranscriptEntry] = []

        func flush() {
            if run.count >= minimumRun {
                rows.append(.toolGroup(RemiToolGroup(entries: run)))
            } else {
                rows.append(contentsOf: run.map(RemiTranscriptRow.entry))
            }
            run.removeAll()
        }

        for entry in entries {
            if case .tool = entry, entry.id != newestID, !pinnedEntryIDs.contains(entry.id) {
                run.append(entry)
            } else {
                flush()
                rows.append(.entry(entry))
            }
        }
        flush()
        return rows
    }

    public static func title(count: Int) -> String { "\(count) tool calls" }

    public static func accessibilityLabel(count: Int, isExpanded: Bool) -> String {
        "\(title(count: count)), \(isExpanded ? "expanded" : "collapsed")"
    }

    public static func accessibilityHint(isExpanded: Bool) -> String {
        isExpanded ? "Hides the individual tool calls" : "Shows the individual tool calls"
    }
}
