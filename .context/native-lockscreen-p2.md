# #591 P2 — native silent lock-screen answer (Duo-style)

Goal: answer a held permission from the iOS lock screen **without opening the
app** — iOS background-launches a native handler that signs + relays the answer
to the signaling Worker `/answer/{code}` (the #591 P1 backend). No app foreground.

## De-risked off-device (done)

- **Crypto compat PROVEN** (`packages/shared/tests/ed25519-native-seed-compat.test.ts`):
  the JS identity's PKCS8 private key yields a 32-byte Ed25519 seed (`pkcs8.slice(16)`);
  a signature from that seed alone verifies with the daemon's `verify()` and is
  byte-identical to the full-key signature. CryptoKit's
  `Curve25519.Signing.PrivateKey(rawRepresentation: seed)` is exactly this, so a
  native signature WILL verify on the daemon. No device needed to trust the crypto.
- **No daemon change needed**: the native handler reads the room `code` +
  `signalingUrl` from app-stored connection info (written by JS), and `sessionId`/
  `questionId` from the push payload. The `/answer/{code}` route already ships (P1).

## Architecture

Capacitor 8 owns `UNUserNotificationCenter.delegate` and routes to
`bridge.notificationRouter.pushNotificationHandler` (the push plugin's handler,
which forwards to JS). We **wrap** that handler — native relay first, then
delegate to the captured Capacitor handler — so JS forwarding still works in the
foreground and we never clobber the global delegate.

### Pieces (remaining)

1. **JS -> native bridge** (`@capacitor/preferences`, UserDefaults-backed):
   - On identity load: write `{ seed (32B b64), publicKeyRaw (b64), fingerprint }`.
     (Seed = `pkcs8.slice(16)`; only for an UNENCRYPTED identity — an encrypted one
     can't be bridged without a passphrase, so the lock-screen path is unavailable
     then, same limit as the JS relay.)
   - On connect: write a per-session route `{ sessionId -> { code, signalingUrl, claudeSessionId } }`.
   - Preferences stores under `UserDefaults.standard` key `CapacitorStorage.<key>`,
     which AppDelegate reads natively. (Seed in UserDefaults is no worse than the
     existing localStorage identity; Keychain hardening is a follow-up.)
2. **Native categories**: add a `UNTextInputNotificationAction` category
   (`REMI_TEXT`) for free-text / numbered questions (`userText`).
3. **Native `didReceive` handler** (wrap the router handler):
   - Map `actionIdentifier` (`OPT_0/1/2/3`) to the option value carried in the push
     `data` (`opt_0`, `opt_1`, ...), or `userText` for the text action.
   - Look up the session route + seed from UserDefaults.
   - `beginBackgroundTask`; CryptoKit sign `sessionId|questionId|answer`; URLSession
     POST `signalingUrl/answer/{code}` with `{sessionId, questionId, answer, claudeSessionId?, auth:{signature, clientPublicKey, clientFingerprint}}`; `completionHandler` when done.
   - Then call the captured Capacitor handler's `didReceive` so the JS path still
     fires when the app is alive.
   - Actions WITHOUT `.foreground` (background handling).

### On-device validation (one cycle, after the build)

- Lock screen, app killed, cellular: tap Yes/No -> Claude proceeds; card clears.
- Xcode console: native handler logs the signed POST + the Worker 200.
- Confirm `completionHandler` always called (no background-budget warnings).
- Text-input action returns `userText` and resolves.

### Notes / risks (all on-device-only)

- The notificationRouter handler-wrapping (Capacitor internals) — validate the
  wrap fires for a backgrounded action and Capacitor's JS path still works alive.
- Background execution budget (~30s) — the single URLSession POST is well within it.
- The seed-in-UserDefaults security posture (Keychain hardening follow-up).
