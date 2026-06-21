# Epic: Notification-delivery robustness refactor (Model B hardening)

Status: design (root-cause complete 2026-06-21). Supersedes the delivery half of
`.context/epic-notifications-rethink.md`. Grounded in **live-log evidence** from the
user's running 0.6.13 daemons + a 53-agent map→diagnose→verify→synthesize sweep
(6 segment maps, 40 candidates, **35 verified failure modes**).

## The complaint

"Running MULTIPLE concurrent sessions (one `remi --auto-approve` daemon per
worktree, ports 18765-18769, all sharing one Ollama GPU). NUMEROUS notifications
are dropped, and WORK PAUSES."

## Live evidence (not theory) — `~/.remi/remi.log`, 2026-06-21

- **134 `BadDeviceToken` + 9 `InvalidProviderToken` + 5 `TooManyProviderTokenUpdates`** push failures.
  The current iPhone token `4E54C06A…` is rejected on every push; the old token
  `4FA21E7C…` still 200s. Token flipped + uniform rejection = **APNS environment
  mismatch**: the phone runs a **dev/Xcode build (sandbox token)** but the Worker
  pushes to **production APNS** (`APNS_SANDBOX` not `true`). Confirmed by user.
- Immediately after each failed push: `Held hook <id> timed out -> passthrough`,
  repeatedly (×7 for one session at once). The hook was held with **no delivered
  notification**, so it sat blocked until the **1800s** fail-open. That is the
  "work paused."
- Garbled PTY-fallback questions still emitted: `Doyouwanttoproceed?…`,
  `[5Gyouwanttoproceed?…` (ANSI not fully stripped) — issue #3 of the prior epic,
  still live.

## The master defect (why a dropped push = paused work)

**Model B holds the `PermissionRequest` hook the instant it escalates, independent
of whether any notification was delivered.** Push is fire-and-forget with a
swallowed `.catch` (`notification-dispatcher.ts:182`); APNS rejections are
discarded; nothing prunes the dead token, retries, falls back, or tells the
terminal. So *any* dead-channel cause produces the identical 30-minute stall.
Multiple daemons multiply every shared-state and contention crack.

## Root architectural issues (fix these, not the symptoms)

- **R1 — A hold can exist without confirmed delivery.** `createHold` arms a 30-min
  block off a question id, not a delivered notification (`auto-approve-gate.ts:271-303`).
  *Master defect.* Hold must be contingent on delivery and fail open in **seconds**,
  not 1800s, when delivery is unconfirmed.
- **R2 — Delivery is best-effort and silent.** Fire-and-forget swallowed `.catch`
  (`notification-dispatcher.ts:182`); no retry/backoff/429 handling; APNS bad-token
  feedback discarded (`apns.ts:134-139`). Delivery must return an actionable result;
  every drop must be LOUD.
- **R3 — The push budget is the wrong shape.** `pushRateLimiter = new RateLimiter(5, 60_000)`
  keyed by **CF-Connecting-IP** (`signaling/src/index.ts:62`), shared across every
  daemon behind one NAT + alert+dismiss + per-token fan-out. ~3 concurrent
  escalations × 2 tokens > 5/60s → HTTP 429 → silent drop. Key it to the
  authenticated `PUSH_SECRET`/identity, raised above tokens × concurrency.
- **R4 — Device tokens are per-process, not per-user.** Per-daemon in-memory Map
  (`cli.ts:984`, `trivial-events.ts:36-55`); never persisted, never shared. A
  worktree daemon the phone never connected to has **zero tokens** → push
  black-hole (`notification-dispatcher.ts:151` `size===0` short-circuit). Dead/
  rotated tokens never pruned. Token presence must be a user-level fact.
- **R5 — The single GPU is contended but uncoordinated.** N daemons thrash one
  Ollama with no semaphore (`auto-approve-service.ts:109`); the per-eval 30s
  wall-clock hard-kill (`service.ts:381-389`) then manufactures spurious escalate
  verdicts under contention. Coordinate GPU access; exclude queue/GPU-wait from
  the eval timeout.
- **R6 — Shared mutable state crosses sessions.** One `currentAbortController` +
  `cancelReason` across all evals (`service.ts:114`) → wrong-victim aborts; one
  clobberable `HookServer.permissionResolver` slot. Cancellation must be
  permission-scoped; the resolver per-session routed.
- **R7 — The load-bearing held question is gated by cosmetic dedup.** Held push can
  be swallowed by `QuestionDedup` (`message-api.ts:216-218`) or evicted from the
  capped registry (`session-registry.ts:448-464`) → registered hook with no
  answerable question → unanswerable until fail-open. Held escalations must bypass
  dedup and survive eviction.
- **R8 — The answer round-trip can target the wrong daemon and has no live remote
  path.** `storedUrls[0]` fallback (`push-answer-resolver.ts:102`) misroutes; the
  reverse-relay `relayAnswerViaSignaling` + Worker `/answer/{code}` is fully built
  and tested but **dead code (zero callers)**; native iOS relay fails silently.
  Answers must be idempotent, never bounce off the wrong daemon, and have a live
  connection-independent fallback.
- **R9 — Held holds leak on non-hook teardown.** `onSessionClosed`/`closeBinder`
  never call `cancelStale`/`releaseAllHolds` (`hook-bridge-setup.ts:1334-1339`,
  `cli.ts:894-905`); the comment asserting they do is false → ghost lock-screen
  cards, leaked timers/promises.

## Pieces that ALREADY EXIST but are not wired (reuse, don't reinvent)

- **Reverse-relay is fully built but has zero callers.** `relayAnswerViaSignaling`
  + `signalingAnswerUrl` (`push-answer-relay.ts:233-303`) and Worker `/answer/{code}`
  (`signaling/src/index.ts:124-148`, `connection-room.ts handleAnswerRelay`) are
  implemented + tested but never invoked from `App.tsx`/`RemiAnswerRelay.swift`.
- **`dismiss()` already delivers regardless of attached client**
  (`notification-dispatcher.ts:191,199-218`) — exactly the always-deliver semantics
  `maybePush` should adopt for held escalations instead of the `activeConnectionId`
  short-circuit at line 151.
- **`releaseAllHolds`** (`auto-approve-gate.ts:226-241`) does the full clean release
  (timer clear + card dismissal + registry removal) — just never called from
  teardown. The R9/leak fix is to call the existing method.
- **Part B `maybePushOnSlowEval` + `reconcileLateVerdict`** (`gate.ts:533-625`)
  already push-and-hold early then fold a late verdict into the same qid — the same
  reconcile pattern should wrap the `escalate_model` second opinion (`gate.ts:465-505`).
- **Idempotent answer primitives exist:** `pushedHeldIds`
  (`question-presence-tracker.ts:94,160-181`) + `resolveHeld`/`releaseHeld`
  returning false on repeat (`gate.ts:193-194,631-632`) → delivery retries and dual
  native+JS taps are already safe, de-risking the retry/relay phases.
- **Token-prune contract is documented, half-built:** `connection-events.ts:145-150`
  promises prune-on-APNS-bad (#308), but neither the `unregister_device_token`
  message nor the 410/400 prune exists (only same-connectionId prune at
  `trivial-events.ts:47-55`).
- **`apns-collapse-id = questionId`** (`apns.ts:70-88`) is globally unique, so
  cross-session cards correctly never collapse — no change needed.

## Proposed phases (robustness-first ordering)

1. **Hold contingent on confirmed delivery + fast escape (R1/R2).** `maybePush`/
   `pushHeldHook` return a delivery outcome (≥1 push 2xx OR foregrounded active
   client OR queued retry). `createHold` consumes it: no channel confirmed within a
   short `delivery_confirm_timeout` → fail open immediately to passthrough (native
   prompt). Add 429/5xx retry-with-backoff honoring `Retry-After`. Surface every
   unrecoverable drop loudly (log + terminal/status cue). Behind
   `hold_requires_delivery` flag (default on; old behavior = kill-switch).
   *Removes the paused-work consequence of F1-F9/F13/F23-F25/F29 in one move.*
2. **Reshape the push budget + dismiss isolation (Worker, R3).** Rekey
   `pushRateLimiter` from IP to authenticated `PUSH_SECRET`/token; raise above
   tokens×concurrency; give `dismiss` its own budget. Return structured APNS
   token-invalid status for Phase 6. Redeploy Worker.
3. **Held question bypasses cosmetic dedup, survives eviction, always-deliver
   (R7).** Route `pushHeldHook` to register+push independent of `QuestionDedup`;
   adopt `dismiss()`'s deliver-regardless semantics; on eviction notify the gate to
   fail-open; in `handleAnswer`'s stale gate fall back to `gate.resolveHeld` when a
   `pendingHold` exists.
4. **Wire the connection-independent answer relay + kill wrong-daemon routing
   (R8).** Add room code/signaling URL to the push payload; wire
   `relayAnswerViaSignaling` into `App.tsx`'s unreachable branch + native
   `RemiAnswerRelay.swift`; drop `storedUrls[0]` (fan to all, first-delivered-wins,
   or route via per-question reverse-relay); native relay schedules a failure
   notification on non-2xx.
5. **Tame GPU/eval contention + scope cancellation (R5/R6).** Per-eval timeout
   excludes queue/GPU-wait; cross-daemon GPU semaphore (`~/.remi` lock or Ollama
   queue-depth); per-eval `AbortController` keyed by question id; scope
   `service.cancel()` to that id; restrict `releaseAllHolds` to genuine
   Stop/SessionEnd, not single-hold user-answer.
6. **User-level device-token registry + token hygiene (R4).** Persist tokens to a
   shared `~/.remi` registry every daemon loads (per-pid `.tmp` write, #461); parse
   APNS 410/400 and prune; implement `unregister_device_token` (#308).
7. **Socket liveness so attachment never lies + teardown hold release (R9).**
   Server-side pong-timeout closes dead sockets / clears `activeConnectionId`;
   gate `maybePush` on real app-foreground presence not mere socket attachment;
   call existing `cancelStale`/`releaseAllHolds` from `onSessionClosed`; fix the
   false comment at `cli.ts:901-902`.
8. **Yes-always/pick correctness + dual-answer dedup (cleanup).** Carry the
   pick/always choice in the hold resolution instead of passthrough+PTY-digit;
   client-side per-questionId answer dedup; stop native relay double-firing to JS.

## Open decisions (need user) — recommendations

- **D1 — Should a hold ever exist without confirmed delivery?** → **B**:
  optimistic-arm then **fast fail-open** in ~5-8s (`delivery_confirm_timeout`) if no
  channel confirms. Preserves the held-answer UX in the common (<1s) case; caps the
  worst case at seconds, not 30 min.
- **D2 — Escape when delivery is unconfirmed and the phone is the only target
  (hold-always-no-phone mode)?** → **C** (two-tier): fail open fast when a terminal
  is present; when the user opted into hold-always-no-phone, retry on backoff and
  hold to a **short** secondary timeout (~180s), not 1800s.
- **D3 — Keep pure Model B or go HYBRID?** → **B (hybrid)**: hold only when delivery
  is confirmed AND a remote client is reachable; otherwise pre-Model-B behavior
  (best-effort push, native prompt, terminal answers). The architectural expression
  of R1. Do NOT drop Model B.
- **D4 — Push rate-limit key?** → **B**: per authenticated `PUSH_SECRET`/identity,
  raised above tokens×concurrency, small IP fallback for legacy.
- **D5 — Token sharing across local daemons?** → **A**: shared on-disk `~/.remi`
  registry (local-first, no backend). Worker-side registry later only if
  cross-network routing needs it.
- **D6 — Sequencing?** → **B**: bundle Phases 1+2+3 as the "stop the bleeding"
  release (fail fast AND deliver more), then Phases 4-8 as a second milestone.

## Immediate unblock (separate from the refactor)

Phone is a **dev/Xcode build → sandbox APNS token**, Worker pushes production →
`BadDeviceToken` on every push. Fastest unblock: set `APNS_SANDBOX=true` on the
signaling Worker and redeploy (`cd packages/signaling && npx cfman wrangler
--account yooz-labs deploy`). Caveat: this flips the *global* env, so any
production/TestFlight build would then fail — acceptable while the user's dev build
is the only target. The robust answer is Phase 2/6 (per-token env detection: try
production, fall back to sandbox on `BadDeviceToken`, remember per token).

## Testing (NO MOCKS, per project rule)

Real local push sink returning non-2xx (assert fast fail-open + retry/backoff);
real loopback HookServer for hold/resolve/fail-open timing; real Worker (miniflare)
for the rekeyed limiter + `/answer` relay; real-Ollama AA concurrency tests
(gated); the real-claude e2e harness for teardown/leak. CI gate stays green
(`bun test --coverage`, 60% min).
