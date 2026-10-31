import RemiKit
import RemiUI
import SwiftUI

@main
struct RemiPhoneApp: App {
    @UIApplicationDelegateAdaptor(PhoneNotificationDelegate.self) private var notificationDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var notifications = NativeRelayNotifications.shared
    @State private var localNoticeOwner: NativeLocalNotificationOwner?
    @State private var localNoticeSetupFailed = false

    var body: some Scene {
        WindowGroup {
            Group {
                if let store = notifications.store {
                    PhoneLiveRootView(store: store, localNoticeOwner: localNoticeOwner,
                                      localNoticeSetupFailed: localNoticeSetupFailed,
                                      retryLocalNoticeSetup: { Task { await activateLocalNoticeReview() } })
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
            .task {
                PhoneNotificationCoordinator.shareSoundsPreference()
                if scenePhase == .active { notifications.activate(); await activateLocalNoticeReview() }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    notifications.activate()
                    Task { await activateLocalNoticeReview() }
                } else if phase == .background {
                    notifications.background(); localNoticeOwner?.stop()
                }
            }
        }
    }

    @MainActor private func activateLocalNoticeReview() async {
        if localNoticeOwner == nil {
            do { localNoticeOwner = try NativeLocalNotificationOwner.configured(); localNoticeSetupFailed = false }
            catch { localNoticeSetupFailed = true; return }
        }
        await localNoticeOwner?.start()
    }
}
