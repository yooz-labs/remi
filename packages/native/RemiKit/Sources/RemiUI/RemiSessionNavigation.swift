import Foundation

/// Moving between sessions from the keyboard, in the order the drawer lists them.
public enum RemiSessionNavigation {
    /// The live session `offset` places from `current` in the drawer's order (Needs you,
    /// Active), wrapping at either end. Stored sessions are skipped: opening one needs
    /// Resume. With no current session, a step forward lands on the first and a step back
    /// on the last. `machineKey` narrows the cycle the way the drawer's machine filter does.
    public static func shifted(
        from current: RemiSessionKey?,
        in sessions: [RemiSessionSummary],
        machineKey: String?,
        offset: Int
    ) -> RemiSessionSummary? {
        let ordered = RemiSessionGrouping(
            sessions: RemiSessionFilter.apply(to: sessions, query: "", machineKey: machineKey)
        ).flattened.filter(\.isLive)
        let target = RemiOrderedSelection.shifted(
            selection: current,
            orderedIDs: ordered.map(\.key),
            offset: offset
        )
        return ordered.first { $0.key == target }
    }
}
