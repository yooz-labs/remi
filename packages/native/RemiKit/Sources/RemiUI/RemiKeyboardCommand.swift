import Foundation

/// The hardware-keyboard commands of the phone shell.
public enum RemiKeyboardCommand: CaseIterable, Sendable {
    case newSession
    case previousSession
    case nextSession
    case toggleSidebar
    case focusComposer
}

/// Whether a keyboard command may run right now. A shortcut must never act on a screen
/// the person cannot see: behind a sheet, or under the compact drawer.
public struct RemiKeyboardCommandGuard: Equatable, Sendable {
    public var sheetIsActive: Bool
    public var drawerIsOpen: Bool
    public var hasSelectedSession: Bool
    public var hasConnectedMachine: Bool

    public init(sheetIsActive: Bool, drawerIsOpen: Bool, hasSelectedSession: Bool, hasConnectedMachine: Bool) {
        self.sheetIsActive = sheetIsActive
        self.drawerIsOpen = drawerIsOpen
        self.hasSelectedSession = hasSelectedSession
        self.hasConnectedMachine = hasConnectedMachine
    }

    public func allows(_ command: RemiKeyboardCommand) -> Bool {
        guard !sheetIsActive else { return false }
        switch command {
        case .newSession: return hasConnectedMachine
        case .previousSession, .nextSession, .toggleSidebar: return true
        case .focusComposer: return hasSelectedSession && !drawerIsOpen
        }
    }
}
