import Foundation
import RemiKit

/// What a session shows. Chat always works; the terminal and files panes are offered only
/// once the machine advertises the capability behind them (`RemiPaneAvailability`, #1639).
public enum PhoneSessionPane: Hashable, Sendable {
    case chat
    case terminal
    case files
}

/// Where a session screen points.
///
/// `machineKey` is the machine id exactly as `MachineStore` uses it today, the profile
/// id (`MachineState.id`). The authenticated machine identity id is a later follow-up.
/// A question id is deliberately not part of a route: a
/// question to focus travels in ``PhoneQuestionFocus``.
public struct PhoneSessionRoute: Hashable, Sendable {
    public var machineKey: String
    public var sessionID: String
    public var conversationID: String?
    public var pane: PhoneSessionPane

    public init(machineKey: String, sessionID: String, conversationID: String? = nil, pane: PhoneSessionPane = .chat) {
        self.machineKey = machineKey
        self.sessionID = sessionID
        self.conversationID = conversationID
        self.pane = pane
    }
}

public enum PhoneShellDestination: Hashable, Sendable {
    case inbox
    case session(PhoneSessionRoute)
}

/// A question to bring into view once its session is on screen.
public struct PhoneQuestionFocus: Hashable, Sendable {
    public let machineKey: String
    public let sessionID: String
    public let questionID: String

    public init(machineKey: String, sessionID: String, questionID: String) {
        self.machineKey = machineKey
        self.sessionID = sessionID
        self.questionID = questionID
    }
}

/// The drawer's transient machine filter. It narrows the drawer's session list only;
/// the Inbox and notifications always span every machine. `machine` holds the machine
/// id exactly as `PhoneSessionRoute.machineKey` does.
public enum PhoneDrawerFilter: Hashable, Sendable {
    case all
    case machine(String)
}

/// The phone shell's navigation: what is on screen, whether the drawer is open, and a
/// question waiting to be focused.
public struct PhoneShellState: Equatable, Sendable {
    public var destination: PhoneShellDestination
    public var isDrawerOpen: Bool
    public var pendingFocus: PhoneQuestionFocus?
    public var drawerFilter: PhoneDrawerFilter
    /// A Resume the person asked for that has not landed yet. Any explicit navigation
    /// clears it, so a late landing never pulls them away from where they went.
    public var pendingResume: ResumeSessionKey?

    public init(
        destination: PhoneShellDestination = .inbox,
        isDrawerOpen: Bool = false,
        pendingFocus: PhoneQuestionFocus? = nil,
        drawerFilter: PhoneDrawerFilter = .all
    ) {
        self.destination = destination
        self.isDrawerOpen = isDrawerOpen
        self.pendingFocus = pendingFocus
        self.drawerFilter = drawerFilter
    }

    /// The machine the drawer is narrowed to, nil for all machines.
    public var filteredMachineKey: String? {
        if case .machine(let key) = drawerFilter { return key }
        return nil
    }

    /// Narrows the drawer to one machine. Selecting the machine that is already the
    /// filter returns to all machines.
    public mutating func selectMachineFilter(_ machineKey: String) {
        drawerFilter = drawerFilter == .machine(machineKey) ? .all : .machine(machineKey)
    }

    public mutating func clearFilter() { drawerFilter = .all }

    /// Resets the filter when its machine is no longer in `ids`.
    public mutating func machinesChanged(ids: [String]) {
        if let key = filteredMachineKey, !ids.contains(key) { drawerFilter = .all }
    }

    public var selectedRoute: PhoneSessionRoute? {
        if case .session(let route) = destination { return route }
        return nil
    }

    public var selectedSessionKey: RemiSessionKey? {
        selectedRoute.map { RemiSessionKey(machineID: $0.machineKey, sessionID: $0.sessionID) }
    }

    public mutating func select(_ destination: PhoneShellDestination) {
        self.destination = destination
        isDrawerOpen = false
        pendingFocus = nil
        pendingResume = nil
    }

    /// Opens a session picked from the drawer. Picking the session already on screen only
    /// closes the drawer and keeps its route, conversation and scroll position: a new route
    /// (one without the conversation id a notification carried) would rebuild the screen.
    public mutating func selectSession(machineKey: String, sessionID: String) {
        if let current = selectedRoute, current.machineKey == machineKey, current.sessionID == sessionID {
            isDrawerOpen = false
            pendingResume = nil
            return
        }
        select(.session(PhoneSessionRoute(machineKey: machineKey, sessionID: sessionID)))
    }

    public mutating func beginResume(_ key: ResumeSessionKey) { pendingResume = key }

    /// Opens the resumed session at `route`, only while `key` is still the pending resume.
    /// Returns whether it landed.
    @discardableResult
    public mutating func landResume(_ key: ResumeSessionKey, at route: PhoneSessionRoute) -> Bool {
        guard pendingResume == key else { return false }
        select(.session(route))
        return true
    }

    public mutating func openFromNotification(route: PhoneSessionRoute, questionID: String?) {
        destination = .session(route)
        isDrawerOpen = false
        pendingResume = nil
        // A notification must never be hidden by a filter.
        drawerFilter = .all
        pendingFocus = questionID.map { PhoneQuestionFocus(machineKey: route.machineKey, sessionID: route.sessionID, questionID: $0) }
    }

    /// The question to focus for `route`, without consuming it: only when the pending
    /// focus belongs to that machine and session.
    public func focusQuestionID(for route: PhoneSessionRoute) -> String? {
        guard let focus = pendingFocus,
              focus.machineKey == route.machineKey, focus.sessionID == route.sessionID
        else { return nil }
        return focus.questionID
    }

    /// Returns the question id to focus and clears it, only when the pending focus belongs
    /// to `route`'s machine and session. Another route leaves the focus untouched.
    public mutating func consumeFocus(for route: PhoneSessionRoute) -> String? {
        guard let questionID = focusQuestionID(for: route) else { return nil }
        pendingFocus = nil
        return questionID
    }

    /// The route to leave when it disappears. The caller owns the grace period (it shows
    /// a Reconnecting placeholder first); this goes to the Inbox only when the current
    /// destination is exactly this route, machine included.
    public mutating func sessionVanished(_ route: PhoneSessionRoute) {
        guard destination == .session(route) else { return }
        destination = .inbox
    }

    public mutating func openDrawer() { isDrawerOpen = true }
    public mutating func closeDrawer() { isDrawerOpen = false }
    public mutating func toggleDrawer() { isDrawerOpen.toggle() }
}
