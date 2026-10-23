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

extension FocusedValues {
    @Entry var macWorkspace: MacWorkspaceActions?
    @Entry var macSessionNavigation: MacSessionNavigationActions?
    @Entry var macFind: MacFindActions?
}

struct MacCommands: Commands {
    @FocusedValue(\.macWorkspace) private var workspace
    @FocusedValue(\.macSessionNavigation) private var sessions
    @FocusedValue(\.macFind) private var find

    var body: some Commands {
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
