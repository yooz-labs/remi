import AppKit
import RemiKit
import SwiftUI
import UserNotifications

final class MacNotificationDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }
}

enum MacNotificationCoordinator {
    static func requestAuthorization() async {
        _ = try? await UNUserNotificationCenter.current()
            .requestAuthorization(options: [.alert, .sound])
    }

    static func notify(id: String, title: String, body: String) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
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

    var body: some View {
        Image(systemName: "questionmark.bubble")
            .background {
                if let store {
                    MacQuestionNotificationMonitor(store: store)
                }
            }
            .accessibilityLabel("Remi")
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
                            body: item.message.question.text
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
