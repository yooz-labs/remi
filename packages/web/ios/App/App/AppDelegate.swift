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

    // Background pre-wake for escalated-question pushes (#575, P4a).
    //
    // The signaling worker now sends `content-available: 1`, so iOS calls this
    // BEFORE the user taps the notification, giving the app a short background
    // window. We use it to nudge the WebView into re-establishing the WebSocket
    // so the connection is closer to ready by the time the user acts — and so
    // the direct /answer relay has a warm route on LAN/Tailscale.
    //
    // We forward the SAME DOM CustomEvents the web app already listens for on
    // foreground (`app-resume` / `app-force-reconnect`, dispatched from
    // main.tsx), rather than inventing a native message channel. Capacitor owns
    // the WKWebView and its push delegate, so we reach the web layer by
    // evaluating JS on the bridge's webView.
    //
    // NOTE: This path CANNOT be verified headlessly — it depends on APNS
    // delivering a content-available push to a real device and the WKWebView
    // running JS while backgrounded. Verify on-device:
    //   1. Background the app, trigger an escalated permission, confirm the
    //      Xcode console logs "[remi] background pre-wake" before any tap.
    //   2. Confirm the WebSocket shows a reconnect attempt in the web logs
    //      while the app is still backgrounded.
    //   3. Confirm `completionHandler` is always called (no background-budget
    //      warnings in the console).
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        let js = """
        (function() {
          try {
            document.dispatchEvent(new CustomEvent('app-resume'));
            document.dispatchEvent(new CustomEvent('app-force-reconnect'));
            console.debug('[remi] background pre-wake: dispatched app-force-reconnect');
          } catch (e) {
            console.warn('[remi] background pre-wake failed', e);
          }
        })();
        """

        // Reach the WKWebView through the Capacitor bridge view controller.
        if let bridgeVC = window?.rootViewController as? CAPBridgeViewController {
            bridgeVC.webView?.evaluateJavaScript(js, completionHandler: nil)
        }

        // Always call the completion handler so iOS does not throttle future
        // background wakes. `.newData` keeps the background-refresh budget warm
        // for this remote-notification use case.
        completionHandler(.newData)
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
