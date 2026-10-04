# Relay rebuild plan (epic, proposed 2026-10-04)

Status: APPROVED DIRECTION, owner decisions recorded 2026-10-04 (section 8); nothing here is built yet except the R0 hotfix in flight (#1193).
Scope: strategy section 9 (`.context/strategy-2026-10.md`), rewritten against a verified audit of what the code does today.
Evidence: two read-only research passes on 2026-10-04: an audit of remi's own relay (every claim traced to a caller; items marked [EXEC] were reproduced against the real class with a scratch test) and a study of Paseo's relay (Apache-2.0).
Rule for implementers (ADR 0011): every sentence you write about what the relay does must be true of the code you ship, and anything not verified live is labeled unverified.

## 1. What the audit found (verified, 2026-10-04, develop at 2526fc67)

The strategy's section 9 understated the problem. The relay is not a half-built E2E channel: it is a daemon half with no client.

1. **No shipped client can reach the relay.** The web client has no code that opens `/connect/<code>` or sends `join`; the connect-by-code tab never renders (`packages/web/src/App.tsx:3101-3112` omits `onConnectCode`; `ConnectModal.tsx:28, 407-408, 457`); `mode: 'relay'` is never assigned (`useConnectionManager.ts:68, 586`); the macOS and iOS native code contain no signaling URL. The room code is printed only by `console.log` (`relay-adapter.ts:194, 201, 206`), which the wrapper redirects to a log file (`cli.ts:2523`); there is no QR anywhere.
2. **It is on by default and exposed.** `network.relay = true` (`config/config.ts:281`) and every process registers a room: wrapper sessions, `--daemon`, the hub and each hub-spawned child (`cli.ts:2066-2099, 2223, 2552`). In the default mode (rotating code, no authenticator) the adapter accepts a peer immediately and attaches it to the primary session while its own outbound traffic is refused (`relay-adapter.ts:224-233, 259, 692-696`). Anyone who learns the 30-bit code can send input to the session [EXEC]. The code space is 23^4 x 8^4, about 2^30 (`code-generator.ts:11-18`). Fix in flight: #1193 (relay off by default, fail closed).
3. **The room is the code.** One Durable Object per code (`index.ts:172-174`); the first socket to send `register` becomes host with no proof (`connection-room.ts:244-279`); the code is simultaneously room name, routing key and pairing secret; the `join` code check is redundant with the URL (`connection-room.ts:289`).
4. **Rooms die every 5 minutes and nothing keeps them alive.** `expiresAt = now + 300000` is written only at registration (`connection-room.ts:262`); the alarm closes both peers [EXEC]; the daemon reconnects after a fixed 5 s and, in the default mode, with a NEW code (a new Durable Object) every time (`signaling-client.ts:73-76, 118-124, 162-171`). No ping exists anywhere in the path; a `{"type":"ping"}` frame gets an error [EXEC]. The "idle reaped in ~60 s" claim is unverified.
5. **Crypto engages in one mode only**: `--auth --permanent-code` (`cli.ts:2073-2087`); `--auth` alone does not (`cli.ts:2088-2095`); the LaunchAgent and systemd units run plain `remi serve`, so a long-lived install is always the default mode. In the permanent mode the primitives are sound (ephemeral P-256 ECDH, Ed25519 signatures over a length-prefixed transcript, HKDF into two directional AES-256-GCM keys: `relay-crypto.ts:84-164`) but: the handshake is plaintext (the Worker sees the identity keys and fingerprints of both sides, `authenticator.ts:86-127`), nonces are 12 random bytes with no AAD, no counter and no replay window (the Worker can replay, reorder or drop ciphertext undetected within a session; no test covers it), trust-on-first-use auto-accepts the first key presented (`cli.ts:1980`, `authenticator.ts:223-231`) so the 30-bit code is the only gate, and sends are not ordered (`encryptRelayPayload(...).then(sendRelay)`, `relay-adapter.ts:698-700`).
6. **Any peer can kill a live encrypted session**: a non-ciphertext frame, or a Worker-forwarded `/answer`, makes the adapter drop the real phone (`relay-adapter.ts:244-257`) [EXEC].
7. **Push is plaintext end to end.** The daemon POSTs token, title, body, sessionId, questionId, category, option labels and kind to the Worker `/push`, which forwards them to APNS (`notification-dispatcher.ts:215-250`, `push-client.ts:86-131`, `signaling/src/index.ts:212-395`, `apns.ts:69-128`). `/push` authenticates only if the Worker has `PUSH_SECRET` and the daemon sends it only if configured (`index.ts:219-227`, `cli.ts:404`): which state is deployed is unknown. The Notification Service Extension has no key, no keychain and no app-group access; the entitlements files hold only `aps-environment`. The phone identity lives in WebView localStorage; only an unencrypted seed is mirrored to UserDefaults. `mutable-content` is set only when `dynOptions` is true.
8. **Lock-screen answers never touch the Worker today.** `RemiAnswerRelay.swift:148-170` POSTs to the daemon's own `/answer`; the Worker `/answer/<code>` route, the daemon's relayed-answer handler and the JS sealed sender are built and tested but have no production caller (#878: the room and URL reach the phone by no path). Off-network answers are therefore dropped (verified); a passphrase-protected identity cannot sign them at all.
9. **Raw PTY bytes are forwarded** to a relay peer when keys exist (`pty-session-setup.ts:262-268`, one message per PTY chunk, no batching); the web client discards them (`App.tsx:1746-1752`). That the Durable Object wall-clock is "the cost driver" is NOT established by the code; billing is unmeasured.
10. **Tests.** No test composes the Worker, the daemon adapter and a client; nothing runs under workerd or miniflare and CI only typechecks the Worker (`ci.yml:57-63`); every integration test that spawns a daemon passes `--no-relay`; `relay-encryption.test.ts` uses a test-local client and has an assertion that cannot fail (line 229) and a plaintext-refused check that cannot fail [EXEC]; `relay-adapter-auth.test.ts` never constructs a `RelayAdapter`. The Worker is deployed by hand (no workflow).
11. **License boundary.** `packages/daemon` and `packages/shared` are Apache-2.0 and may not import PolyForm Shield code (`packages/web`, `packages/signaling`, `packages/macos`); `license-boundary.test.ts` scans `src` only. The Worker already imports `@remi/shared` (allowed direction). The wire contract is duplicated across the boundary (Worker `types.ts`; the daemon's `SignalingClient` re-declares it ad hoc, `signaling-client.ts:94-112`).

Hub and children today: each process registers separately; the hub has no proxy to its children; `daemonPorts` are bare loopback port numbers; the capability token (#869) only binds when an authenticator exists (`peer-helpers.ts:85-96`) and `require_local_auth` defaults to false (`config.ts:277`).

## 2. What Paseo showed (and what it did not)

Paseo's production relay (`getpaseo/paseo-relay`, Elixir on Fly; its Durable Object adapter is legacy and undeployed) is a generic pipe keyed by a machine id with one control socket per machine, a relay-assigned connection id per client and a data socket per connection. That topology matches the strategy's per-machine room and is worth borrowing. Everything else is weaker than remi's target: no relay authentication (a second `role=server` socket with the same id displaces the daemon; closed as not planned), no pairing secret apart from a permanent public key in the QR, no phone identity, no revocation, no replay or ordering protection (its own SECURITY.md says so; its public docs overstate it), no forward secrecy against theft of the daemon key, and push is a plaintext preview through Expo with no Notification Service Extension. Its relay-package e2e drives primitives, not the channel classes. Conclusion: do not adopt it; borrow the topology idea; keep its eleven questions. License is Apache-2.0 with mixed holder strings and no NOTICE; a clean-room reimplementation avoids every attribution question.

## 3. Target design

Decisions below are the lead's recommendation; those marked (OWNER) need a decision in section 8.

### 3.1 Identity, pairing, trust

- **Machine identity** = the Ed25519 identity the Authenticator already keeps, owned by the HUB. Always on; created at first run, stored with the existing identity code. (The relay is the only consumer of this identity; direct connections keep their own auth.)
- **Room id** = the first 128 bits of SHA-256 of the machine public key (public, derivable from the QR, not a secret). The Worker verifies host registration with a signature over a Worker-issued nonce and checks that the hash of the presented public key equals the room id, so knowing a room id cannot displace the host, and the Worker stores nothing for this. (OWNER: Worker also admits only enrolled device keys, see 3.2.)
- **Device identity** = a persistent Ed25519 key plus an ECDH key per phone, created on first launch and held in the platform keychain (shared with the Notification Service Extension through an App Group or keychain-sharing group). The current WebView localStorage identity is the migration source, not the target.
- **Pairing token**: the QR carries the relay URL, the machine public key, a one-time 128-bit pairing secret (TTL 10 minutes, single use, created by `remi pair`), and the daemon's push-sealing public key. Pairing binds the device key to the machine: the phone proves possession of the pairing secret inside the handshake (it is mixed into the key derivation, never sent), the daemon enrolls the device public key into the authorized-keys store (existing), and a human-visible fingerprint on both ends confirms it. Trust-on-first-use without a pairing secret is deleted.
- **Revocation**: `remi devices` lists enrolled phones, `remi devices revoke <id>` removes one; the hub tells the Worker (if admission is Worker-enforced) and drops live channels for that key.

### 3.2 Worker (PolyForm Shield, Durable Object)

- One Durable Object per machine; no TTL; the room lives while the host socket lives. WebSocket auto-response ping/pong at the edge so idle sockets do not wake the object; app-level heartbeats only while a client is attached. Host re-registration notifies waiting clients (today it does not).
- Topology borrowed from Paseo: one control socket per machine; the Worker assigns a connection id to each client and tells the host (`connected`/`disconnected`); client frames are piped to the host over that connection. The host (hub) multiplexes sessions inside the encrypted channel; the Worker never sees a session id.
- Admission (OWNER decision A or B): (A, recommended) the host registers the set of enrolled device public keys with the object over its authenticated socket; a client joins only with a signature over a Worker-issued nonce from an enrolled key (plus the pairing secret hash during the pairing window); strangers cannot hold a client slot or spam the host, and revocation is enforced at the edge. (B) the Worker admits any socket that names the room and the host decides inside the channel: simpler Worker, but strangers can hold slots and burn host CPU.
- Global rate limiting through a Durable Object (the current limiter is in-memory per isolate and skipped when the IP header is absent), room-creation abuse limits, `/push` authentication per machine (signature by the machine key plus a per-deployment secret), `/answer/<code>` and the offer/answer/ice-candidate forwarding deleted.
- No compatibility burden for old clients (none exist); the old routes stay only until the new Worker is deployed. Legacy `/push` stays until pushed-to app builds update (section 3.5).

### 3.3 Channel and frames (Apache-2.0, in `packages/shared`)

- A versioned envelope defined once in `packages/shared` (the daemon, the Worker and the clients all import it; the daemon never imports Worker code): `{v, type, seq, ...}` for control, binary or base64 ciphertext for data.
- Handshake: keep the audited shape (ephemeral ECDH on both sides, Ed25519 signatures, HKDF into two directional keys) and fix what the audit found: bind the whole transcript (version, room id, both ephemeral keys and nonces) into the KDF and the signatures; mix the pairing secret into the KDF during pairing; authenticate the host to the client BEFORE the client reveals its identity; send the client's proof of its device key inside the encrypted channel; add key confirmation (exact message flow in section 3.3.1). With Worker admission (decision A) the Worker necessarily sees device PUBLIC keys at admission (pseudonymous: no names), room ids, IP addresses, timing and sizes; it never sees a session id, a device name or any frame content. State that metadata exposure in the ADR and the README; do not describe the relay as hiding it.
- Data: AES-256-GCM, per-direction keys, nonce = 32-bit zero prefix plus a 64-bit send counter, AAD = version, direction, counter; the receiver accepts only strictly increasing counters on the ordered WebSocket (replay, reorder, drop, truncation become detectable errors that tear the channel down and re-handshake); an ordered send queue replaces the unordered `then(sendRelay)`. A reconnect is a new handshake with new keys; session state lives in the application, not in the key.
- What crosses the relay: decisions, answers, the session list, status, chat history and turn events, notifications. Raw PTY output never does (it is dropped before the relay adapter; a separate opt-in channel can be designed later). Frame size and backpressure limits are part of the spec.
- Test vectors for every primitive and the full handshake are committed so the native (CryptoKit) and web (WebCrypto) implementations are checked against the same bytes.

#### 3.3.1 R1 specification (the lead's design; R1 implements it, the independent cryptography review attacks it)

Names: machine identity `(M_sk, M_pk)` Ed25519 (the hub's); device identity `(D_sk, D_pk)` Ed25519; per-connection ephemeral P-256 ECDH pairs `(e_h, E_h)` host and `(e_c, E_c)` client; `rid` = first 16 bytes of SHA-256(`M_pk`), the room id; `v` = the protocol version, 2 (the daemon-half protocol audited above is version 1 and is removed, not negotiated: a client or host that sees another version closes). All signatures cover a context string, `"remi-relay-v2 host"` or `"remi-relay-v2 client"`, followed by a length-prefixed transcript, as `relay-crypto.ts` already does.
1. Worker admission, before any E2E bytes (Worker layer): the Worker sends a fresh nonce; the host answers `{M_pk, sig_M(nonce)}` and the Worker checks SHA-256(`M_pk`) = `rid`; a client answers `{D_pk, sig_D(nonce)}` and the Worker admits it only if `D_pk` is in the room's enrolled set (kept in the Durable Object, changed only by the host over its authenticated socket: `enroll`, `revoke`), or, during a pairing window the host opened, if it presents `A = HMAC(pairing_secret, "admit")` whose SHA-256 the host registered with a TTL (single use). The Worker never learns the pairing secret and cannot derive any key.
2. `hello` (client to host, plaintext): `{v, E_c, n_c (32 random bytes), mode: "pair" | "resume"}`.
3. `hello_ack` (host to client, plaintext): `{v, E_h, n_h (32 random bytes), sig_h}`, `sig_h` = Ed25519 by `M_sk` over `H1 = SHA-256(rid || v || E_c || n_c || E_h || n_h)`. The client verifies `sig_h` against `M_pk` from the QR (pair) or its stored trust (resume) and stops if it fails, so a malicious Worker cannot impersonate the host.
4. Both sides compute `Z = ECDH(e_c, E_h)` and `prk = HKDF-Extract(salt = H1, ikm = Z || psk)` where `psk` is the 32-byte pairing secret in pair mode and empty in resume mode. `k_c2h = HKDF-Expand(prk, "remi-relay-v2 c2h", 32)`, `k_h2c = HKDF-Expand(prk, "remi-relay-v2 h2c", 32)`. A client without the right pairing secret derives different keys and its next message fails authentication.
5. `auth` (client to host, encrypted under `k_c2h`, counter 0): `{D_pk, sig_c, device_name?}` with `sig_c` = Ed25519 by `D_sk` over `H2 = SHA-256(H1 || sig_h)`. The host checks `D_pk` is enrolled (resume) or that the pairing secret is valid, unexpired and unused (pair: it then enrolls `D_pk` and burns the secret). Both ends show the same short fingerprint of `D_pk || M_pk` in pair mode for a human check.
6. `ready` (host to client, encrypted under `k_h2c`, counter 0): `{ok, enrolled}`; its successful decryption is the key confirmation; the channel is open only after it.
7. Data: AES-256-GCM, `nonce = 0x00000000 || be64(counter)`, one counter per direction starting at 1 after the handshake, `aad = "remi-relay-v2" || v || direction byte || be64(counter)`. The receiver accepts only `counter = last + 1`; any gap, repeat or reorder, any tag failure, or a counter above 2^40 closes the channel; there is no resumption: a reconnect is a new handshake with fresh ephemeral keys and nonces (forward secrecy against a later theft of `M_sk` or `D_sk`). Frames are sent through one ordered queue; encryption never reorders them.
8. Failure behavior: every parse or verification failure closes the socket with a reason that reveals nothing about which check failed; no plaintext fallback exists; an unknown version, mode or message type closes.
9. Push sealing (R5) reuses the ECIES shape of `sealed-answer.ts` with the device's push key: `aad = rid || question_id`; the question id is also the collapse id.
Everything in this subsection is a design to be attacked, not a finished protocol: R1's independent review may change it, and the ADR records what changed and why.

### 3.4 Daemon: hub-owned relay

- `remi serve` (the hub) owns the one machine room; session daemons and wrapper sessions always run with relay registration off; the hub proxies session-targeted frames to the session daemon's loopback port over a WebSocket authenticated with the capability token. This needs #869 parts 2 and 3 (#872, #873) first: the token must bind by default and `require_local_auth` must default on, otherwise any local process can drive any session through the loopback listener.
- Reconnect with exponential backoff and jitter (replacing the fixed 5 s); never rotate identity on reconnect.
- `remi pair` prints the pairing QR in the terminal (and the same payload as a pasteable string); `remi devices` as above.
- The relay is on by default only after the gates in section 6 pass. Until then it stays off (#1193).

### 3.5 Push privacy and lock-screen answers

- At pairing and token registration the phone gives the daemon a per-device push public key; the daemon seals each push body (kind, text, options, question id) to it (ECIES in the shape of the existing sealed-answer code, direction reversed) and sends the Worker only: token, room id, an opaque question id, `mutable-content: 1` and a generic fallback title ("Claude needs you" or the harness name) because an alert requires one. The Notification Service Extension decrypts, rewrites the alert and builds the per-notification category from the decrypted options. If the extension does not run or fails, the fallback text shows and a tap opens the app; no lock-screen one-tap Yes without a decrypted body.
- Needs the iOS side: an App Group or keychain-sharing entitlement for the app and the extension, provisioning changes, a new TestFlight build, and the key in the shared keychain (OWNER prerequisite).
- Old app builds keep receiving legacy plaintext pushes until they update (they registered no push key); a dated removal of the legacy path is a decision at the end of the epic.
- Lock-screen and Watch answers go through the relay: the native answer handler opens a short-lived channel with the device key from the shared keychain, sends a signed answer bound to question id, a fresh nonce and a timestamp, and the daemon accepts each question once (replay protection). The direct `/answer` route stays for LAN use. A passphrase-protected identity cannot sign without the app: that case falls back to opening the app (stated).
- Payload limits: 4 KB per APNS payload; option labels are truncated before sealing.

### 3.6 Deletions

The unauthenticated default mode, the plaintext handshake, the Worker's `/answer/<code>`, offer/answer/ice-candidate forwarding, three copies of the code generator, the `RelayAdapter.code` getter and `sendStatus` stub, the dead web signaling helpers (`relayAnswerViaSignaling`, `ConnectModal` code tab, `ManagedConnection.mode === 'relay'` stubs), and every comment or doc that says WebRTC, P2P or "end-to-end encrypted" about code that is not.

## 4. Phases (each one reviewable PR of up to about 500 net lines; epic branch `feature/issue-N-epic-relay`)

- **R0 (hotfix, in flight, #1193):** relay off by default; fail closed without an authenticator; docs made true. Not part of the epic branch; merges to develop first.
- **R1 Spec and shared crypto (Apache):** ADR 0034 (this design with the owner's decisions), the envelope, the hardened handshake, counters and AAD, the pairing token format, the push-sealing format; committed test vectors; unit tests of every primitive and failure mode (replay, reorder, drop, truncation, wrong key, downgrade, reflected frame). An independent cryptography review (a fresh reviewer on the strongest available model, plus the owner's own read) is a merge gate for this phase.
- **R2 Worker v2 and the E2E test harness (PolyForm):** per-machine object, host and device admission, no TTL, edge ping, rate limits, `/push` auth; the harness that runs the REAL Durable Object (a spike first: whether `bun test` can drive workerd or miniflare; fallback is a CI job that starts `wrangler dev --local` and runs the suite against it); a first end-to-end test with a fake host and fake client and a Worker-sees-only-ciphertext assertion.
- **R3 Daemon:** hub-owned adapter v2 on the new frames, the hub-to-session loopback proxy (after #872 and #873), no raw PTY, reconnect, `remi pair`, `remi devices`, authorized-keys enrollment with the pairing secret; the old adapter deleted; real-daemon tests with the relay on.
- **R4 Client (web, PolyForm):** device identity in the native keychain, the pairing UI (QR scan and manual paste), the relay channel from the shared package, `mode: 'relay'` in the connection manager, the session list and chat over the relay, device list and revoke UI.
- **R5 Push privacy:** device push key, sealed push bodies, the extension decrypting them, entitlements, Worker `/push` v2, fallback behavior, dismiss pushes, the legacy path kept with a flag.
- **R6 Lock-screen and Watch answers over the relay:** native signed answers over a short-lived channel, daemon single-accept, replay tests.
- **R7 Gate and cleanup:** the full end-to-end suite (real Durable Object, real hub, real client, a session older than one hour, replay and displacement attempts, ciphertext-only assertion), soak, the deploy runbook, deletions of section 3.6, docs.

Live steps (owner): R2 and R7 against a deployed Worker (the owner deploys; the daemon and the agents never hold Cloudflare credentials), R4 to R6 on a real iPhone and Watch from a TestFlight build (the owner builds and installs).

## 5. Reuse (do not rebuild)

`packages/shared/src/relay-crypto.ts` (primitives and HKDF), `sealed-answer.ts` (ECIES shape), `authenticator.ts` and the authorized-keys store (`remi authorize`), `identity` code in shared and web, the hub's `daemonPorts` discovery and `capabilityWsOptions`, `NotificationDispatcher` and the push preference filter, `RemiAnswerRelay.swift`, the Notification Service Extension target, `scripts/` deploy knowledge for the Worker, ADR 0014's two-sided conformance pattern for the wire.

## 6. Decision gates (set before looking at results)

1. R1 merges only with the vectors green on three implementations (shared TypeScript, the web client and a Swift test for the shapes the extension needs) and no open Critical or Important finding from the independent cryptography review.
2. The relay becomes default-on only when the end-to-end suite passes in CI against the real Durable Object, a session lives over one hour without a reap, a replayed frame, a displaced host and a stranger's join are all refused by test, the Worker-sees-only-ciphertext assertion holds, a pairing from a real iPhone works, and a push is decrypted by the extension on a real device. If any one fails the relay stays opt-in and the epic reports why; no gate is adjusted after seeing a result without saying so.
3. Strategy kill criterion kept: if the relay is not always-on E2E after two focused weeks, ship SSH and Tailscale with the single-port hub, keep the relay off by default, and revisit.
4. Push privacy ships separately from the channel if the entitlement or TestFlight work slips; the channel does not wait for it, and the legacy plaintext push path stays until it ships.

## 7. Risks and unverified

1. Whether `bun test` (or CI) can run workerd or miniflare for the real Durable Object (R2 spike).
2. WebCrypto and CryptoKit coverage of every primitive on the target OS versions (P-256 ECDH, Ed25519, HKDF, AES-GCM are the working assumption; X25519 and ChaCha20-Poly1305 are not assumed).
3. Whether a keychain-sharing group or an App Group is the better way to share a key with the extension (an Apple-side decision with provisioning consequences).
4. Cloudflare Durable Object billing for idle hibernating sockets and app-level pings (unmeasured; measure in R2/R7, do not assume).
5. The deployed Worker's configuration (`PUSH_SECRET` set or not) is unknown from the repo.
6. The idle-reap time of today's Worker (60 s claim) is unverified and irrelevant after R2.
7. Multi-device: the Worker holds one client slot today; the design admits several enrolled devices at once, which multiplies handshakes and fan-out of notices.
8. The macOS app is sandboxed and cannot read `~/.remi`: its relay use goes through the same pairing as the phone.
9. The `#869` prerequisites (#872, #873) block R3; if they slip, R3 cannot ship.

## 8. Owner decisions (recorded 2026-10-04)

A. Worker admission: the Worker enforces the host signature and admits only enrolled device keys (and a single-use pairing window). DECIDED.
B. Handshake: harden the existing P-256 / Ed25519 / HKDF / AES-GCM design as in 3.3 and 3.3.1; Noise is not adopted. DECIDED.
C. Hosting and interop: remi's own protocol on a remi-operated Worker, Worker source published under PolyForm Shield; Paseo's topology is borrowed, its wire contract is not. DECIDED.
D. Scope: one epic, R1 to R7, channel first; push privacy inside the epic and not blocking the channel; the legacy plaintext push stays until push privacy ships. DECIDED.

## 9. Agent budget

R0: 1 implementer, 1 reviewer. Per epic phase: 1 implementer, 2 reviewers (R1 adds the independent cryptography review), plus a spike agent for R2's harness spike; live steps by the owner or a spike agent only with the owner's go-ahead. About 24 agents for the epic.

## 10. Verification

Per phase: pin or characterization test first; every new test mutation-checked; a real client against a real daemon and a real Durable Object wherever a wire claim is made; fresh-clone gates on Bun 1.4.2 and the CI-pinned Bun; ADR 0011 on every doc sentence. Epic gate: section 6.
