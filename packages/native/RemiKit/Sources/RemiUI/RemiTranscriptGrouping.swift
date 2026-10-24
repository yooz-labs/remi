import Foundation

/// A run of consecutive tool entries shown as one expandable row (#1647).
public struct RemiToolGroup: Identifiable, Equatable, Sendable {
    /// Stable while entries are appended: it comes from the first entry of the run, and a
    /// run only grows at its end. Prepended history or a pin that splits the run changes
    /// it, so expansion is tracked by entry ids, not by this id.
    public let id: String
    public let entries: [RemiTranscriptEntry]
    /// Distinct tool names in order of first use, escaped for display.
    public let toolNames: [String]
    /// "shell, read, edit", cut to the first few names with a count of the rest.
    public let subtitle: String

    public init(entries: [RemiTranscriptEntry]) {
        self.entries = entries
        id = "tool-group:" + (entries.first?.id ?? "")
        var seen = Set<String>()
        var names: [String] = []
        for entry in entries {
            guard case .tool(_, let name, _) = entry else { continue }
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            let shown = RemiDisplayText.escape(trimmed.isEmpty ? "Tool" : trimmed)
            if seen.insert(shown).inserted { names.append(shown) }
        }
        toolNames = names
        let limit = RemiTranscriptGrouping.maximumNamedTools
        subtitle = names.count > limit
            ? names.prefix(limit).joined(separator: ", ") + ", +\(names.count - limit) more"
            : names.joined(separator: ", ")
    }

    public var count: Int { entries.count }

    /// "12 tool calls".
    public var title: String { RemiTranscriptGrouping.title(count: count) }
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

/// What `RemiTranscriptGrouping.rows` depends on, so a screen regroups only when it changes.
public struct RemiTranscriptGroupingInput: Equatable, Sendable {
    public let entries: [RemiTranscriptEntry]
    public let pinnedEntryIDs: Set<String>

    public init(entries: [RemiTranscriptEntry], pinnedEntryIDs: Set<String>) {
        self.entries = entries
        self.pinnedEntryIDs = pinnedEntryIDs
    }

    public var rows: [RemiTranscriptRow] {
        RemiTranscriptGrouping.rows(for: entries, pinnedEntryIDs: pinnedEntryIDs)
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

    /// Whether a group is open. A group is open when any of its entries is in
    /// `expandedEntryIDs`, so it stays open when a pin splits its run, when history is
    /// prepended (its id changes), or when entries are appended.
    public static func isExpanded(_ group: RemiToolGroup, in expandedEntryIDs: Set<String>) -> Bool {
        group.entries.contains { expandedEntryIDs.contains($0.id) }
    }

    /// `expandedEntryIDs` after the person opens or closes `group`.
    public static func toggled(_ group: RemiToolGroup, in expandedEntryIDs: Set<String>) -> Set<String> {
        var result = expandedEntryIDs
        let ids = group.entries.map(\.id)
        if isExpanded(group, in: expandedEntryIDs) {
            result.subtract(ids)
        } else {
            result.formUnion(ids)
        }
        return result
    }

    /// The id of the row that shows `entryID`: the entry's own id, or the id of the
    /// collapsed group that hides it. Nil when no row holds the entry. Scroll and jump
    /// targets go through this so they never point at a row that is not there.
    public static func rowID(
        for entryID: String,
        in rows: [RemiTranscriptRow],
        expanded expandedEntryIDs: Set<String>
    ) -> String? {
        for row in rows {
            switch row {
            case .entry(let entry):
                if entry.id == entryID { return entryID }
            case .toolGroup(let group):
                guard group.entries.contains(where: { $0.id == entryID }) else { continue }
                return isExpanded(group, in: expandedEntryIDs) ? entryID : group.id
            }
        }
        return nil
    }

    public static func title(count: Int) -> String { "\(count) tool calls" }

    public static func accessibilityLabel(count: Int, isExpanded: Bool) -> String {
        "\(title(count: count)), \(isExpanded ? "expanded" : "collapsed")"
    }

    public static func accessibilityHint(isExpanded: Bool) -> String {
        isExpanded ? "Hides the individual tool calls" : "Shows the individual tool calls"
    }
}
