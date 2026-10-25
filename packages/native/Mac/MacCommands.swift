import RemiUI
import SwiftUI

/// What the window offers the menu bar. The window publishes it as a focused scene value, so
/// a command acts on the window in front and is disabled when no window is.
struct MacWorkspaceActions {
    let availability: RemiMacCommandAvailability
    let goToInbox: () -> Void
    let nextNeedsYou: () -> Void
    let previousNeedsYou: () -> Void
    let moveMachine: (Int) -> Void
    let reconnect: () -> Void
    let canCreateSession: Bool
    let newSession: () -> Void
    let addMachine: () -> Void
    let toggleMachines: () -> Void
    let toggleSessions: () -> Void
    let canFocusConversation: Bool
    let focusConversation: () -> Void
}

/// Moves the selection through the session list in the order the list shows. Published only
/// while the list has sessions.
struct MacSessionNavigationActions {
    let move: (Int) -> Void
}

/// Opens the search bar of the open conversation. Published only while it has entries and focus.
struct MacFindActions {
    let find: () -> Void
}

/// Moves between the open session's conversations (Main and its subagents). Published only while
/// the session has subagent conversations.
struct MacConversationActions {
    let move: (Int) -> Void
}

extension FocusedValues {
    @Entry var macWorkspace: MacWorkspaceActions?
    @Entry var macConversations: MacConversationActions?
    @Entry var macSessionNavigation: MacSessionNavigationActions?
    @Entry var macFind: MacFindActions?
}

struct MacCommands: Commands {
    @FocusedValue(\.macWorkspace) private var workspace
    @FocusedValue(\.macSessionNavigation) private var sessions
    @FocusedValue(\.macFind) private var find
    @FocusedValue(\.macConversations) private var conversations

    var body: some Commands {
        // Before the standard New Window item. The window toolbars keep a button for each, but a
        // toolbar button cannot own a shortcut: it stops working when its column is hidden.
        CommandGroup(before: .newItem) {
            Button("New Session") { workspace?.newSession() }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(workspace?.canCreateSession != true)
            Button("Add Machine…") { workspace?.addMachine() }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .disabled(workspace == nil)
            Divider()
        }

        CommandGroup(after: .sidebar) {
            Button("Show or Hide Machines") { workspace?.toggleMachines() }
                .keyboardShortcut("1", modifiers: [.command, .control])
                .disabled(workspace == nil)
            Button("Show or Hide Sessions") { workspace?.toggleSessions() }
                .keyboardShortcut("2", modifiers: [.command, .control])
                .disabled(workspace == nil)
            Button("Focus Conversation") { workspace?.focusConversation() }
                .keyboardShortcut("3", modifiers: [.command, .control])
                .disabled(workspace?.canFocusConversation != true)
        }

        CommandMenu("Go") {
            Button("Go to Inbox") { workspace?.goToInbox() }
                .keyboardShortcut("i", modifiers: [.command, .shift])
                .disabled(workspace?.availability.goToInbox != true)

            Divider()

            Button("Next Needs You") { workspace?.nextNeedsYou() }
                .keyboardShortcut("j", modifiers: [.command, .option])
                .disabled(workspace?.availability.nextNeedsYou != true)
            Button("Previous Needs You") { workspace?.previousNeedsYou() }
                .keyboardShortcut("j", modifiers: [.command, .option, .shift])
                .disabled(workspace?.availability.nextNeedsYou != true)

            Divider()

            Button("Previous Session") { sessions?.move(-1) }
                .keyboardShortcut(.upArrow, modifiers: [.command, .option])
                .disabled(sessions == nil || workspace?.availability.previousSession != true)
            Button("Next Session") { sessions?.move(1) }
                .keyboardShortcut(.downArrow, modifiers: [.command, .option])
                .disabled(sessions == nil || workspace?.availability.nextSession != true)

            Button("Previous Conversation") { conversations?.move(-1) }
                .keyboardShortcut(.leftArrow, modifiers: [.command, .option])
                .disabled(conversations == nil)
            Button("Next Conversation") { conversations?.move(1) }
                .keyboardShortcut(.rightArrow, modifiers: [.command, .option])
                .disabled(conversations == nil)

            Divider()

            Button("Previous Machine") { workspace?.moveMachine(-1) }
                .keyboardShortcut(.upArrow, modifiers: [.control, .option])
                .disabled(workspace?.availability.previousMachine != true)
            Button("Next Machine") { workspace?.moveMachine(1) }
                .keyboardShortcut(.downArrow, modifiers: [.control, .option])
                .disabled(workspace?.availability.nextMachine != true)

            Divider()

            Button("Reconnect") { workspace?.reconnect() }
                .keyboardShortcut("r", modifiers: [.command, .shift])
                .disabled(workspace?.availability.reconnect != true)
        }

        CommandGroup(after: .textEditing) {
            Button("Find in Conversation") { find?.find() }
                .keyboardShortcut("f", modifiers: .command)
                .disabled(find == nil)
        }
    }
}
