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
    var notice: String?
}

@MainActor
private final class MacLocalQuestionActions {
    static let shared = MacLocalQuestionActions()
    private struct Binding {
        let plan: LocalQuestionNotificationPlan
        let store: MachineStore
        let title: String
    }
    private var bindings: [String: Binding] = [:]

    func bind(id: String, plan: LocalQuestionNotificationPlan, store: MachineStore, title: String) -> Bool {
        guard bindings.count < 128 else { return false }
        bindings[id] = Binding(plan: plan, store: store, title: title)
        return true
    }

    func remove(ids: [String]) {
        for id in ids { bindings.removeValue(forKey: id) }
    }

    func answer(id: String, category: String, identifier: String, title: String, body: String,
                destination: RemiNavigationDestination) async -> LocalNotificationAnswerOutcome {
        guard category == LocalQuestionNotificationPlan.categoryIdentifier,
              let binding = bindings.removeValue(forKey: id), binding.plan.destination == destination,
              binding.title == title, binding.plan.body == body,
              binding.store === NativeRelayNotifications.shared.store else { return .refused }
        return await binding.store.answerLocalNotification(binding.plan, identifier: identifier)
    }
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
        if response.actionIdentifier == LocalQuestionNotificationPlan.yesIdentifier ||
            response.actionIdentifier == LocalQuestionNotificationPlan.noIdentifier {
            let content = response.notification.request.content
            let outcome = await MacLocalQuestionActions.shared.answer(id: response.notification.request.identifier,
                category: content.categoryIdentifier, identifier: response.actionIdentifier,
                title: content.title, body: content.body, destination: destination)
            guard outcome != .delivered else { return }
            await MainActor.run {
                MacNotificationRouter.shared.notice = outcome == .uncertain
                    ? "Delivery couldn't be confirmed. Check the current request before answering again."
                    : "This notification can no longer answer the request. Review it in Remi."
                MacNotificationRouter.shared.destination = destination
            }
            return
        }
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
        await MainActor.run {
            MacNotificationRouter.shared.destination = destination
        }
    }
}

enum MacNotificationCoordinator {
    static func requestAuthorization() async {
        await MacNotificationPermission.shared.requestIfNeeded()
    }

    @MainActor static func notify(
        id: String,
        title: String,
        body: String,
        destination: RemiNavigationDestination,
        message: QuestionMessage,
        store: MachineStore
    ) async {
        let plan = store.localQuestionNotification(for: destination)
        let actionsPublished: Bool
        if plan != nil {
            actionsPublished = await NativeRelayNotifications.shared.mergeLocalNotificationCategories(
                [LocalQuestionNotificationPlan.category])
        } else { actionsPublished = false }
        let summariesEnabled = UserDefaults.standard.object(
            forKey: QuestionNotificationSummarizer.preferenceKey
        ) as? Bool ?? true
        let summarizedBody: String
        if let plan, actionsPublished { summarizedBody = plan.body }
        else {
            summarizedBody = summariesEnabled
                ? await QuestionNotificationSummarizer.shared.summary(questionID: id, text: body)
                : QuestionNotificationSummarizer.fallback(for: body)
        }
        guard store.machines.first(where: { $0.id == destination.machineID })?.questions.contains(message) == true else { return }
        let content = UNMutableNotificationContent()
        content.title = PushDisplayText.escape(title)
        content.body = PushDisplayText.escape(summarizedBody)
        if let plan, actionsPublished, store.localQuestionNotification(for: destination) == plan,
           MacLocalQuestionActions.shared.bind(id: id, plan: plan, store: store, title: content.title) {
            content.categoryIdentifier = LocalQuestionNotificationPlan.categoryIdentifier
            content.body = plan.body
        }
        content.sound = .default
        content.userInfo = destinationUserInfo(destination)
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        do { try await UNUserNotificationCenter.current().add(request) }
        catch {
            MacLocalQuestionActions.shared.remove(ids: [id])
            MacNotificationRouter.shared.notice = "The notification couldn't be shown. The request is still available in Remi."
        }
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

    @MainActor static func remove(ids: [String]) {
        MacLocalQuestionActions.shared.remove(ids: ids)
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
    @State private var knownQuestions: Set<RemiNavigationDestination> = []
    @State private var notificationIDs: [RemiNavigationDestination: String] = [:]
    @State private var baselineEstablished = false

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .task { await MacNotificationCoordinator.requestAuthorization() }
            .onChange(of: Set(pending.map(\.destination)), initial: true) { _, newValue in
                guard baselineEstablished else {
                    knownQuestions = newValue
                    baselineEstablished = true
                    return
                }

                let removed = knownQuestions.subtracting(newValue).compactMap { notificationIDs.removeValue(forKey: $0) }
                MacNotificationCoordinator.remove(ids: removed)
                for destination in newValue.subtracting(knownQuestions) {
                    guard let item = pending.first(where: {
                        $0.destination == destination
                    }) else { continue }
                    let id = "remi.mac.question.\(UUID().uuidString.lowercased())"
                    notificationIDs[destination] = id
                    let sessionName = item.machine.sessions.first(where: {
                        $0.sessionId == item.message.sessionId
                    })?.name ?? "A session"
                    Task {
                        await MacNotificationCoordinator.notify(
                            id: id,
                            title: "\(sessionName) needs you",
                            body: item.message.question.text,
                            destination: destination,
                            message: item.message,
                            store: store
                        )
                    }
                }
                knownQuestions = newValue
            }
    }

    private var pending: [(machine: MachineState, message: QuestionMessage, destination: RemiNavigationDestination)] {
        store.machines.flatMap { machine in
            machine.questions.map { message in
                (machine, message, RemiNavigationDestination(machineID: machine.id, sessionID: message.sessionId,
                    questionID: message.question.id, agentID: message.question.agentId))
            }
        }
    }
}
