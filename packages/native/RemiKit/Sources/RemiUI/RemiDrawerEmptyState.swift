import Foundation

/// What the drawer's list shows in place of session rows, kept apart from the view so
/// the choice can be tested.
public enum RemiDrawerEmptyState: Equatable, Sendable {
    /// There are rows to show.
    case content
    /// No sessions at all, and nothing narrows the list: the Inbox row is all there is.
    case nothing
    /// A machine filter is on, there is no text query, and that machine has no sessions.
    case machineEmpty
    /// A text query is set and matches nothing, whatever the machine filter.
    case noMatch

    public static func resolve(visibleSessionCount: Int, query: String, isMachineFiltered: Bool) -> Self {
        if visibleSessionCount > 0 { return .content }
        if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .noMatch }
        return isMachineFiltered ? .machineEmpty : .nothing
    }
}
