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
/// the screen, so only New session stays inline and the rest move into one menu.
public struct RemiDrawerActionsPresentation: Equatable, Sendable {
    public let inline: [RemiDrawerAction]
    public let menu: [RemiDrawerAction]

    public init(isAccessibilitySize: Bool) {
        if isAccessibilitySize {
            inline = [.newSession]
            menu = [.addMachine, .preferences]
        } else {
            inline = [.newSession, .addMachine, .preferences]
            menu = []
        }
    }

    public var hasMenu: Bool { !menu.isEmpty }
}
