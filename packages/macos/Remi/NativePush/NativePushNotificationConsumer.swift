import Foundation
import UserNotifications

/// Constructible fail-closed scaffold for actual app action/quiet-dismiss callers.
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
    init(state: NativePushState, keys: NativePushKeyStore,
         now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970) },
         readDelivered: @escaping DeliveredReader = { callback in
             UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
                 callback(notifications.map { DeliveredCard(identifier: $0.request.identifier, userInfo: $0.request.content.userInfo) })
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
    func receiveDismiss(userInfo: [AnyHashable: Any], completion: @escaping (DismissOutcome) -> Void) { completion(.unavailable) }
    func receiveAction(userInfo: [AnyHashable: Any], identifier: String) -> ActionOutcome { .unavailable }
}
