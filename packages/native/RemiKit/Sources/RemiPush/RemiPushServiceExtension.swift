import Foundation
import UserNotifications

/// Both native NSE targets link this verified-alert owner, never RemiKit/Dpk.
/// Secure categories remain empty until the native sender has accepted gates.
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
                let content = UNMutableNotificationContent()
                content.categoryIdentifier = ""
                content.userInfo = ["remiPush": try JSONSerialization.jsonObject(with: opened.originalCarrier)]
                if opened.kind != .dismiss { content.title = opened.title; content.body = opened.body }
                try store.recheck(opened)
                self.complete(id, content: content)
            } catch { self.complete(id, content: nil) }
        }
    }
    public override func serviceExtensionTimeWillExpire() {
        lock.lock(); let current = delivery; delivery = nil; lock.unlock()
        if let current { current.handler(current.fallback) }
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
