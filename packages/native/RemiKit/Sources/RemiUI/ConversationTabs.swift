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
        all = views
        tabs = views.filter { $0.active || $0.agentId == selectedViewID }
        earlier = views.filter { !$0.active && $0.agentId != selectedViewID }
    }

    /// The agent's type, numbered when two share it ("general-purpose 2"), rather than the id
    /// suffix `RemiConversationSelection.title` adds, which is long and means nothing to the
    /// person. Numbered by position among all the session's agents, so a number does not change
    /// as tabs come and go.
    public func title(for view: SessionViewMeta) -> String {
        let base = RemiConversationSelection.title(for: view, among: [view])
        let sameType = all.filter { RemiConversationSelection.title(for: $0, among: [$0]) == base }
        guard sameType.count > 1, let index = sameType.firstIndex(where: { $0.agentId == view.agentId }) else {
            return base
        }
        return "\(base) \(index + 1)"
    }
}
