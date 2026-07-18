//
//  NotificationManager.swift
//  Remi
//
//  Native macOS notifications for pending Claude Code questions (#786).
//  Same data source as the needs-attention icon state (#787): the hub_status
//  census's `questions` list. The app is a query-mode client with no other
//  way to learn a question is pending — this is the "push" experience iOS
//  already has (APNS), delivered locally with no relay.
//
//  Authorization is requested lazily, the first time a question actually
//  needs posting (not at launch) -- matching the issue's implementation
//  sketch and avoiding a permission prompt for a user who never uses a
//  session that asks questions.
//

import Foundation
import UserNotifications

/// Minimal shape NotificationManager needs from a pending question --
/// decoupled from `HubPendingQuestionFrame` (HubProtocol.swift) so the pure
/// diff logic below has no Codable/networking dependency and is trivially
/// constructible from a test.
struct PendingQuestionNotice: Equatable {
    let id: String
    let sessionName: String
    let label: String
}

/// Pure diff between the previously-seen and newly-received pending-question
/// id sets (#786). Exported as a standalone, side-effect-free function so it
/// can be unit-tested without touching UNUserNotificationCenter at all.
enum NotificationDiff {
    struct Result: Equatable {
        /// Questions whose id was NOT in the previous set -- post one
        /// notification per entry.
        let newQuestions: [PendingQuestionNotice]
        /// Ids that WERE in the previous set but are absent now -- the
        /// question was answered (from any surface) or pruned; withdraw its
        /// notification. Sorted for deterministic test assertions.
        let resolvedIds: [String]
    }

    static func diff(previousIds: Set<String>, current: [PendingQuestionNotice]) -> Result {
        let currentIds = Set(current.map(\.id))
        let newQuestions = current.filter { !previousIds.contains($0.id) }
        let resolvedIds = previousIds.subtracting(currentIds).sorted()
        return Result(newQuestions: newQuestions, resolvedIds: resolvedIds)
    }
}

@MainActor
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    /// LAZY, not constructed in `init()`: `UNUserNotificationCenter.current()`
    /// requires a real app-bundle context and crashes
    /// (`bundleProxyForCurrentProcess is nil`) when called from a process
    /// without one -- notably `RemiTests.xctest`, which is UN-hosted by
    /// design (project.yml) so it never runs inside `Remi.app`.
    /// `HubClientIntegrationTests` constructs real `HubClient` instances
    /// (and therefore a real `NotificationManager` via `HubClient`'s stored
    /// property), so an eager `.current()` in `init()` crashed EVERY test
    /// that merely creates a `HubClient`, not just notification-specific
    /// ones (#786 CI failure). Deferring until the first actual post/
    /// withdraw means a `sync()` call with nothing to report -- the common
    /// case for those tests, which never have a pending question -- never
    /// touches it at all.
    private lazy var center: UNUserNotificationCenter = {
        let c = UNUserNotificationCenter.current()
        c.delegate = self
        return c
    }()
    /// Question ids from the most recent `sync()` call, so the next call can
    /// diff against it. Not persisted across launches: a question still
    /// pending after a relaunch is, correctly, treated as new again (there is
    /// no prior in-process notification to reconcile against).
    private var seenIds: Set<String> = []

    /// Fired when the user clicks/activates a delivered notification (#786).
    /// Set by RemiApp to open the main window + activate the app, mirroring
    /// the "Open Remi" menu item (RemiApp.swift) -- this class has no
    /// `openWindow` environment action of its own to call directly.
    var onNotificationActivated: (() -> Void)?

    /// Called on every `hub_status` frame (#786/#787): diffs the current
    /// pending-question set against what was last synced, posts one
    /// notification per newly-seen id, and withdraws (both delivered and
    /// still-pending) notifications for ids that disappeared -- answered from
    /// the terminal, the phone, or the web UI, all indistinguishable here and
    /// all correctly handled the same way ("answered-anywhere-clears").
    func sync(current: [PendingQuestionNotice]) {
        let diff = NotificationDiff.diff(previousIds: seenIds, current: current)
        seenIds = Set(current.map(\.id))

        if !diff.resolvedIds.isEmpty {
            center.removeDeliveredNotifications(withIdentifiers: diff.resolvedIds)
            center.removePendingNotificationRequests(withIdentifiers: diff.resolvedIds)
        }
        guard !diff.newQuestions.isEmpty else { return }
        requestAuthorizationIfNeeded { [weak self] granted in
            guard granted else { return }
            for question in diff.newQuestions {
                self?.post(question)
            }
        }
    }

    /// Authorization is requested LAZILY (first question that needs posting,
    /// not app launch) per the issue's implementation sketch. Safe to call
    /// repeatedly: `getNotificationSettings` reflects the real OS state, so
    /// an already-decided user is never re-prompted.
    ///
    /// `getNotificationSettings`/`requestAuthorization`'s completion handlers
    /// are `@Sendable` and run on an arbitrary background queue, not
    /// MainActor -- so every hop back into MainActor-isolated state (the
    /// `center` property itself, and `completion`'s body, which in `sync()`
    /// calls the MainActor-isolated `post(_:)`) must go through
    /// `Task { @MainActor in ... }`, same pattern as the delegate callback
    /// below.
    private func requestAuthorizationIfNeeded(_ completion: @escaping (Bool) -> Void) {
        center.getNotificationSettings { [weak self] settings in
            Task { @MainActor [weak self] in
                switch settings.authorizationStatus {
                case .authorized, .provisional:
                    completion(true)
                case .notDetermined:
                    self?.center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                        Task { @MainActor in
                            completion(granted)
                        }
                    }
                case .denied, .ephemeral:
                    // Silently drops the push: the icon state (#787) and the
                    // "N questions waiting" menu line still work (they read
                    // hub_status directly, independent of OS authorization),
                    // but nothing tells the user THIS is why they stopped
                    // getting banners. Tracked in #793.
                    completion(false)
                @unknown default:
                    completion(false)
                }
            }
        }
    }

    private func post(_ question: PendingQuestionNotice) {
        let content = UNMutableNotificationContent()
        content.title = "Claude needs you"
        content.body = "\(question.label) — \(question.sessionName)"
        content.sound = .default
        // Identifier = question id (#786): lets sync() withdraw this exact
        // notification later via removeDeliveredNotifications/
        // removePendingNotificationRequests, and lets a reconnect/re-broadcast
        // of the same still-pending question dedupe by id instead of
        // re-alerting (the diff above never re-posts an id already in
        // seenIds).
        let request = UNNotificationRequest(
            identifier: question.id, content: content, trigger: nil)
        center.add(request)
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Without this, UNUserNotificationCenter suppresses the banner/sound for
    /// a notification posted while the app is foreground -- wrong here since
    /// the menu-bar app has no "foreground" the user perceives the way a
    /// normal app window does; they need the banner regardless.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) ->
            Void
    ) {
        completionHandler([.banner, .sound])
    }

    /// Clicking the notification activates the app and opens the main window
    /// (#786), same pattern as the "Open Remi" menu item.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        Task { @MainActor [weak self] in
            self?.onNotificationActivated?()
        }
        completionHandler()
    }
}
