import AppKit
import Observation
import RemiKit
import RemiPush
import SwiftUI
import UserNotifications

@MainActor
@Observable
final class MacNotificationRouter {
    static let shared = MacNotificationRouter()
    var destination: RemiNavigationDestination?
}

enum MacNotificationAccess: Sendable, Equatable {
    case unknown
    case allowed
    case denied
}

@MainActor
@Observable
final class MacNotificationPermission {
    static let shared = MacNotificationPermission()
    private(set) var access: MacNotificationAccess

    init(access: MacNotificationAccess = .unknown) {
        self.access = access
    }

    func refresh() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        access = Self.access(for: settings.authorizationStatus)
    }

    func requestIfNeeded() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound])
        }
        await refresh()
    }

    nonisolated static func access(for status: UNAuthorizationStatus) -> MacNotificationAccess {
        switch status {
        case .denied: .denied
        case .authorized, .provisional, .ephemeral: .allowed
        case .notDetermined: .unknown
        @unknown default: .unknown
        }
    }
}

final class MacNotificationDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        NativeRelayNotifications.shared.activate()
    }

    func application(
        _ application: NSApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        NativeRelayNotifications.shared.acceptPushToken(deviceToken)
    }

    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        NativeRelayNotifications.shared.pushRegistrationFailed()
    }

    func application(_ application: NSApplication, didReceiveRemoteNotification userInfo: [String: Any]) {
        guard userInfo["remiPush"] != nil else { return }
        NativeRelayNotifications.receiveDismiss(carrier: NativeRelayNotifications.carrier(from: userInfo)) { _ in }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        if RemiPushStore.isSecureNotification(content: notification.request.content) {
            guard NativeRelayNotifications.allowsPresentation(notification.request.content) else { return [] }
        }
        return [.banner, .list, .sound]
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
        guard let destination = MacNotificationCoordinator.destination(
            from: response.notification.request.content.userInfo
        ) else { return }
        await MainActor.run {
            MacNotificationRouter.shared.destination = destination
        }
    }
}

enum MacNotificationCoordinator {
    static func requestAuthorization() async {
        await MacNotificationPermission.shared.requestIfNeeded()
    }

    static func notify(
        id: String,
        title: String,
        body: String,
        destination: RemiNavigationDestination
    ) async {
        let summariesEnabled = UserDefaults.standard.object(
            forKey: QuestionNotificationSummarizer.preferenceKey
        ) as? Bool ?? true
        let summarizedBody = summariesEnabled
            ? await QuestionNotificationSummarizer.shared.summary(questionID: id, text: body)
            : QuestionNotificationSummarizer.fallback(for: body)
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = summarizedBody
        content.sound = .default
        content.userInfo = destinationUserInfo(destination)
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
        let object = userInfo.reduce(into: [String: Any]()) { result, element in
            guard let key = element.key as? String else { return }
            result[key] = element.value
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
}

/// Lives in the menu-bar label, whose lifetime is independent of the optional main window.
struct MacMenuBarLabel: View {
    let store: MachineStore?
    @Environment(\.openWindow) private var openWindow
    @State private var notificationRouter = MacNotificationRouter.shared
    @State private var relayNotifications = NativeRelayNotifications.shared

    var body: some View {
        Image(systemName: "questionmark.bubble")
            .background {
                if let store {
                    MacQuestionNotificationMonitor(store: store)
                }
            }
            .accessibilityLabel("Remi")
            .onChange(of: notificationRouter.destination, initial: true) { _, destination in
                guard destination != nil else { return }
                openWindow(id: "main")
                NSApp.activate()
            }
            .onChange(of: relayNotifications.notificationPresentationID, initial: true) { _, presentation in
                guard presentation != nil else { return }
                openWindow(id: "main")
                NSApp.activate()
            }
    }
}

private struct MacQuestionNotificationMonitor: View {
    let store: MachineStore
    @State private var knownQuestionIDs: Set<String> = []
    @State private var baselineEstablished = false

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .task { await MacNotificationCoordinator.requestAuthorization() }
            .onChange(of: Set(pending.map(\.message.question.id)), initial: true) { _, newValue in
                guard baselineEstablished else {
                    knownQuestionIDs = newValue
                    baselineEstablished = true
                    return
                }

                MacNotificationCoordinator.remove(ids: Array(knownQuestionIDs.subtracting(newValue)))
                for id in newValue.subtracting(knownQuestionIDs) {
                    guard let item = pending.first(where: {
                        $0.message.question.id == id
                    }) else { continue }
                    let sessionName = item.machine.sessions.first(where: {
                        $0.sessionId == item.message.sessionId
                    })?.name ?? "A session"
                    Task {
                        await MacNotificationCoordinator.notify(
                            id: id,
                            title: "\(sessionName) needs you",
                            body: item.message.question.text,
                            destination: RemiNavigationDestination(
                                machineID: item.machine.id,
                                sessionID: item.message.sessionId,
                                questionID: id,
                                agentID: item.message.question.agentId
                            )
                        )
                    }
                }
                knownQuestionIDs = newValue
            }
    }

    private var pending: [(machine: MachineState, message: QuestionMessage)] {
        store.machines.flatMap { machine in
            machine.questions.map { (machine, $0) }
        }
    }
}
