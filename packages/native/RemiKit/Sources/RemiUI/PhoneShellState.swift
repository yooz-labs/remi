import Foundation

/// What a session shows. Chat is the only pane today; files and a terminal are added
/// only once a hub capability backs them.
public enum PhoneSessionPane: Hashable, Sendable {
    case chat
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
    public let sessionID: String
    public let questionID: String

    public init(sessionID: String, questionID: String) {
        self.sessionID = sessionID
        self.questionID = questionID
    }
}

/// The phone shell's navigation: what is on screen, whether the drawer is open, and a
/// question waiting to be focused.
public struct PhoneShellState: Equatable, Sendable {
    public var destination: PhoneShellDestination
    public var isDrawerOpen: Bool
    public var pendingFocus: PhoneQuestionFocus?

    public init(
        destination: PhoneShellDestination = .inbox,
        isDrawerOpen: Bool = false,
        pendingFocus: PhoneQuestionFocus? = nil
    ) {
        self.destination = destination
        self.isDrawerOpen = isDrawerOpen
        self.pendingFocus = pendingFocus
    }

    public var selectedRoute: PhoneSessionRoute? {
        if case .session(let route) = destination { return route }
        return nil
    }

    public mutating func select(_ destination: PhoneShellDestination) {
        self.destination = destination
        isDrawerOpen = false
        pendingFocus = nil
    }

    public mutating func openFromNotification(route: PhoneSessionRoute, questionID: String?) {
        destination = .session(route)
        isDrawerOpen = false
        pendingFocus = questionID.map { PhoneQuestionFocus(sessionID: route.sessionID, questionID: $0) }
    }

    /// Returns the question id to focus, only when the pending focus belongs to
    /// `sessionID`, and clears it. A different session leaves the focus untouched.
    public mutating func consumeFocus(forSessionID sessionID: String) -> String? {
        guard let focus = pendingFocus, focus.sessionID == sessionID else { return nil }
        pendingFocus = nil
        return focus.questionID
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
