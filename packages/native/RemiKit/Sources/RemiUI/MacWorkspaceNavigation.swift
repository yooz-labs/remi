import SwiftUI

public struct RemiMacColumnLayout: Equatable, Sendable {
    public let visibility: NavigationSplitViewVisibility
    public let expandedVisibility: NavigationSplitViewVisibility

    public init(
        visibility: NavigationSplitViewVisibility,
        expandedVisibility: NavigationSplitViewVisibility
    ) {
        self.visibility = visibility
        self.expandedVisibility = expandedVisibility
    }

    public func togglingMachines() -> Self {
        switch visibility {
        case .all:
            Self(visibility: .doubleColumn, expandedVisibility: .doubleColumn)
        case .doubleColumn:
            Self(visibility: .all, expandedVisibility: .all)
        default:
            Self(visibility: .all, expandedVisibility: .all)
        }
    }

    public func togglingNavigation() -> Self {
        if visibility == .detailOnly {
            return Self(visibility: expandedVisibility, expandedVisibility: expandedVisibility)
        }
        let remembered = visibility == .all || visibility == .doubleColumn
            ? visibility
            : expandedVisibility
        return Self(visibility: .detailOnly, expandedVisibility: remembered)
    }
}

public enum RemiOrderedSelection {
    public static func shifted<ID: Equatable>(
        selection: ID?,
        orderedIDs: [ID],
        offset: Int
    ) -> ID? {
        guard !orderedIDs.isEmpty else { return nil }
        guard offset != 0 else { return selection ?? orderedIDs.first }
        let currentIndex = selection.flatMap { orderedIDs.firstIndex(of: $0) }
            ?? (offset >= 0 ? -1 : orderedIDs.count)
        let normalizedOffset = ((offset % orderedIDs.count) + orderedIDs.count)
            % orderedIDs.count
        let nextIndex = (currentIndex + normalizedOffset + orderedIDs.count)
            % orderedIDs.count
        return orderedIDs[nextIndex]
    }
}

public enum RemiSessionScope: String, CaseIterable, Hashable, Sendable {
    case all
    case needsYou
    case live
    case stored

    public func includes(_ session: RemiSessionSummary) -> Bool {
        switch self {
        case .all: true
        case .needsYou: session.status == .needsYou
        case .live: session.isLive
        case .stored: !session.isLive
        }
    }

    public func count(in sessions: [RemiSessionSummary]) -> Int {
        sessions.count(where: includes)
    }
}

public enum RemiSessionTriage {
    public static func filtered(
        sessions: [RemiSessionSummary],
        scope: RemiSessionScope,
        query: String
    ) -> [RemiSessionSummary] {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return sessions.filter { session in
            guard scope.includes(session) else { return false }
            guard !trimmedQuery.isEmpty else { return true }
            return session.name.localizedCaseInsensitiveContains(trimmedQuery)
                || session.project.localizedCaseInsensitiveContains(trimmedQuery)
                || session.projectPath.localizedCaseInsensitiveContains(trimmedQuery)
                || session.harness.localizedCaseInsensitiveContains(trimmedQuery)
                || (session.lastMessage?.localizedCaseInsensitiveContains(trimmedQuery) ?? false)
        }
    }

    public static func reconciledSelection(
        selection: String?,
        visibleSessionIDs: [String]
    ) -> String? {
        guard !visibleSessionIDs.isEmpty else { return nil }
        if let selection, visibleSessionIDs.contains(selection) { return selection }
        return visibleSessionIDs.first
    }

    public static func nextAttentionSessionID(
        selection: String?,
        sessions: [RemiSessionSummary]
    ) -> String? {
        RemiOrderedSelection.shifted(
            selection: selection,
            orderedIDs: sessions.filter { $0.status == .needsYou }.map(\.id),
            offset: 1
        )
    }
}

public enum RemiMacCompactDestination: Equatable, Sendable {
    case machines
    case sessions
    case conversation

    public static func resolve(hasMachine: Bool, hasSession: Bool) -> Self {
        if hasSession { return .conversation }
        if hasMachine { return .sessions }
        return .machines
    }

    public var column: NavigationSplitViewColumn {
        switch self {
        case .machines: .sidebar
        case .sessions: .content
        case .conversation: .detail
        }
    }
}
