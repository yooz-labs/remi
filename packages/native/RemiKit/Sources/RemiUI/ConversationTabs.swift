import RemiKit

/// Which of a session's conversations are tabs and which are in the "Earlier" menu.
///
/// Main is always first and is not in the list. A tab is a conversation that is running, plus the
/// open one if it has finished, so what is running is one tap away and the open conversation never
/// disappears from under the person. The rest are finished and go to the menu. A long session can
/// have dozens of finished subagents, which must not push the running ones out of sight.
public struct RemiConversationTabs: Equatable, Sendable {
    /// The running conversations, and the open one if it has finished, in the session's order.
    public let tabs: [SessionViewMeta]
    /// Finished conversations other than the open one, in the session's order.
    public let earlier: [SessionViewMeta]
    private let all: [SessionViewMeta]

    public init(views: [SessionViewMeta], selectedViewID: String) {
        // One entry per agent: a repeated id would give the list two rows with one identity.
        var seen = Set<String>()
        let unique = views.filter { seen.insert($0.agentId).inserted }
        all = unique
        tabs = unique.filter { $0.active || $0.agentId == selectedViewID }
        earlier = unique.filter { !$0.active && $0.agentId != selectedViewID }
    }

    /// The agent's type, numbered when two share it ("general-purpose 2"), rather than the id
    /// suffix `RemiConversationSelection.title` adds, which is long and means nothing to the
    /// person. The number follows the agents' ids, not their place in the list: the daemon lists
    /// running agents first, so a place in the list changes when an agent finishes and two agents
    /// would swap names under the person. Types are compared without regard to case.
    public func title(for view: SessionViewMeta) -> String {
        let base = RemiConversationSelection.title(for: view, among: [view])
        let sameType = all
            .filter { RemiConversationSelection.title(for: $0, among: [$0]).localizedCaseInsensitiveCompare(base) == .orderedSame }
            .sorted { $0.agentId < $1.agentId }
        guard sameType.count > 1, let index = sameType.firstIndex(where: { $0.agentId == view.agentId }) else {
            return base
        }
        return "\(base) \(index + 1)"
    }
}
