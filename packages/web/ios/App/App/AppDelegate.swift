import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let vc = CAPBridgeViewController()
        window.rootViewController = vc
        window.makeKeyAndVisible()
        self.window = window
        registerNotificationCategories()
        return true
    }

    /// Register UNNotificationCategory objects for lock-screen / Apple Watch action buttons.
    /// Capacitor owns UNUserNotificationCenter.delegate; do NOT override it here.
    private func registerNotificationCategories() {
        let auth: UNNotificationActionOptions = [.authenticationRequired]
        let dest: UNNotificationActionOptions = [.authenticationRequired, .destructive]

        // Two-option: Yes / No
        let yn = UNNotificationCategory(
            identifier: "REMI_YN",
            actions: [
                UNNotificationAction(identifier: "OPT_0", title: "Yes", options: auth),
                UNNotificationAction(identifier: "OPT_1", title: "No",  options: dest),
            ],
            intentIdentifiers: [],
            options: []
        )

        // Three-option: Yes / Yes, always / No
        let yna = UNNotificationCategory(
            identifier: "REMI_YNA",
            actions: [
                UNNotificationAction(identifier: "OPT_0", title: "Yes",         options: auth),
                UNNotificationAction(identifier: "OPT_1", title: "Yes, always", options: auth),
                UNNotificationAction(identifier: "OPT_2", title: "No",          options: dest),
            ],
            intentIdentifiers: [],
            options: []
        )

        // Four-option: generic multi-choice (titles overridden at runtime by action data)
        let multi = UNNotificationCategory(
            identifier: "REMI_MULTI",
            actions: [
                UNNotificationAction(identifier: "OPT_0", title: "Option 1", options: auth),
                UNNotificationAction(identifier: "OPT_1", title: "Option 2", options: auth),
                UNNotificationAction(identifier: "OPT_2", title: "Option 3", options: auth),
                UNNotificationAction(identifier: "OPT_3", title: "Option 4", options: auth),
            ],
            intentIdentifiers: [],
            options: []
        )

        UNUserNotificationCenter.current().setNotificationCategories([yn, yna, multi])
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(
            name: .capacitorDidRegisterForRemoteNotifications,
            object: deviceToken
        )
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(
            name: .capacitorDidFailToRegisterForRemoteNotifications,
            object: error
        )
    }

    // Keep WebSocket alive when app enters background.
    // iOS grants ~30 seconds of background execution time.
    // During this window, the WebSocket stays connected and can
    // receive question prompts and fire local notifications.
    func applicationDidEnterBackground(_ application: UIApplication) {
        backgroundTask = application.beginBackgroundTask(withName: "RemiWebSocket") { [weak self] in
            // Time expired; end the task gracefully
            if let task = self?.backgroundTask, task != .invalid {
                application.endBackgroundTask(task)
                self?.backgroundTask = .invalid
            }
        }
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        if backgroundTask != .invalid {
            application.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }
}
