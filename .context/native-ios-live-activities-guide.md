# Native iOS handoff — Live Activities + content-available + NSE (epic #571, deferred on #575)

The daemon/web/signaling side of issue 6 is done (relay, pre-wake payload, dismissal, status). The remaining pieces need Xcode + an Apple Developer profile + a device, so they're a maintainer task. This is the implementation guide. Team `9DQ459HAZB`, bundle `com.yooz.remi`.

## Already shipped (verify / deploy, no Xcode-target work)

- **`AppDelegate.didReceiveRemoteNotification`** (in the epic) fires the Capacitor reconnect events on a `content-available` push so the connection re-establishes before the user taps. Carries an on-device checklist comment. Verify: background the app, trigger an escalation, confirm the WS reconnects pre-tap.
- **APNS `content-available: 1` + `apns-collapse-id`** (signaling `apns.ts`) + the quiet `dismiss` push. Needs a worker redeploy: `cd packages/signaling && npx cfman wrangler --account yooz-labs deploy`.

## A. Live Activities — the fresh lock-screen status (highest value; the FIFA-style card you showed)

Goal: a lock-screen / Dynamic Island card showing the live agent state (`evaluating → needs you → approved`, the question text, elapsed seconds) with Yes/No buttons.

1. **Add a Widget Extension target** (Xcode → File → New → Target → Widget Extension, check "Include Live Activity"). Bundle `com.yooz.remi.activity`. Add it to the App Store provisioning under team `9DQ459HAZB`.
2. **Entitlements/Info.plist:** set `NSSupportsLiveActivities = YES` in the MAIN app `Info.plist`; add an **App Group** (`group.com.yooz.remi`) to both the app and the widget so they share state.
3. **`ActivityAttributes`** (shared file, both targets):
   ```swift
   struct RemiQuestionActivity: ActivityAttributes {
     struct ContentState: Codable, Hashable {
       var status: String        // evaluating | needs-you | approved | working | idle
       var questionText: String? // "Allow Bash: git push…"
       var sinceEpoch: Double     // for the elapsed counter
     }
     var sessionName: String
     var sessionId: String
     var questionId: String?
   }
   ```
4. **UI:** a small SwiftUI lock-screen view + Dynamic Island regions (compact/expanded). Drive the colour/label off `ContentState.status` (reuse the pill semantics from `session-display.ts`).
5. **Lifecycle wiring** — drive it off the daemon signals that already exist:
   - **Start** when a question escalates / AA starts evaluating. The daemon already broadcasts `session_update('evaluating')` (Phase 5) and the escalated `question`. Start the Activity from a thin Capacitor bridge plugin invoked by the JS layer on those events, or natively on the push.
   - **Update** on each status change (`evaluating → needs-you(=waiting) → approved`) — `Activity.update(...)`. Foregrounded: update locally from the WS `session_update`. Backgrounded: use **ActivityKit push tokens** (below).
   - **End** on `question_resolved` (Phase 7 already broadcasts it for answer / auto-resolve / cancel / `/clear`). `Activity.end(...)`.
6. **ActivityKit push updates (background path):** each `Activity` exposes a `pushToken`; register it with the daemon like the APNS device token (extend the device-token registration). The daemon sends activity-update pushes (`apns-push-type: liveactivity`, the `ContentState` as the payload) through the signaling worker — add a `liveactivity` mode beside the existing `alert`/`dismiss` modes in `signaling/apns.ts` (different APNS topic suffix `.push-type.liveactivity`). Drive these from the Phase-5 status broadcasts + Phase-7 `question_resolved`.
7. **Answer from the Live Activity (iOS 17+):** Live Activities support buttons via **App Intents**. A Yes/No intent answers connection-independently via the **Phase-4a `/answer` relay** (POST `/answer` with the stored daemon URL + signed payload), or falls back to opening the app. This is the lock-screen answer the epic set up the backend for.

## B. Notification Service Extension (NSE) — limited; likely skip

NSE can rewrite a notification's **content** (title/body/attachments) but **cannot** change **action-button titles** — `UNNotificationAction` titles are fixed per `UNNotificationCategory` at registration. So "dynamic button labels via NSE" is not achievable. The notification **body already lists the real options** (Phase 3), which covers the visibility need. Only add an NSE if you later want decrypted/richer content or attachments; otherwise skip.

## Integration points the backend already provides

- **Phase 5** `session_update` (`evaluating`/`approved`/`waiting`/`starting`) → Live Activity `ContentState`.
- **Phase 7** `question_resolved` (answer / auto-resolve / cancel / `/clear`) → end the Activity + clear the delivered notification (the web handler already calls `removeDeliveredNotifications`).
- **Phase 4a** `/answer` relay → Live Activity App-Intent buttons answer without a warm WebSocket.
- **Phase 3** rich question text + option labels → the Activity's `questionText`.

## Provisioning checklist

- App Group `group.com.yooz.remi` on app + widget targets.
- `NSSupportsLiveActivities = YES`.
- Widget bundle id + provisioning profile under team `9DQ459HAZB`.
- (If using ActivityKit push) APNS auth key already used by the signaling worker covers the `liveactivity` push type — no new key, just the topic suffix.
