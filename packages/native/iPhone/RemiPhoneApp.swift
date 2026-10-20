import RemiKit
import RemiUI
import SwiftUI

@main
struct RemiPhoneApp: App {
    @UIApplicationDelegateAdaptor(PhoneNotificationDelegate.self) private var notificationDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var notifications = NativeRelayNotifications.shared

    var body: some Scene {
        WindowGroup {
            Group {
                if let store = notifications.store {
                    PhoneLiveRootView(store: store)
                } else {
                    ContentUnavailableView {
                        Label("Couldn’t load device identity", systemImage: "key.slash")
                    } description: {
                        Text(notifications.startupError ?? "Unlock this device, then try again.")
                    } actions: {
                        Button("Try again", systemImage: "arrow.clockwise") {
                            notifications.retryStartup()
                        }
                        .buttonStyle(.glassProminent)
                    }
                }
            }
            .task { if scenePhase == .active { notifications.activate() } }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { notifications.activate() }
                else if phase == .background { notifications.background() }
            }
        }
    }

}

struct PhoneRootView: View {
    var body: some View {
        NavigationStack {
            HomeScreen(
                questions: [RemiPreviewData.binaryQuestion],
                sessions: RemiPreviewData.sessions,
                machines: RemiPreviewData.machines
            )
        }
    }
}
