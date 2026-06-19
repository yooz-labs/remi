# Native lock-screen answer relay (Duo-style)

Part of #575. Closes the remaining native-iOS gap found in the 0.6.12 live test:
the Model B held-escalation round-trip works **in-app** (WebSocket answer resolves
the held hook), but a **lock-screen answer never reaches the hook**.

## Why it fails today

1. The answer-send logic is JS-only: `notifications.ts` `pushNotificationActionPerformed`
   -> `App.tsx` `handlePushAnswer` -> `/answer` relay. When iOS background-launches the
   app for a non-`.foreground` action, the WKWebView/JS isn't running, so nothing sends.
2. `push-answer-relay.ts` POSTs **directly to the daemon** (LAN/Tailscale only). The
   lock-screen case is exactly the remote case, so direct-to-daemon can't reach the Mac.

## The Cisco-Duo pattern (researched)

Duo answers Approve/Deny from the lock screen without opening the app: iOS
background-launches a **native** handler, which relays the verdict to Duo's **service**.
- A `UNNotificationAction` **without** `.foreground` => iOS background-launches the app and
  calls `userNotificationCenter(_:didReceive:withCompletionHandler:)` (no foreground).
- ~30s background budget; wrap the network call in `beginBackgroundTask`; call
  `completionHandler()` when the relay finishes.
- `UNTextInputNotificationAction` gives a lock-screen text/number field (`userText`) for
  free-text / numbered-pick questions.

Our "service" is the **signaling Worker** (always reachable), not the daemon directly.

## Architecture map (verified against the code)

- **Daemon <-> signaling:** `packages/daemon/src/remote/relay-adapter.ts` (+ `signaling-client.ts`)
  opens a WS to `wss://remi-signaling.yooz.workers.dev/connect/{code}`, registers as `host`,
  sends/receives `{type:'relay', payload:<JSON string>}`. Inbound `relay` -> `routeMessage()`
  -> for `answer` -> `this.events.onAnswer(connId, sessionId, questionId, answer, claudeId)`
  (relay-adapter.ts ~266-280). **This already dispatches to `handleAnswer`.**
- **Worker room:** `packages/signaling/src/connection-room.ts` is a Durable Object keyed by
  the connection **code** (`idFromName(code)`); relays WS<->WS between `host` (daemon) and
  `client` (phone). `index.ts` has `/connect/{code}` (WS upgrade) and `/push` (Bearer-auth,
  daemon->APNS). No phone->daemon HTTP path yet.
- **Answer -> hook:** `input-events.ts` `handleAnswer` -> `mapAnswerToDecision`
  (isNo->deny, isYes-not-always->allow, else null) -> `resolveHeldPermission` ->
  gate `resolveHeld(questionId, decision)`. Needs `{sessionId, questionId, answer}`.
- **Direct `/answer` auth (the model to copy):** `push-answer-relay.ts` signs the canonical
  message `${sessionId}|${questionId}|${answer}` with the phone's Ed25519 identity and sends
  `auth:{signature, clientPublicKey, clientFingerprint}`. The daemon
  (`websocket-server.ts` `handleAnswerRelay`) verifies via
  `authenticator.verifyDetachedRequest(message, sig, pubKey, fingerprint)` (TOFU/authorized-keys).

## The AUTH gap (must fix)

The relay-adapter `onAnswer` path **trusts the relay peer** (the authenticated WS). An
HTTP-injected answer has no WS peer, so we MUST verify the Ed25519 signature daemon-side
before resolving — otherwise anyone with the room code could forge an answer. The relayed
`answer` message therefore carries the same `auth` block, and the relay adapter verifies it
(needs the `Authenticator` injected into the relay adapter).

## Phases

### P1 - backend reverse relay (device-independent, this PR)
1. **Worker** (`index.ts` + `connection-room.ts`): `POST /answer/{code}` (or code in body).
   Body `{sessionId, questionId, answer, claudeSessionId?, auth}`. Look up the room by code,
   forward `{type:'relay', payload: JSON.stringify({type:'answer', ...rest, auth})}` to the
   `host` WS. Add a DO method to forward to the host (today it only relays WS->peer).
   Return delivered / no-peer (503) / not-found (404).
2. **Daemon** (`relay-adapter.ts`): when an inbound relayed `answer` carries `auth`, verify it
   with the injected `Authenticator` before `onAnswer`; reject on bad/missing sig when auth is
   required. Inject the authenticator from `cli.ts`.
3. **Web** (`push-answer-relay.ts`): add a signaling-relay fallback (try direct `/answer`,
   then the Worker `/answer/{code}`) so the in-app-but-remote case also benefits.
4. **Tests (NO MOCKS):** miniflare for the Worker route (forward-to-host + missing-peer);
   real loopback daemon + real Ed25519 sign/verify for the relay-adapter auth path
   (valid sig resolves a held hook; bad/missing sig rejected); web relay-fallback unit test.

### P2 - native iOS (needs Xcode + device)
- `UNTextInputNotificationAction` category for free-text/numbered questions.
- Native `userNotificationCenter(_:didReceive:)` in `AppDelegate` (actions WITHOUT
  `.foreground`): map `actionIdentifier`/`userText` -> answer; `beginBackgroundTask`;
  native Ed25519 sign (device identity from Keychain) + POST to the Worker `/answer/{code}`;
  call `completionHandler` when done.
- Coordinate with Capacitor's `PushNotifications` delegate so the native handler runs even
  when JS is asleep (chain/override).

### P3 - on-device validation
- Lock screen, app killed, cellular: tap Yes/No (and a text answer) -> Claude proceeds; card
  dismisses across clients.
