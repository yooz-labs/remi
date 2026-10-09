import RemiKit
import RemiUI
import SwiftUI

@main
struct RemiMacApp: App {
    @NSApplicationDelegateAdaptor(MacNotificationDelegate.self) private var notificationDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var notifications = NativeRelayNotifications.shared

    var body: some Scene {
        WindowGroup("Remi", id: "main") {
            Group {
                if let store = notifications.store {
                    MacLiveRootView(store: store)
                } else {
                    ContentUnavailableView(
                        "Couldn’t load device identity",
                        systemImage: "key.slash",
                        description: Text(notifications.startupError ?? "Open Remi in the foreground to continue.")
                    )
                }
            }
            .frame(minWidth: 760, minHeight: 560)
            .task { if scenePhase == .active { notifications.activate() } }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { notifications.activate() }
                else if phase == .background { notifications.background() }
            }
        }
        .defaultSize(width: 1180, height: 760)
        .keyboardShortcut(nil)

        MenuBarExtra {
            if let store = notifications.store {
                MacLiveNeedsYouMenu(store: store)
            } else {
                Text("Device identity unavailable")
            }
        } label: {
            MacMenuBarLabel(store: notifications.store)
        }

        Settings {
            Group {
                if let store = notifications.store {
                    MacPreferencesView(publicIdentity: store.publicIdentity)
                } else {
                    ContentUnavailableView(
                        "Device identity unavailable",
                        systemImage: "key.slash",
                        description: Text(notifications.startupError ?? "Open Remi in the foreground to continue.")
                    )
                    .frame(width: 520, height: 360)
                }
            }
        }
    }

}
