import UIKit
import UserNotifications
import Observation
import RemiKit
import RemiPush

@MainActor
@Observable
final class PhoneNotificationRouter {
    static let shared = PhoneNotificationRouter()
    var destination: RemiNavigationDestination?
}

final class PhoneNotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        NativeRelayNotifications.shared.activate()
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NativeRelayNotifications.shared.acceptPushToken(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        NativeRelayNotifications.shared.pushRegistrationFailed()
    }

    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard userInfo["remiPush"] != nil else { completionHandler(.noData); return }
        let carrier = NativeRelayNotifications.carrier(from: userInfo)
        let completion = PhoneBackgroundFetchCompletion(completionHandler)
        NativeRelayNotifications.receiveDismiss(carrier: carrier) { result in
            // RemiPush bounds the delivered-notification callback at two seconds.
            Task { @MainActor in completion.finish(result) }
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        if RemiPushStore.isSecureNotification(content: notification.request.content) {
            guard NativeRelayNotifications.allowsPresentation(notification.request.content) else { return [] }
        }
        guard UserDefaults.standard.object(
            forKey: PhonePreferenceKey.questionNotifications
        ) as? Bool ?? true else { return [] }
        let soundEnabled = UserDefaults.standard.object(
            forKey: PhonePreferenceKey.notificationSounds
        ) as? Bool ?? true
        return soundEnabled ? [.banner, .sound] : [.banner]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        if RemiPushStore.isSecureNotification(content: response.notification.request.content, identifier: response.actionIdentifier) {
            if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
                let carrier = NativeRelayNotifications.carrier(from: response.notification.request.content.userInfo)
                await NativeRelayNotifications.shared.openDefaultTap(carrier: carrier)
            } else if response.actionIdentifier != UNNotificationDismissActionIdentifier {
                let delivery = NativeRelayActionDelivery(content: response.notification.request.content,
                    identifier: response.actionIdentifier)
                _ = await NativeRelayNotifications.shared.receiveAction(delivery)
            }
            return
        }
        guard let destination = PhoneNotificationCoordinator.destination(
            from: response.notification.request.content.userInfo
        ) else { return }
        await MainActor.run { PhoneNotificationRouter.shared.destination = destination }
    }
}

/// UIKit supplies a non-Sendable callback. Keep it on the main actor and invoke
/// it at most once after the bounded RemiPush operation returns.
@MainActor
private final class PhoneBackgroundFetchCompletion {
    private var handler: ((UIBackgroundFetchResult) -> Void)?
    init(_ handler: @escaping (UIBackgroundFetchResult) -> Void) { self.handler = handler }
    func finish(_ result: Bool?) {
        guard let handler else { return }
        self.handler = nil
        handler(result == true ? .newData : result == false ? .noData : .failed)
    }
}

enum PhoneNotificationCoordinator {
    static func requestAuthorization() async -> NotificationAuthorizationState {
        guard notificationsEnabled else { return await authorizationState() }
        _ = try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound])
        return await authorizationState()
    }

    static func authorizationState() async -> NotificationAuthorizationState {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        return NotificationAuthorizationState(settings.authorizationStatus)
    }

    @MainActor
    static func openSystemSettings() async {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        await UIApplication.shared.open(url)
    }

    static func notify(
        id: String,
        title: String,
        body: String,
        destination: RemiNavigationDestination
    ) async {
        guard notificationsEnabled else { return }
        guard await authorizationState().isAllowed else { return }
        let summarizedBody = summariesEnabled
            ? await QuestionNotificationSummarizer.shared.summary(questionID: id, text: body)
            : QuestionNotificationSummarizer.fallback(for: body)
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = summarizedBody
        content.userInfo = destinationUserInfo(destination)
        if soundsEnabled {
            content.sound = .default
        }
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }

    static func destinationUserInfo(_ destination: RemiNavigationDestination) -> [AnyHashable: Any] {
        guard let data = try? JSONEncoder().encode(destination),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return object
    }

    static func destination(from userInfo: [AnyHashable: Any]) -> RemiNavigationDestination? {
        var object: [String: Any] = [:]
        for (key, value) in userInfo {
            guard let key = key as? String else { continue }
            object[key] = value
        }
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object)
        else { return nil }
        return try? JSONDecoder().decode(RemiNavigationDestination.self, from: data)
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

    private static var summariesEnabled: Bool {
        UserDefaults.standard.object(forKey: QuestionNotificationSummarizer.preferenceKey) as? Bool ?? true
    }
}

enum NotificationAuthorizationState: Equatable {
    case unknown
    case notDetermined
    case denied
    case authorized
    case provisional
    case ephemeral

    init(_ status: UNAuthorizationStatus) {
        switch status {
        case .notDetermined: self = .notDetermined
        case .denied: self = .denied
        case .authorized: self = .authorized
        case .provisional: self = .provisional
        case .ephemeral: self = .ephemeral
        @unknown default: self = .unknown
        }
    }

    var title: String {
        switch self {
        case .unknown: "Checking…"
        case .notDetermined: "Not enabled"
        case .denied: "Off in Settings"
        case .authorized: "Allowed"
        case .provisional: "Delivered quietly"
        case .ephemeral: "Temporarily allowed"
        }
    }

    var systemImage: String {
        switch self {
        case .unknown: "ellipsis.circle"
        case .notDetermined: "bell.badge"
        case .denied: "bell.slash.fill"
        case .authorized: "checkmark.circle.fill"
        case .provisional, .ephemeral: "bell.badge.fill"
        }
    }

    var detail: String {
        switch self {
        case .unknown:
            "Remi is checking whether iOS can show question alerts."
        case .notDetermined:
            "Allow Remi to alert you when a connected session needs an answer."
        case .denied:
            "iOS is blocking Remi alerts. You can allow them in Notification Settings."
        case .authorized:
            "iOS can show Remi alerts when a connected session needs an answer."
        case .provisional:
            "iOS delivers Remi alerts quietly without interrupting you."
        case .ephemeral:
            "iOS can show Remi alerts temporarily for this app session."
        }
    }

    var isAllowed: Bool {
        switch self {
        case .authorized, .provisional, .ephemeral: true
        case .unknown, .notDetermined, .denied: false
        }
    }
}
