import Foundation

/// An action in the drawer's bottom area.
public enum RemiDrawerAction: Hashable, Sendable {
    case newSession
    case addMachine
    case preferences
}

/// Which of the drawer's bottom actions sit inline and which move into a More menu, kept
/// apart from the view so the rule can be tested. At standard sizes every action is
/// inline. At accessibility sizes three stacked labeled buttons take about 40 percent of
/// the screen, so only New session stays inline and the rest move into one menu, and the actions sit at the top of the scrolling column
/// instead of the bottom, because a long list would otherwise put them out of reach.
public struct RemiDrawerActionsPresentation: Equatable, Sendable {
    /// Where the actions sit in the drawer.
    public enum Placement: Equatable, Sendable {
        /// Pinned below the list.
        case bottom
        /// At the top of the scrolling column, under the header, so they are reached first.
        case top
    }

    public let inline: [RemiDrawerAction]
    public let menu: [RemiDrawerAction]
    public let placement: Placement

    public init(isAccessibilitySize: Bool) {
        if isAccessibilitySize {
            inline = [.newSession]
            menu = [.addMachine, .preferences]
            placement = .top
        } else {
            inline = [.newSession, .addMachine, .preferences]
            menu = []
            placement = .bottom
        }
    }

    public var hasMenu: Bool { !menu.isEmpty }
}
