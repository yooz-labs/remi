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
                    identityUnavailableView
                }
            }
            .frame(minWidth: 760, minHeight: 560)
            .task { if scenePhase == .active { notifications.activate() } }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { notifications.activate() }
                else if phase == .background { notifications.background(suspendForegroundConnections: false) }
            }
        }
        .defaultSize(width: 1280, height: 800)
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
        .menuBarExtraStyle(.window)

        Settings {
            Group {
                if let store = notifications.store {
                    MacPreferencesView(store: store)
                } else {
                    identityUnavailableView
                    .frame(width: 520, height: 360)
                }
            }
        }
    }

    private var identityUnavailableView: some View {
        ContentUnavailableView {
            Label("Couldn’t load device identity", systemImage: "key.slash")
        } description: {
            Text(notifications.startupError ?? "Unlock this Mac, then try again.")
        } actions: {
            Button("Try again", systemImage: "arrow.clockwise") {
                notifications.retryStartup()
            }
            .buttonStyle(.glassProminent)
        }
    }

}
