import Foundation

/// The short title a session shows in rows and screen titles (#1647).
///
/// A hub names a session `<machine>:<project>/<branch>`, so beside the machine's own name
/// the prefix only repeats. The short title drops that prefix. The full name stays for
/// accessibility labels and for search; the short title is always a part of the full name,
/// so a query for either form finds the session.
///
/// Both inputs are display text already escaped by `RemiSessionSummary`, so the prefix is
/// compared as shown. Machines that share a display name are told apart by their unique
/// label (`RemiMachineStripPresentation.uniqueLabels`), which rows show beside the title;
/// the prefix is the session's own machine name, so stripping never mixes them up.
public enum RemiSessionTitle {
    /// `name` without a leading `<machineName>:`. The match is exact and case-sensitive,
    /// and applies only when something other than whitespace would remain; otherwise
    /// `name` is returned unchanged.
    public static func short(name: String, machineName: String) -> String {
        guard !machineName.isEmpty else { return name }
        let prefix = machineName + ":"
        guard name.hasPrefix(prefix) else { return name }
        let rest = String(name.dropFirst(prefix.count))
        let trimmed = rest.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? name : trimmed
    }
}

extension RemiSessionSummary {
    /// The title rows and screen titles show; `name` stays the full name for
    /// accessibility and search.
    public var displayTitle: String {
        RemiSessionTitle.short(name: name, machineName: machineName)
    }
}
