import Foundation
import UserNotifications

/// Actual app action/quiet-dismiss boundary. Original capsules and durable
/// lifecycle state, rather than outer routing or NSE flags, grant authority.
/// No v2 action may enter the legacy direct or wrapped-JS answer path.
final class NativePushNotificationConsumer {
    struct DeliveredCard { let identifier: String; let userInfo: [AnyHashable: Any] }
    enum DismissOutcome: Equatable { case removed(Int), ignored, unavailable }
    enum ActionOutcome: Equatable { case verifiedOpenApp, unavailable }
    typealias DeliveredReader = (@escaping ([DeliveredCard]) -> Void) -> Void
    typealias DeliveredRemover = ([String]) -> Void
    private let effectFactory: () throws -> NativePushEffect
    private let state: NativePushState
    private let keys: NativePushKeyStore
    private let readDelivered: DeliveredReader
    private let removeDelivered: DeliveredRemover
    private let now: () -> Int64
    private let queue = DispatchQueue(label: "remi.push.notification-consumer")
    private struct Pending {
        let prepared: NativePushEffect.Prepared
        let effect: NativePushEffect
        let deadline: UInt64
        let completion: (DismissOutcome) -> Void
    }
    private var pending: [UUID: Pending] = [:]
    init(state: NativePushState, keys: NativePushKeyStore,
         now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970) },
         readDelivered: @escaping DeliveredReader = { callback in
             UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
                 callback(notifications.prefix(129).map { DeliveredCard(identifier: $0.request.identifier, userInfo: $0.request.content.userInfo) })
             }
         }, removeDelivered: @escaping DeliveredRemover = { identifiers in
             UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: identifiers)
         }) {
        self.state = state; self.keys = keys; self.now = now
        self.effectFactory = { NativePushEffect(state: state, keys: keys, now: now) }
        self.readDelivered = readDelivered; self.removeDelivered = removeDelivered
    }
    static func configured() throws -> NativePushNotificationConsumer {
        NativePushNotificationConsumer(state: try NativePushConfiguration.sharedState(), keys: try NativePushConfiguration.sharedKeyStore())
    }
    func receiveDismiss(userInfo: [AnyHashable: Any], completion: @escaping (DismissOutcome) -> Void) {
        queue.async { [self] in
            guard pending.count < 32 else { completion(.unavailable); return }
            do {
                // Refuse non-dismiss before preparation: a background wake for a
                // question must not consume its nonce and suppress its later NSE.
                let opened = try NativePushCodec.open(userInfo: userInfo, state: state, keys: keys, now: now())
                guard case .dismiss = opened.payload else { completion(.ignored); return }
                let effect = try effectFactory()
                let prepared = try effect.prepare(userInfo: userInfo)
                let id = UUID()
                pending[id] = Pending(prepared: prepared, effect: effect,
                    deadline: DispatchTime.now().uptimeNanoseconds + 2_000_000_000, completion: completion)
                queue.asyncAfter(deadline: .now() + 2) { [self] in finish(id, outcome: .unavailable) }
                // The OS continuation holds only an ID. A timeout releases the
                // decoded payload/context even if the OS never calls back.
                readDelivered { [weak self] cards in
                    guard let self else { return }
                    guard cards.count <= 128 else {
                        self.queue.async { [weak self] in self?.finish(id, outcome: .unavailable) }; return
                    }
                    self.queue.async { [weak self] in self?.removeVerifiedCards(cards, id: id) }
                }
            } catch { completion(.unavailable) }
        }
    }
    private func finish(_ id: UUID, outcome: DismissOutcome) {
        guard let current = pending.removeValue(forKey: id) else { return }
        current.completion(outcome)
    }
    private func removeVerifiedCards(_ cards: [DeliveredCard], id: UUID) {
        guard let current = pending[id] else { return }
        guard DispatchTime.now().uptimeNanoseconds < current.deadline else { finish(id, outcome: .unavailable); return }
        do {
            try current.effect.recheck(current.prepared)
            var identifiers: [String] = []
            for card in cards {
                guard !card.identifier.isEmpty, card.identifier.utf8.count <= 256,
                      let candidate = try? NativePushCodec.open(userInfo: card.userInfo, state: state, keys: keys, now: now()),
                      candidate.record.rid == current.prepared.push.record.rid,
                      candidate.record.collapseId == current.prepared.push.record.collapseId,
                      candidate.record.kind != 6,
                      candidate.record.revision <= current.prepared.push.record.revision else { continue }
                if !identifiers.contains(card.identifier) { identifiers.append(card.identifier) }
            }
            guard DispatchTime.now().uptimeNanoseconds < current.deadline else { finish(id, outcome: .unavailable); return }
            // Existing P256 read, captured generation and latest TERMINAL digest
            // are rechecked again immediately before the actual OS removal.
            try current.effect.recheck(current.prepared)
            if !identifiers.isEmpty { removeDelivered(identifiers) }
            finish(id, outcome: .removed(identifiers.count))
        } catch { finish(id, outcome: .unavailable) }
    }
    /// A v2 marker is never permission to fall back to a second answer owner.
    /// Even malformed capsules or unavailable native stores are consumed here.
    static func routeAction(userInfo: [AnyHashable: Any], identifier: String,
                            consumerFactory: () throws -> NativePushNotificationConsumer = configured,
                            legacy: () -> Void) -> Bool {
        guard userInfo["remiPush"] != nil else { legacy(); return false }
        if let consumer = try? consumerFactory() { _ = consumer.receiveAction(userInfo: userInfo, identifier: identifier) }
        return true
    }
    static func isGenericFallback(_ content: UNNotificationContent) -> Bool {
        content.title == "Remi needs your attention" && content.subtitle.isEmpty &&
            content.body == "Open Remi to view this notification." && content.categoryIdentifier.isEmpty
    }
    /// The foreground adapter independently verifies original bytes and exact
    /// displayed text/category. The fixed generic no-action fallback grants no
    /// authentication, route or option authority.
    func allowsPresentation(_ content: UNNotificationContent) -> Bool {
        if Self.isGenericFallback(content) { return true }
        do {
            let effect = try effectFactory()
            let prepared = try effect.prepare(userInfo: content.userInfo)
            let title: String; let body: String
            switch prepared.push.payload {
            case .question(let question): title = question.title; body = question.body
            case .informational(let information): title = information.title; body = information.body
            case .dismiss: return false
            }
            guard content.title == title, content.subtitle.isEmpty, content.body == body else { return false }
            let category = "REMI_SECURE_\(prepared.push.originalCarrier.rid)_\(prepared.push.record.collapseId)_\(prepared.push.record.revision)"
            guard content.categoryIdentifier.isEmpty || (!prepared.actions.isEmpty && content.categoryIdentifier == category) else { return false }
            try effect.recheck(prepared)
            return true
        } catch { return false }
    }
    func receiveAction(userInfo: [AnyHashable: Any], identifier: String) -> ActionOutcome {
        do {
            _ = try effectFactory().action(userInfo: userInfo, identifier: identifier)
            // R5 consumes the v2 action here. R6 will add the sole native owner;
            // neither legacy direct POST nor wrapped JavaScript submits it now.
            return .verifiedOpenApp
        } catch { return .unavailable }
    }
}
