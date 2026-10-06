import Foundation
import UserNotifications

/// #1200: outer push text/category/options grant no native authority. Every
/// secure (remiPush) receive begins with a generic no-action alert; only
/// original-capsule decode plus durable lifecycle commit can replace it while
/// this delivery is live, and then only with the signed text: a secure card has
/// no category and no action buttons (R6 owns native answers), so it opens the app.
///
/// A push WITHOUT the remiPush carrier is the direct-mode plaintext push of
/// #719 and keeps its pre-#1200 behavior exactly: its content and userInfo pass
/// through (RemiAnswerRelay reads sessionId, questionId and opt_n from them) and
/// a single-question or four-option card gets its per-notification dynamic
/// category. That path never opens the secure push state or keys.
class NotificationService: UNNotificationServiceExtension {
    typealias CategoryInstaller = (UNNotificationCategory, @escaping (Bool) -> Void) -> Void
    private struct Delivery {
        let id: UUID
        /// What the OS receives if this delivery expires or fails: the generic
        /// alert for a secure push, the unmodified best attempt for a legacy one.
        let fallback: UNMutableNotificationContent
        let handler: (UNNotificationContent) -> Void
    }
    /// Guards `delivery`; only short critical sections run on it, so an expiry
    /// is never held up behind Keychain or SQLite work.
    private let deliveryQueue = DispatchQueue(label: "remi.nse.delivery")
    private let workQueue = DispatchQueue(label: "remi.nse.work")
    private var delivery: Delivery?
    private let effectFactory: () throws -> NativePushEffect
    private let installCategory: CategoryInstaller

    override init() {
        effectFactory = {
            NativePushEffect(state: try NativePushConfiguration.sharedState(),
                             keys: try NativePushConfiguration.sharedKeyStore())
        }
        installCategory = Self.registerDynamicCategory
        super.init()
    }
    /// Internal OS-boundary injection for owned tests; never exposed through JS.
    init(effectFactory: @escaping () throws -> NativePushEffect,
         installCategory: @escaping CategoryInstaller = NotificationService.registerDynamicCategory) {
        self.effectFactory = effectFactory; self.installCategory = installCategory
        super.init()
    }
    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler handler: @escaping (UNNotificationContent) -> Void) {
        guard request.content.userInfo["remiPush"] != nil else { receiveLegacy(request, handler); return }
        let fallback = UNMutableNotificationContent()
        fallback.title = "Remi needs your attention"
        fallback.body = "Open Remi to view this notification."
        fallback.categoryIdentifier = ""
        // Preserve the ORIGINAL public capsule for independent presentation and
        // quiet-dismiss decode. Outer qid/session/options/verified flags are
        // deliberately not forwarded.
        if let capsule = request.content.userInfo["remiPush"] { fallback.userInfo = ["remiPush": capsule] }
        let id = UUID()
        deliveryQueue.sync {
            if let prior = delivery { delivery = nil; prior.handler(prior.fallback) }
            delivery = Delivery(id: id, fallback: fallback, handler: handler)
        }
        workQueue.async { [weak self] in
            guard let self, self.deliveryQueue.sync(execute: { self.delivery?.id == id }) else { return }
            do {
                let effect = try self.effectFactory()
                // Commits the replay/lifecycle record, then rechecks as its last
                // step; nothing waits between here and the completion below.
                let prepared = try effect.prepare(userInfo: request.content.userInfo)
                let content = UNMutableNotificationContent()
                content.userInfo = ["remiPush": prepared.push.originalCarrier.userInfo]
                // apns-collapse-id makes the delivered notification's identifier the
                // collapse id, so this result REPLACES the live card. An exact
                // duplicate of the latest live digest (#1200) therefore renders the
                // same verified card again; only a terminal capsule shows no text.
                // A capsule that is no longer the latest live revision never gets
                // here (prepare throws) and receives the generic alert instead.
                switch (prepared.outcome, prepared.push.payload) {
                case (.publish, .question(let question)), (.duplicate, .question(let question)):
                    content.title = question.title; content.body = question.body
                case (.publish, .informational(let information)), (.duplicate, .informational(let information)):
                    content.title = information.title; content.body = information.body
                default: break
                }
                // #1200: no category. A verified v2 card opens the app until R6 has
                // a native owner that submits an answer; an action button would be
                // dismissed by iOS on tap and silently drop the user's choice.
                self.deliveryQueue.sync { self.complete(id: id, content: content) }
            } catch { self.deliveryQueue.sync { self.complete(id: id, content: nil) } }
        }
    }
    override func serviceExtensionTimeWillExpire() {
        deliveryQueue.sync { if let id = delivery?.id { complete(id: id, content: nil) } }
    }
    /// All calls run on deliveryQueue. Clear authority before invoking the OS
    /// completion; late category/decrypt work cannot mutate delivered data.
    private func complete(id: UUID, content: UNNotificationContent?) {
        guard let current = delivery, current.id == id else { return }
        delivery = nil
        current.handler(content ?? current.fallback)
    }

    // MARK: Legacy direct-mode pushes (#719)

    /// Process-wide cap on REMI_DYN_* categories accumulated in the registered
    /// set (#719 review). 16 leaves headroom for concurrent teammate questions
    /// while keeping the set finite.
    private static let maxDynCategories = 16
    private static let dynCategoryPrefix = "REMI_DYN_"

    /// Hands back the original content, adding a dynamic category when the push
    /// carries one. Never drops the notification: every guard that is not met,
    /// the extension expiring, or the registration losing its read-back leaves
    /// the daemon's own `categoryIdentifier` (a static category, or none) in
    /// place, so this can only add a better lock-screen experience.
    private func receiveLegacy(_ request: UNNotificationRequest,
                               _ handler: @escaping (UNNotificationContent) -> Void) {
        guard let best = request.content.mutableCopy() as? UNMutableNotificationContent else {
            // A mutableCopy() of a UNNotificationContent always succeeds; the
            // contract is still "never drop the notification".
            handler(request.content); return
        }
        let id = UUID()
        deliveryQueue.sync {
            if let prior = delivery { delivery = nil; prior.handler(prior.fallback) }
            delivery = Delivery(id: id, fallback: best, handler: handler)
        }
        guard let category = Self.dynamicCategory(for: best) else {
            deliveryQueue.sync { complete(id: id, content: best) }; return
        }
        installCategory(category) { [weak self] installed in
            self?.deliveryQueue.sync {
                // After expiry the content is already with the OS; never mutate it.
                guard let self, self.delivery?.id == id else { return }
                // Stamp the id ONLY when the registration is confirmed; otherwise
                // the daemon's static category is displayed instead of an
                // unresolved id that would render with no action buttons at all.
                if installed { best.categoryIdentifier = category.identifier }
                self.complete(id: id, content: best)
            }
        }
    }

    /// The category for opt_0...opt_N in the userInfo, or nil to leave the
    /// daemon's own category in place.
    private static func dynamicCategory(for content: UNMutableNotificationContent) -> UNNotificationCategory? {
        let userInfo = content.userInfo
        // The daemon sets dynCategory="1" only for a single-question prompt with
        // real labels (notification-dispatcher.ts `selectDynOptions`, 2-4 options).
        guard (userInfo["dynCategory"] as? String) == "1",
              let firstLabel = userInfo["opt_0"] as? String, !firstLabel.isEmpty else { return nil }
        // opt_0...opt_5 at most. INVARIANT CHAIN: the daemon gates at 2-4 options,
        // the signaling worker's `wantsDynCategory` and this ceiling allow up to
        // 6. Keep all three in sync if the ceiling moves.
        var labels: [String] = []
        for index in 0...5 {
            guard let label = userInfo["opt_\(index)"] as? String, !label.isEmpty else { break }
            labels.append(label)
        }
        guard labels.count >= 2 else { return nil }
        let actions = labels.enumerated().map { index, label in
            UNNotificationAction(identifier: "OPT_\(index)", title: truncated(label, to: 24),
                                 options: isNegativeLabel(label) ? [.destructive] : [])
        }
        // Keyed by questionId so concurrent distinct questions never collide.
        let questionId = (userInfo["questionId"] as? String) ?? UUID().uuidString
        return UNNotificationCategory(identifier: "\(dynCategoryPrefix)\(questionId)", actions: actions,
                                      intentIdentifiers: [], options: [])
    }

    /// KNOWN RACE (#719): this extension runs in its own process, apart from the
    /// app that registers REMI_YN/YNA/MULTI at launch, so the CURRENT set is read
    /// and ours merged in, never replaced wholesale. setNotificationCategories
    /// has no completion handler, so the read-back is the only way to tell the
    /// registration landed before the notification displays.
    private static func registerDynamicCategory(_ category: UNNotificationCategory, completion: @escaping (Bool) -> Void) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationCategories { existing in
            var merged = existing
            let dynamic = merged.filter { $0.identifier.hasPrefix(dynCategoryPrefix) }
            if dynamic.count >= maxDynCategories {
                // Evict an arbitrary excess (Set order is unspecified, which is
                // acceptable) so the set stays finite. An evicted category only
                // degrades an OLD notification to no buttons; tapping it still
                // opens the app. Do NOT prune every other REMI_DYN_*: concurrent
                // questions need their own categories.
                for old in dynamic.prefix(dynamic.count - (maxDynCategories - 1)) { merged.remove(old) }
            }
            merged.insert(category)
            center.setNotificationCategories(merged)
            center.getNotificationCategories { confirmed in
                completion(confirmed.contains { $0.identifier == category.identifier })
            }
        }
    }

    /// True for an honest negative answer ("No", "No, thanks"), never for a label
    /// that merely starts with the letters "No", such as "Norway" or "Node.js".
    private static func isNegativeLabel(_ label: String) -> Bool {
        label == "No" || label.hasPrefix("No ") || label.hasPrefix("No,")
    }
    private static func truncated(_ text: String, to maxLength: Int) -> String {
        text.count > maxLength ? "\(text.prefix(maxLength))…" : text
    }
}
