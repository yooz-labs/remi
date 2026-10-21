import Foundation

/// The drawer's session list: Needs you, Active and Recent.
///
/// Needs you is the live sessions whose status is `needsYou` or that hold an open
/// question; Active is the other live sessions; Recent is every session that is not live.
/// Each group is newest activity first, ties by name and then id, so the order is stable.
public struct RemiSessionGrouping: Equatable, Sendable {
    public let needsYou: [RemiSessionSummary]
    public let active: [RemiSessionSummary]
    public let recent: [RemiSessionSummary]

    public init(sessions: [RemiSessionSummary]) {
        let live = sessions.filter(\.isLive)
        needsYou = Self.sorted(live.filter { $0.status == .needsYou || $0.openQuestionCount > 0 })
        active = Self.sorted(live.filter { $0.status != .needsYou && $0.openQuestionCount <= 0 })
        recent = Self.sorted(sessions.filter { !$0.isLive })
    }

    public var isEmpty: Bool { needsYou.isEmpty && active.isEmpty && recent.isEmpty }

    public var flattened: [RemiSessionSummary] { needsYou + active + recent }

    /// This grouping's rows laid out as `snapshot` was: the snapshot's section membership
    /// and order, each row the latest summary for its id, so badges and status update in
    /// place while the list stays still. Sessions not in the snapshot are appended to the
    /// end of their current section, in this grouping's order; sessions that no longer
    /// exist here are dropped.
    public func frozen(to snapshot: RemiSessionGrouping) -> RemiSessionGrouping {
        let latest = Dictionary(flattened.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let known = Set(snapshot.flattened.map(\.id))
        func section(_ old: [RemiSessionSummary], current: [RemiSessionSummary]) -> [RemiSessionSummary] {
            old.compactMap { latest[$0.id] } + current.filter { !known.contains($0.id) }
        }
        return RemiSessionGrouping(
            needsYou: section(snapshot.needsYou, current: needsYou),
            active: section(snapshot.active, current: active),
            recent: section(snapshot.recent, current: recent)
        )
    }

    private init(needsYou: [RemiSessionSummary], active: [RemiSessionSummary], recent: [RemiSessionSummary]) {
        self.needsYou = needsYou
        self.active = active
        self.recent = recent
    }

    private static func sorted(_ sessions: [RemiSessionSummary]) -> [RemiSessionSummary] {
        sessions.sorted { lhs, rhs in
            let left = lhs.lastActivity ?? ""
            let right = rhs.lastActivity ?? ""
            if left != right { return left > right }
            let byName = lhs.name.localizedCaseInsensitiveCompare(rhs.name)
            if byName != .orderedSame { return byName == .orderedAscending }
            return lhs.id < rhs.id
        }
    }
}
