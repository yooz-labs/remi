import RemiUI
import SwiftUI

/// An action from Home's toolbar. The split layout shows the toolbar in the detail pane, so the
/// root asks Home to run the action, because Home owns the sheets it opens.
enum PhoneHomeAction: Equatable {
    case newSession
    case addMachine
    case preferences
}

/// A request for Home to run an action. Each request has its own id, so asking for the same action
/// twice is two changes, and Home sees both.
struct PhoneHomeActionRequest: Equatable {
    let id = UUID()
    let action: PhoneHomeAction
}

/// The actions at the top of Home. In a wide window they sit in the detail pane's bar, which the
/// system presents on the side of the display, under the right hand; in a compact window they
/// stay in Home's own bar.
struct PhoneHomeToolbar: ToolbarContent {
    let canCreateSession: Bool
    let perform: (PhoneHomeAction) -> Void

    var body: some ToolbarContent {
        if #available(iOS 27.0, *) {
            ToolbarOverflowMenu {
                if canCreateSession {
                    Button("Add machine", systemImage: "desktopcomputer.and.arrow.down") {
                        perform(.addMachine)
                    }
                }
                Button("Preferences", systemImage: "gearshape") {
                    perform(.preferences)
                }
            }

            ToolbarItem(placement: .topBarPinnedTrailing) {
                if canCreateSession {
                    Button("New session", systemImage: "plus.rectangle.on.folder") {
                        perform(.newSession)
                    }
                } else {
                    Button("Add machine", systemImage: "desktopcomputer.and.arrow.down") {
                        perform(.addMachine)
                    }
                }
            }
            .verticalBarPreferred()
        } else {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("New session", systemImage: "plus.rectangle.on.folder") {
                        perform(.newSession)
                    }
                    .disabled(!canCreateSession)

                    Button("Add machine", systemImage: "desktopcomputer.and.arrow.down") {
                        perform(.addMachine)
                    }

                    Divider()

                    Button("Preferences", systemImage: "gearshape") {
                        perform(.preferences)
                    }
                } label: {
                    Label("Add", systemImage: "plus")
                        .frame(
                            minWidth: RemiTheme.Size.minimumTapTarget,
                            minHeight: RemiTheme.Size.minimumTapTarget
                        )
                        .contentShape(.rect)
                }
            }
        }
    }
}
