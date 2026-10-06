import Foundation
import UserNotifications

/// #1200: outer push text/category/options grant no native authority. Every
/// receive begins with a generic no-action alert; only original-capsule decode
/// plus durable lifecycle commit can replace it while this delivery is live.
class NotificationService: UNNotificationServiceExtension {
    typealias CategoryInstaller = (UNNotificationCategory, @escaping (Bool) -> Void) -> Void
    private struct Delivery {
        let id: UUID
        let fallback: UNMutableNotificationContent
        let handler: (UNNotificationContent) -> Void
    }
    private let deliveryQueue = DispatchQueue(label: "remi.nse.delivery")
    private var delivery: Delivery?
    private let effectFactory: () throws -> NativePushEffect
    private let installCategory: CategoryInstaller

    override init() {
        effectFactory = {
            NativePushEffect(state: try NativePushConfiguration.sharedState(),
                             keys: try NativePushConfiguration.sharedKeyStore())
        }
        installCategory = Self.registerCategory
        super.init()
    }
    /// Internal OS-boundary injection for owned tests; never exposed through JS.
    init(effectFactory: @escaping () throws -> NativePushEffect,
         installCategory: @escaping CategoryInstaller = NotificationService.registerCategory) {
        self.effectFactory = effectFactory; self.installCategory = installCategory
        super.init()
    }
    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler handler: @escaping (UNNotificationContent) -> Void) {
        let fallback = UNMutableNotificationContent()
        fallback.title = "Remi needs your attention"
        fallback.body = "Open Remi to view this notification."
        fallback.categoryIdentifier = ""
        // Preserve the ORIGINAL public capsule for independent action/UI decode.
        // Outer qid/session/options/verified flags are deliberately not forwarded.
        if let capsule = request.content.userInfo["remiPush"] { fallback.userInfo = ["remiPush": capsule] }
        let id = UUID()
        deliveryQueue.sync {
            if let prior = delivery { delivery = nil; prior.handler(prior.fallback) }
            delivery = Delivery(id: id, fallback: fallback, handler: handler)
        }
        deliveryQueue.async { [weak self] in
            guard let self, self.delivery?.id == id else { return }
            guard request.content.userInfo["remiPush"] != nil else { self.complete(id: id, content: nil); return }
            do {
                let effect = try self.effectFactory()
                let prepared = try effect.prepare(userInfo: request.content.userInfo)
                let content = UNMutableNotificationContent()
                content.userInfo = ["remiPush": prepared.push.originalCarrier.userInfo]
                switch prepared.push.payload {
                case .question(let question): content.title = question.title; content.body = question.body
                case .informational(let information): content.title = information.title; content.body = information.body
                case .dismiss: break
                }
                guard prepared.outcome == .publish else {
                    // Duplicates/terminal capsules never reinstall a permission card.
                    content.title = ""; content.body = ""; content.sound = nil
                    try effect.recheck(prepared)
                    self.complete(id: id, content: content)
                    return
                }
                guard !prepared.actions.isEmpty else {
                    try effect.recheck(prepared)
                    self.complete(id: id, content: content)
                    return
                }
                let category = Self.category(prepared)
                self.installCategory(category) { [weak self] installed in
                    self?.deliveryQueue.async { [weak self] in
                        guard let self, self.delivery?.id == id else { return }
                        do {
                            try effect.recheck(prepared)
                            if installed { content.categoryIdentifier = category.identifier }
                            self.complete(id: id, content: content)
                        } catch { self.complete(id: id, content: nil) }
                    }
                }
            } catch { self.complete(id: id, content: nil) }
        }
    }
    override func serviceExtensionTimeWillExpire() {
        deliveryQueue.sync { if let id = delivery?.id { complete(id: id, content: nil) } }
    }
    /// All calls run on deliveryQueue. Clear authority before invoking the OS
    /// completion; late category/decrypt callbacks cannot mutate delivered data.
    private func complete(id: UUID, content: UNNotificationContent?) {
        guard let current = delivery, current.id == id else { return }
        delivery = nil
        current.handler(content ?? current.fallback)
    }
    private static func category(_ prepared: NativePushEffect.Prepared) -> UNNotificationCategory {
        let actions = prepared.actions.enumerated().map { index, option in
            var options: UNNotificationActionOptions = option.isNo ? [.foreground, .destructive] : [.foreground]
            if option.standingGrant != nil { options.insert(.authenticationRequired) }
            return UNNotificationAction(identifier: "OPT_\(index)", title: NativePushEffect.actionTitle(option), options: options)
        }
        return UNNotificationCategory(identifier: "REMI_SECURE_\(prepared.push.originalCarrier.rid)_\(prepared.push.record.collapseId)_\(prepared.push.record.revision)",
                                      actions: actions, intentIdentifiers: [], options: [])
    }
    private static func registerCategory(_ category: UNNotificationCategory, completion: @escaping (Bool) -> Void) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationCategories { existing in
            var merged = existing
            let secure = merged.filter { $0.identifier.hasPrefix("REMI_SECURE_") }
            for old in secure.prefix(max(0, secure.count - 15)) { merged.remove(old) }
            merged.insert(category)
            center.setNotificationCategories(merged)
            center.getNotificationCategories { confirmed in
                completion(confirmed.contains(where: { $0 == category }))
            }
        }
    }
}
