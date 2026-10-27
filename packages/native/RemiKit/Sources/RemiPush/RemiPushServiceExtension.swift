import Foundation
import UserNotifications

/// Both native NSE targets link this verified-alert owner, never RemiKit/Dpk.
/// A category is published only after opening and rechecking its signed capsule.
open class RemiPushServiceExtension: UNNotificationServiceExtension, @unchecked Sendable {
    private struct Delivery {
        let id: UUID
        let fallback: UNNotificationContent
        let handler: (UNNotificationContent) -> Void
    }
    private let lock = NSLock()
    private let work = DispatchQueue(label: "remi.native.nse.work")
    private var delivery: Delivery?

    public override init() { super.init() }
    public override func didReceive(_ request: UNNotificationRequest,
        withContentHandler handler: @escaping (UNNotificationContent) -> Void) {
        let fallback = UNMutableNotificationContent()
        fallback.title = "Remi needs your attention"
        fallback.body = "Open Remi to view this notification."
        fallback.categoryIdentifier = ""
        // The kind is unknown here, so it is not Time Sensitive; it is still audible, because the
        // push's own sound does not survive replacement content.
        let sound = RemiPushPresentation.extensionSoundsEnabled()
        RemiPushPresentation.apply(.information, sessionID: nil, sound: sound, to: fallback)
        let carrier = request.content.userInfo["remiPush"]
        if let carrier { fallback.userInfo = ["remiPush": carrier] }
        let bytes = carrier.flatMap { try? JSONSerialization.data(withJSONObject: $0) }
        let id = UUID()
        lock.lock()
        let prior = delivery
        delivery = .init(id: id, fallback: fallback, handler: handler)
        lock.unlock()
        if let prior { prior.handler(prior.fallback) }
        work.async { [weak self] in
            guard let self, self.current(id), let bytes else { self?.complete(id, content: nil); return }
            do {
                let store = try RemiPushStore.configured()
                let opened = try store.open(carrier: bytes)
                store.publishActions(for: opened) { [weak self] actions in
                    guard let self, self.current(id) else { return }
                    if let actions {
                        self.completeVerified(id, store: store, opened: opened, category: actions.categoryIdentifier)
                    } else if opened.kind != .dismiss {
                        store.publishReviewAction(for: opened) { [weak self] published in
                            self?.completeVerified(id, store: store, opened: opened,
                                category: published ? RemiPushStore.foregroundCategoryIdentifier(for: opened) : "")
                        }
                    } else { self.completeVerified(id, store: store, opened: opened, category: "") }
                }
            } catch { self.complete(id, content: nil) }
        }
    }
    public override func serviceExtensionTimeWillExpire() {
        lock.lock(); let current = delivery; delivery = nil; lock.unlock()
        if let current { current.handler(current.fallback) }
    }
    private func completeVerified(_ id: UUID, store: RemiPushStore, opened: VerifiedPushNotification, category: String) {
        guard current(id) else { return }
        do {
            try store.recheck(opened)
            let content = UNMutableNotificationContent()
            content.categoryIdentifier = category
            content.userInfo = ["remiPush": try JSONSerialization.jsonObject(with: opened.originalCarrier)]
            if opened.kind != .dismiss { content.title = opened.title; content.body = opened.body }
            if let importance = RemiPushPresentation.importance(for: opened.kind) {
                RemiPushPresentation.apply(importance, sessionID: opened.sessionID,
                    sound: RemiPushPresentation.extensionSoundsEnabled(), to: content)
            }
            try store.recheck(opened)
            complete(id, content: content)
        } catch { complete(id, content: nil) }
    }
    private func current(_ id: UUID) -> Bool {
        lock.lock(); defer { lock.unlock() }; return delivery?.id == id
    }
    private func complete(_ id: UUID, content: UNNotificationContent?) {
        lock.lock()
        guard let current = delivery, current.id == id else { lock.unlock(); return }
        delivery = nil; lock.unlock()
        current.handler(content ?? current.fallback)
    }
}
