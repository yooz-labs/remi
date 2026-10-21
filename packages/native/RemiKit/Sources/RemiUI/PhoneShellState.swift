import Foundation

/// What a session shows. Chat is the only pane today; files and a terminal are added
/// only once a hub capability backs them.
public enum PhoneSessionPane: Hashable, Sendable {
    case chat
}

/// Where a session screen points.
///
/// `machineKey` is the machine identity id when it is known, else the profile id; the
/// view layer decides which. A question id is deliberately not part of a route: a
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

    public var selectedSessionID: String? {
        if case .session(let route) = destination { return route.sessionID }
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

    /// A resumed session gets a new id; keep the person where they are.
    public mutating func replaceSession(from oldID: String, to newID: String) {
        guard case .session(var route) = destination, route.sessionID == oldID else { return }
        route.sessionID = newID
        destination = .session(route)
        if let focus = pendingFocus, focus.sessionID == oldID {
            pendingFocus = PhoneQuestionFocus(sessionID: newID, questionID: focus.questionID)
        }
    }

    /// The shown session left the list. Before `graceElapsed` the caller shows a
    /// Reconnecting placeholder; after it, the Inbox.
    public mutating func sessionVanished(sessionID: String, graceElapsed: Bool) {
        guard graceElapsed, selectedSessionID == sessionID else { return }
        destination = .inbox
    }

    public mutating func openDrawer() { isDrawerOpen = true }
    public mutating func closeDrawer() { isDrawerOpen = false }
    public mutating func toggleDrawer() { isDrawerOpen.toggle() }
}
