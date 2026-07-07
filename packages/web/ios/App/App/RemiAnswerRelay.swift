import Foundation
import UserNotifications
import CryptoKit
import UIKit
import Capacitor

/// #591 P2 — native silent lock-screen answer relay (Duo-style).
///
/// Wraps Capacitor's push `NotificationHandlerProtocol` (the handler the router
/// invokes on a notification action) so a lock-screen Yes/No/Always tap is signed
/// and POSTed to the daemon's direct `/answer` endpoint WITHOUT opening the app.
/// The captured Capacitor handler is still invoked, so the JS path keeps working
/// when the app is alive (foreground).
///
/// Gotchas handled (from Capacitor/NotificationRouter.swift):
///  - `pushNotificationHandler` is WEAK -> `shared` retains this instance.
///  - `didReceive` is synchronous and the router calls its completionHandler right
///    after, so `relay()` runs the whole attempt (every guard plus the async
///    POST) under one `beginBackgroundTask`, ended exactly once.
///  - install runs AFTER the push plugin's load() (called from a deferred hook).
///
/// Inputs are bridged from JS via Capacitor Preferences (UserDefaults
/// `CapacitorStorage.*`): the Ed25519 seed/pubkey/fingerprint and a per-session
/// route {wsUrl} — the daemon URL the session is connected on, which the web app
/// pins on hello_ack (the same URL its cold-start push-answer routing uses). The
/// answer POSTs to that daemon's direct `/answer` endpoint (the same one
/// `relayAnswerDirect` uses in-app), signed with the bridged seed. Crypto compat
/// is proven in packages/shared/tests/native-bridge.test.ts.
final class RemiAnswerRelay: NSObject, NotificationHandlerProtocol {
    static let shared = RemiAnswerRelay()

    private weak var wrapped: NotificationHandlerProtocol?
    private var installed = false

    /// Idempotently wrap the bridge's push notification handler. Safe to call
    /// repeatedly (e.g. on every applicationDidBecomeActive).
    func install(bridge: CAPBridgeProtocol?) {
        guard !installed, let router = bridge?.notificationRouter else { return }
        let existing = router.pushNotificationHandler
        // Don't wrap ourselves if somehow already installed.
        if existing === self { installed = true; return }
        wrapped = existing
        router.pushNotificationHandler = self
        installed = true
        NSLog("[remi] RemiAnswerRelay installed (wrapped=\(existing.map { String(describing: type(of: $0)) } ?? "nil"))")
    }

    // MARK: NotificationHandlerProtocol

    func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        // #734: while the app is FOREGROUNDED, iOS presents a push only with
        // the options returned here — and `wrapped ?? []` meant every Remi
        // push showed NOTHING (no banner, no sound) whenever the app happened
        // to be open (session list, another session, or the phone driven via
        // iPhone Mirroring). #734 first special-cased userInfo.questionId
        // (permission cards, the #733 timeout-handoff notice), but review of
        // #738 found the same silence for #672's "unbound Claude session"
        // informational push, which deliberately carries no questionId (it
        // isn't answerable). Remi has exactly one push producer (its own
        // daemon/signaling worker) and every alert-carrying push it sends is
        // meant to interrupt the user — a quiet dismiss push (#585) carries no
        // `aps.alert` and never reaches `willPresent` at all. So: always
        // present with a banner + sound rather than gating on payload shape.
        if #available(iOS 14.0, *) {
            return [.banner, .list, .sound]
        }
        return [.alert, .sound]
    }

    func didReceive(response: UNNotificationResponse) {
        relay(response: response)
        // Keep Capacitor's JS path alive for the foreground/app-open case.
        wrapped?.didReceive(response: response)
    }

    // MARK: Relay

    private func relay(response: UNNotificationResponse) {
        // didReceive is synchronous and the router calls its completion handler
        // right after, so extend execution ourselves for the async work below
        // (~30s budget) — every guard in this method and in post() can trigger
        // an async notifyDeliveryFailure() or POST, so the task starts here,
        // before the first guard, and is the single owner of its lifecycle: it
        // ends exactly once, on whichever path (early return or post()'s async
        // completion) runs. The expiry handler and the URLSession completion
        // can fire on different queues, so serialize with a lock to avoid a
        // double endBackgroundTask race.
        let lock = NSLock()
        var bgTask: UIBackgroundTaskIdentifier = .invalid
        let endTask = {
            lock.lock(); defer { lock.unlock() }
            if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask); bgTask = .invalid }
        }
        bgTask = UIApplication.shared.beginBackgroundTask(withName: "RemiAnswerRelay") { endTask() }

        let userInfo = response.notification.request.content.userInfo
        guard let sessionId = userInfo["sessionId"] as? String,
              let questionId = userInfo["questionId"] as? String else {
            NSLog("[remi] relay: push missing sessionId/questionId; ignoring")
            endTask()
            return
        }

        // Resolve the answer value. Buttons map OPT_<n> -> the option's `value`,
        // carried in the push data as `opt_<n>` (set by the signaling worker).
        // A text/number action returns userText. Default/dismiss are ignored.
        let answer: String?
        if let text = response as? UNTextInputNotificationResponse {
            answer = text.userText
        } else if response.actionIdentifier.hasPrefix("OPT_") {
            let idx = response.actionIdentifier.dropFirst("OPT_".count)
            answer = userInfo["opt_\(idx)"] as? String
        } else {
            answer = nil  // tap / dismiss -> let Capacitor's JS handler open the app
        }
        guard let answerValue = answer, !answerValue.isEmpty else {
            NSLog("[remi] relay: no actionable answer (action=\(response.actionIdentifier)); deferring to app")
            endTask()
            return
        }

        // Route to the daemon: the web app pins the per-session daemon ws URL
        // (CapacitorStorage.remi-native-routes) on hello_ack. POST the answer to
        // that daemon's direct `/answer` endpoint, signed — the same path
        // `relayAnswerDirect` uses in-app. Reachable from the lock screen when the
        // daemon URL is a Tailscale/public host; a LAN-only daemon is not, the
        // same limit the in-app reconnect has.
        guard let route = RemiNativeStore.route(forSession: sessionId), !route.wsUrl.isEmpty else {
            NSLog("[remi] relay: no stored daemon URL for session \(sessionId); cannot relay")
            notifyDeliveryFailure(questionId: questionId)
            endTask()
            return
        }
        let claudeSessionId = (userInfo["claudeSessionId"] as? String) ?? route.claudeSessionId

        let message = "\(sessionId)|\(questionId)|\(answerValue)"
        guard let auth = RemiNativeStore.sign(message: message) else {
            NSLog("[remi] relay: no signing identity stored; cannot relay")
            notifyDeliveryFailure(questionId: questionId)
            endTask()
            return
        }

        post(wsUrl: route.wsUrl, sessionId: sessionId, questionId: questionId,
             answer: answerValue, claudeSessionId: claudeSessionId, auth: auth, endTask: endTask)
    }

    private func post(wsUrl: String, sessionId: String, questionId: String,
                      answer: String, claudeSessionId: String?, auth: RemiNativeStore.Auth,
                      endTask: @escaping () -> Void) {
        // Normalize the daemon ws(s):// URL to http(s):// and target the root
        // `/answer` endpoint (mirrors push-answer-relay.ts `answerUrl`).
        let base = wsUrl
            .replacingOccurrences(of: "wss://", with: "https://")
            .replacingOccurrences(of: "ws://", with: "http://")
        guard var comps = URLComponents(string: base) else {
            NSLog("[remi] relay: bad daemon URL \(base)")
            notifyDeliveryFailure(questionId: questionId)
            endTask()
            return
        }
        comps.path = "/answer"
        comps.query = nil
        comps.fragment = nil
        guard let url = comps.url else {
            NSLog("[remi] relay: cannot build /answer URL from \(base)")
            notifyDeliveryFailure(questionId: questionId)
            endTask()
            return
        }

        var body: [String: Any] = [
            "sessionId": sessionId,
            "questionId": questionId,
            "answer": answer,
            "auth": [
                "signature": auth.signature,
                "clientPublicKey": auth.publicKey,
                "clientFingerprint": auth.fingerprint,
            ],
        ]
        if let cid = claudeSessionId { body["claudeSessionId"] = cid }

        guard let payload = try? JSONSerialization.data(withJSONObject: body) else {
            NSLog("[remi] relay: failed to encode body")
            notifyDeliveryFailure(questionId: questionId)
            endTask()
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = payload
        req.timeoutInterval = 20

        NSLog("[remi] relay: POST \(url.absoluteString) answer=\(answer)")
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            let result = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            if let err = err {
                NSLog("[remi] relay: POST failed: \(err.localizedDescription)")
                self?.notifyDeliveryFailure(questionId: questionId)
            } else if !(200...299).contains(status) {
                NSLog("[remi] relay: POST status=\(status) result=\(result)")
                self?.notifyDeliveryFailure(questionId: questionId)
            } else {
                NSLog("[remi] relay: POST status=\(status) result=\(result)")
            }
            endTask()
        }.resume()
    }

    // MARK: Visible failure

    /// #665: this native relay can run when the app never opens (a mirrored
    /// Watch action or a cold/background launch that dies again right after),
    /// so an NSLog-only failure would be invisible to the user. Mirrors the
    /// wording of the JS `notifyFailure()` in App.tsx, which shows the same
    /// message when a push answer can't be delivered from the web layer.
    /// The identifier is stable per question (falls back to a constant if the
    /// push never carried one), so repeated failures for the same question
    /// replace the prior notification instead of stacking duplicates. No
    /// retry loop (see #612 for the signaling reverse-relay fallback, out of
    /// scope here).
    private func notifyDeliveryFailure(questionId: String?) {
        let content = UNMutableNotificationContent()
        content.title = "Answer not delivered"
        content.body = "Open Remi to respond to the question."
        let identifier = "remi-answer-failure-\(questionId ?? "unknown")"
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error = error {
                NSLog("[remi] relay: failed to schedule delivery-failure notification: \(error.localizedDescription)")
            }
        }
    }
}

/// Reads the JS-bridged identity + routes from Capacitor Preferences
/// (UserDefaults `CapacitorStorage.<key>`) and signs with CryptoKit.
enum RemiNativeStore {
    struct Auth { let signature: String; let publicKey: String; let fingerprint: String }
    struct Route { let wsUrl: String; let claudeSessionId: String? }

    private static let identityKey = "CapacitorStorage.remi-native-identity"
    private static let routesKey = "CapacitorStorage.remi-native-routes"

    /// Sign `message` with the bridged Ed25519 seed. Returns the base64 signature
    /// + the public key (raw, base64) + fingerprint for the daemon's auth block.
    /// Distinguishes "never set up" (silent nil, expected pre-onboarding) from a
    /// corrupt blob / invalid key / signing failure (logged) — mirrors `route()`
    /// below, so a previously-working device suddenly failing to answer isn't
    /// indistinguishable from one that was simply never configured.
    static func sign(message: String) -> Auth? {
        guard let raw = UserDefaults.standard.string(forKey: identityKey) else { return nil }
        guard let data = raw.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: String],
              let seedB64 = obj["seed"], let pub = obj["publicKey"], let fp = obj["fingerprint"],
              let seed = Data(base64Encoded: seedB64)
        else {
            NSLog("[remi] RemiNativeStore: identity blob is corrupt or unreadable")
            return nil
        }
        guard let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) else {
            NSLog("[remi] RemiNativeStore: identity seed is not a valid Curve25519 key")
            return nil
        }
        guard let sig = try? key.signature(for: Data(message.utf8)) else {
            NSLog("[remi] RemiNativeStore: failed to sign with stored identity")
            return nil
        }
        return Auth(signature: sig.base64EncodedString(), publicKey: pub, fingerprint: fp)
    }

    /// Look up the daemon ws URL pinned for a session (written by the web app).
    /// Distinguishes "never set up" (silent nil) from a corrupt blob (logged) so
    /// the two failure modes aren't indistinguishable in the device log.
    static func route(forSession sessionId: String) -> Route? {
        guard let raw = UserDefaults.standard.string(forKey: routesKey) else { return nil }
        guard let data = raw.data(using: .utf8),
              let map = (try? JSONSerialization.jsonObject(with: data)) as? [String: [String: String]]
        else {
            NSLog("[remi] RemiNativeStore: routes blob is corrupt or unreadable")
            return nil
        }
        guard let r = map[sessionId], let wsUrl = r["wsUrl"] else { return nil }
        return Route(wsUrl: wsUrl, claudeSessionId: r["claudeSessionId"])
    }
}
