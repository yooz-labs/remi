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
