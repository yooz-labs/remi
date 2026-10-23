import Foundation

/// What a person has set up on a session screen that is not the session's own data: the
/// unsent draft, the conversation they pushed into (a subagent) and where they were
/// reading. It lives above the compact/regular layout switch, because the two layouts
/// build their content in different containers and a rebuilt screen would otherwise
/// start blank.
public struct RemiSessionViewState: Equatable, Sendable {
    public var draft = ""
    public var selectedViewID = ""
    public var visibleEntryID: String?
    public var followsLatest = true

    public init(
        draft: String = "",
        selectedViewID: String = "",
        visibleEntryID: String? = nil,
        followsLatest: Bool = true
    ) {
        self.draft = draft
        self.selectedViewID = selectedViewID
        self.visibleEntryID = visibleEntryID
        self.followsLatest = followsLatest
    }
}

/// Per-session screen state, keyed by machine and session so the same session id on two
/// machines never shares a draft.
public struct RemiSessionViewStateStore: Equatable, Sendable {
    private var states: [RemiSessionKey: RemiSessionViewState] = [:]

    public init() {}

    public func state(for key: RemiSessionKey) -> RemiSessionViewState {
        states[key] ?? RemiSessionViewState()
    }

    public mutating func update(_ key: RemiSessionKey, _ change: (inout RemiSessionViewState) -> Void) {
        var state = states[key] ?? RemiSessionViewState()
        change(&state)
        // A default state is the same as none: do not keep an entry for it.
        states[key] = state == RemiSessionViewState() ? nil : state
    }

    public mutating func remove(_ key: RemiSessionKey) { states[key] = nil }

    /// Forgets sessions that are no longer in `keys`, so the store cannot grow without bound.
    public mutating func prune(keeping keys: Set<RemiSessionKey>) {
        states = states.filter { keys.contains($0.key) }
    }
}

/// A reference holder for the store. Scrolling writes the reading position many times a
/// second; keeping the store out of observed state means those writes never re-render
/// the shell above it.
@MainActor
public final class RemiSessionViewStateHolder {
    public private(set) var store = RemiSessionViewStateStore()

    public init() {}

    public func state(for key: RemiSessionKey) -> RemiSessionViewState { store.state(for: key) }

    public func update(_ key: RemiSessionKey, _ change: (inout RemiSessionViewState) -> Void) {
        store.update(key, change)
    }

    public func prune(keeping keys: Set<RemiSessionKey>) { store.prune(keeping: keys) }
}
