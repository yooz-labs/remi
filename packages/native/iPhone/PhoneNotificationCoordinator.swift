import UIKit
import UserNotifications

final class PhoneNotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        guard UserDefaults.standard.object(
            forKey: PhonePreferenceKey.questionNotifications
        ) as? Bool ?? true else { return [] }
        let soundEnabled = UserDefaults.standard.object(
            forKey: PhonePreferenceKey.notificationSounds
        ) as? Bool ?? true
        return soundEnabled ? [.banner, .sound] : [.banner]
    }
}

enum PhoneNotificationCoordinator {
    static func requestAuthorization() async {
        guard notificationsEnabled else { return }
        _ = try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound])
    }

    static func notify(id: String, title: String, body: String) async {
        guard notificationsEnabled else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if soundsEnabled {
            content.sound = .default
        }
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }

    static func remove(ids: [String]) {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
    }

    private static var notificationsEnabled: Bool {
        UserDefaults.standard.object(forKey: PhonePreferenceKey.questionNotifications) as? Bool ?? true
    }

    private static var soundsEnabled: Bool {
        UserDefaults.standard.object(forKey: PhonePreferenceKey.notificationSounds) as? Bool ?? true
    }
}
