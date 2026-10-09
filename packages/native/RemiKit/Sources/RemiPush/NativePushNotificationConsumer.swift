import Foundation
import UserNotifications

/// Actual app quiet-dismiss and foreground-presentation boundary. Original
/// capsules and durable lifecycle state, rather than outer routing or NSE flags,
/// grant authority. A v2 notification offers no answer actions before R6, and no
/// v2 response may enter the legacy direct or wrapped-JS answer path.
final class NativePushNotificationConsumer: @unchecked Sendable {
    struct DeliveredCard: Sendable {
        let identifier: String
        let carrier: Data?
        init(identifier: String, userInfo: [AnyHashable: Any]) {
            self.identifier = identifier
            carrier = (try? JSONSerialization.data(withJSONObject: userInfo["remiPush"] as Any))
        }
    }
    enum DismissOutcome: Equatable { case removed(Int), ignored, unavailable }
    typealias DeliveredReader = (@escaping @Sendable ([DeliveredCard]) -> Void) -> Void
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
        let completion: @Sendable (DismissOutcome) -> Void
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
    func receiveDismiss(userInfo: [AnyHashable: Any], completion: @escaping @Sendable (DismissOutcome) -> Void) {
        // Capture only strict, owned capsule bytes across the queue hop.
        let captured: NativePushCodec.Carrier
        do {
            captured = try NativePushCodec.parseCarrier(JSONSerialization.data(withJSONObject: userInfo["remiPush"] as Any))
        } catch { completion(.unavailable); return }
        queue.async { [self] in
            let userInfo: [AnyHashable: Any] = ["remiPush": captured.userInfo]
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
                      let carrier = card.carrier, let original = try? NativePushCodec.parseCarrier(carrier),
                      let candidate = try? NativePushCodec.open(userInfo: ["remiPush": original.userInfo], state: state, keys: keys, now: now()),
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
    /// A v2 card has no answer actions, so a response to one is the default tap
    /// (the OS opens the app) or a stale action; it is consumed here, even when
    /// the capsule is malformed or the native stores are unavailable, and runs
    /// neither the legacy direct relay nor the wrapped JavaScript handler.
    /// A notification without the marker is legacy and runs `legacy`.
    static func routeResponse(userInfo: [AnyHashable: Any], legacy: () -> Void) {
        if userInfo["remiPush"] == nil { legacy() }
    }
    static func isGenericFallback(_ content: UNNotificationContent) -> Bool {
        content.title == "Remi needs your attention" && content.subtitle.isEmpty &&
            content.body == "Open Remi to view this notification." && content.categoryIdentifier.isEmpty
    }
    /// The foreground adapter independently verifies original bytes and exact
    /// displayed text. A signed card carries no category, so any category is
    /// unverified authority and is refused. The fixed generic no-action fallback
    /// grants no authentication, route or option authority.
    func allowsPresentation(_ content: UNNotificationContent) -> Bool {
        if Self.isGenericFallback(content) { return true }
        do {
            let effect = try effectFactory()
            let prepared = try effect.prepare(userInfo: content.userInfo)
            let title: String; let body: String
            switch prepared.push.payload {
            case .question(let question): title = PushDisplayText.escape(question.title); body = PushDisplayText.escape(question.body)
            case .informational(let information): title = PushDisplayText.escape(information.title); body = PushDisplayText.escape(information.body)
            case .dismiss: return false
            }
            guard content.title == title, content.subtitle.isEmpty, content.body == body,
                  content.categoryIdentifier.isEmpty else { return false }
            try effect.recheck(prepared)
            return true
        } catch { return false }
    }
}
