# Epic: Rethink the auto-approve → notification → answer pipeline

Status: design (investigation complete 2026-06-18). Source findings: `.context/aa-investigation-findings.json` (9-agent read-only sweep).

## The 7 issues (user, 2026-06-18)

1. Hold the APNS push behind a timeout (~60s); only push if the timeout passes and auto-approve has not approved (slow-eval / let-user-decide).
2. Cancel the in-flight LLM eval when the user answers from any channel (also avoids eval "traps").
3. APNS body reads garbled ("Doyouwanttoproceed?"); title carries the real question — redesign.
4. Options are hardcoded Yes/No, Yes/Always/No — should be parsed dynamically and shown to both LLM and user.
5. The LLM must not decide design / long-form / plan-mode questions — route straight to the user.
6. Tapping the APNS action (lock screen / Watch) doesn't wake the app fast enough; the answer is dropped during reconnect.
7. Status (starting/thinking/waiting/approved) updates too slowly (P2).
   - BUG: "Transcript for session <id> not found" recurs.

## Root causes (the issues cluster around 5)

**RC1 — The push fires synchronously on escalate, with no lifecycle gate.** (Issues 1, 2.)
`AutoApproveGate.escalateToUser()` → `tracker.onAutoApproveEscalate()` → `notifications.maybePush()` fire in one tick. No hold timer; no path from the user-answer handler back into the gate to cancel. `cancelStale()` exists and works but is only called on Stop/SessionEnd hooks. `onAnswer` (input-events.ts) never calls it.

**RC2 — The question is reconstructed/guessed at three points instead of carried faithfully.** (Issues 3, 4, 5.)
Question text has 3 sources that race & overwrite: hook rich text (`Allow Bash: git push`), `Notification.message` (`Claude needs your permission to use Bash`), and raw PTY text (`Do you want to proceed?` → garbles to `Doyouwanttoproceed?` after ANSI-strip). Options fall back to hardcoded `['Yes','Yes, always','No']` whenever `permission_suggestions` is absent (always for Bash). There is no structural classifier for design/long-form/plan-mode questions — only soft LLM prompt instructions.

**RC3 — The answer is a PTY-typed digit, so it needs both a rendered prompt and a warm connection.** (Issues 4, 6, 2.)
On escalate the gate returns **passthrough**; Claude renders its native numbered prompt; the phone answer is the numeric **index** (`'1'`), injected via `session.pty.submitInput('1')`. This is why options are indices not labels (4), why a cold-start wake drops the answer when the WebSocket isn't ready within the 10s deadline (6), and why cancellation matters (2). **Switching push options from `.value` to `.label` breaks PTY injection unless answer routing is normalized** (synthesis agent's verified warning).

**RC4 — Status is hook-sourced but key states aren't broadcast / are collapsed at the client.** (Issue 7.)
WebSocket `session_update` is zero-latency, but: `'waiting'` collapses to `'idle'` on the pill (session-display.ts:38); no `session_update` on auto-approve `approved`/`evaluating`; no `'starting'` sent. The native statusline is prompt-gated; the wrapper bar is 1Hz.

**RC5 — Session→transcript binding isn't durable; the client retries dead sessions forever.** (BUG.)
The `b7f8d9af` error is historical (pre-June-4 self-heal bug + sessions.json 7-day purge). It recurs only because the iOS client caches the dead remi UUID in localStorage and re-requests it on every reconnect. Hypothesis "launched with bare claude" is WRONG — logs show `[Binding] claude=31c98a5a source=fresh for remi=b7f8d9af` and `custom-title: remi:18767`. Secondary: the 30s fallback timeout fires on nearly every session (Claude takes 30-90s to write its first transcript line); self-heal covers it but it's noisy.

## Answer-delivery architecture — DECISION: Model B (hold the hook)

Chosen 2026-06-18. Rationale (user): **hooks are the durable contract** (less prone to change than PTY scraping/injection); treat the contract as a **non-shrinking floor** — established response capabilities won't be removed, so building on them is safe. The "Claude hangs on a spinner" objection is accepted and mitigated, not avoided:
- The 10-min concern was an *AI* answering budget; a **human** answers here and may be busy, so the hold timeout for escalated questions should be **long / effectively indefinite** (configurable), not 600s.
- Add an **escape/release path** (a keystroke or injected signal) that pops a held hook back to `passthrough` (Claude renders its native prompt → local terminal can take over) or cancels — so the terminal is never permanently stuck.

**Contract — docs-verified 2026-06-18** (code.claude.com/docs/en/hooks; cross-checks our `hook-server.ts:64` + gate `:195`):
- Two permission hooks. **`PermissionRequest`** (fires when the dialog would appear): response `hookSpecificOutput.decision.behavior = "allow" | "deny"` + optional `decision.updatedInput`. **`PreToolUse`** (fires before): `hookSpecificOutput.permissionDecision = "allow" | "deny" | "ask" | "defer"` + optional `updatedInput`. We use `PermissionRequest`.
- **`updatedInput` exists** (new) — a hook can modify the tool's *input arguments* on allow. It does NOT let you answer a multi-choice prompt (that's a selection/result, not an input arg).
- **A multi-choice selection still cannot be expressed** by either hook response. Confirmed against live docs — the contract did not expand here. Only allow/deny/(ask).
- **Holding is legitimate up to the hook `timeout`**: default 600s for command/http hooks, per-hook overridable via the `timeout` field. On timeout the permission hook **fails open → Claude renders the normal prompt** (graceful auto-escape). "Long human-paced hold" = set a large `timeout`; confirm no hard upper cap at implementation (small spike).

So Model B splits by question shape:
- **Binary permission escalations (Bash/Edit/… — the common case): full Model B.** Hold the `PermissionRequest` hook (raise its `timeout`); resolve the pending promise with `allow`/`deny` when the human answers via the relay/WebSocket. Connection-independent, no PTY render, no race. Auto-fallback to native prompt on timeout; plus an explicit early release-to-passthrough escape.
- **Multi-choice picks (ExitPlanMode, AskUserQuestion): degrade (no hook answer path).** Return `passthrough` immediately so Claude renders the native numbered prompt; push; deliver the human's pick via the **connection-independent relay → PTY index injection** (rendering already happened, so no inject race; fixes Issue 6 for picks too). Always escalate to the human (Issue 5), never auto-decided.

## Proposed phases (epic sub-issues)

**P1 — Decision lifecycle: hold + cancel (Issues 1, 2). Complexity L. Foundational.**
- Hold timer for the push (config `auto_approve.push_hold_timeout`, default 60s). Co-locate in the gate or tracker (both own the eval start/end signals). Clear on approve/deny/cancel/Stop/SessionEnd. Double-push guard (gate flag, not just PushDedup).
- Wire `onAnswer` → cancel in-flight eval: expose `cancelStale` from `setupHookBridge`, register per-session (sessionId-keyed) so multi-session daemons cancel the right gate; also drain queued waiters (`evalQueue`).
- Files: auto-approve-gate.ts, auto-approve-service.ts, question-presence-tracker.ts, notification-dispatcher.ts, input-events.ts, hook-bridge-setup.ts, cli.ts, types.ts.

**P2 — Design / plan-mode / long-form → always escalate (Issue 5). Complexity S/M. Independent, land early.**
- Pre-LLM structural classifier in `auto-approve-service.evaluate()` (mirrors the existing `isMultiChoicePermission` skip): `ALWAYS_ESCALATE_TOOLS` (default `['AskUserQuestion']`, `ExitPlanMode` already escalates via multichoice) + a free-text heuristic (question field present, no binary suggestions). New config `always_escalate_tools`. Returns escalate at zero latency, before the queue and before escalate_model.
- Files: multichoice.ts (or new design-classifier.ts), auto-approve-service.ts, types.ts.

**P3 — Faithful notification: text + dynamic options (Issues 3, 4). Complexity L. Depends on RC3 decision.**
- Single authoritative question text: prefer hook rich text; stop emitting a competing Question from `handleNotification(permission_prompt)` when a PermissionRequest already exists; never use raw PTY text as the title/body. Redesign title/body (title = session/tool context, body = the actual command/path).
- Dynamic options: send `o.label` for **display**, keep `o.value` (index) for **delivery** (per Model A). Normalize the answer path so a label or index both resolve correctly.
- Files: notification-dispatcher.ts, hook-event-bridge.ts, question-presence-tracker.ts (merge policy), shared/protocol + permission-defaults, push-client.ts; AppDelegate.swift (REMI_MULTI labels — cosmetic); web/notifications.ts.

**P4 — Reliable answer round-trip + iOS background (Issue 6). Complexity L/XL. Native + signaling + daemon.**
- `content-available: 1` pre-wake (apns.ts + AppDelegate `didReceiveRemoteNotification` → force reconnect before the user taps).
- Connection-independent answer relay: direct HTTP from the iOS action handler to the daemon (LAN/Tailscale) and/or a signaling `/answer` relay; daemon gains a lightweight answer endpoint. Fall back to the WebSocket path.
- Raise the 10s answer deadline; fail-fast when identity needs a passphrase (would never connect).
- IN SCOPE (decision D3): **Notification Service Extension** (dynamic button labels for multi-choice) + **Live Activities** (always-fresh lock-screen status — "Claude is waiting for your decision", pairs naturally with a held Model-B hook). New Xcode targets, entitlements, App Store review.
- Files: signaling/index.ts + apns.ts, daemon answer endpoint, AppDelegate.swift, Info.plist/entitlements, web/notifications.ts + App.tsx (handlePushAnswer) + push-answer-resolver.ts.

**P5 — Status responsiveness (Issue 7, P2). Complexity S/M. Independent.**
- Un-collapse `'waiting'` on the pill; broadcast `session_update` on AA `approved`/`evaluating`; send `'starting'` at session create; lower status-bar interval to ~250ms.
- Files: web/session-display.ts + App.tsx, daemon message-api-setup.ts + hook-bridge-setup.ts, status-bar.ts, shared/protocol.ts.

**P6 — Transcript binding durability + client phantom eviction (BUG). Complexity M. Independent quick win.**
- Fix A (the actually-needed one): client evicts localStorage sessions the daemon no longer knows about and that are stale (>14d). Stops the recurring b7f8d9af NOT_FOUND.
- Durability: extend `STALE_AGE_MS` or a separate append-only transcript-index; extend the 30s fallback timeout to ~120s; last-resort port-marker scan on NOT_FOUND.
- Files: web/App.tsx, daemon session-store.ts, transcript-fallback.ts, transcript-events.ts, transcript-discovery.ts.

## Testing strategy (embedded per phase — NO MOCKS)

Real tests only (project rule): pure-function unit tests, real loopback HTTP servers, real Cloudflare Worker (miniflare/vitest) tests, the existing real-Ollama AA test pattern (gated on Ollama availability), and the real-claude e2e harness (`tests/e2e/transcript-binding/`). CI gate stays green: `bun test --coverage` (60% min); AA-LLM tests skippable per the `skip_llm_tests` note when a change doesn't touch that module.

- **P1 (always-escalate):** unit-test `isDesignQuestion` over real payloads (AskUserQuestion with/without choices, ExitPlanMode, Bash, Edit) → escalate vs not; integration: a real PermissionRequest through the gate asserts `escalate` **without an LLM call** (assert no eval-slot acquisition, zero duration).
- **P2 (hold + cancel + push timing):** integration against a **real HookServer on a loopback port** — POST a PermissionRequest, assert the HTTP response is **withheld** until an answer is delivered, then resolves `allow`/`deny`; assert the in-flight eval AbortController fires on answer; assert the slow-eval push fires at a short test `push_hold_timeout`; assert no double-push; assert auto-fallback to `passthrough` on hold-timeout; assert queued-waiter drain on cancel.
- **P3 (faithful text/options):** unit-test Question text + options (labels vs values) from real hook payloads; **regression test that the APNS body is never the garbled PTY run-together string**; assert title/body/category/options mapping; assert the Model-B answer round-trips (`allow`/`deny` for binary; index-inject for multi-choice).
- **P4 (relay + iOS):** real integration tests for the daemon `/answer` endpoint (POST resolves a held hook) and the signaling `/answer` worker route (miniflare); extend `push-answer-resolver` unit tests; iOS native (NSE / Live Activities / content-available) via Xcode simulator + scripted mobile-mcp run + a documented manual checklist (the native portion is not fully CI-automatable — be explicit about that boundary).
- **P5 (status):** unit-test `sessionPillState` for waiting/approved/evaluating/starting; integration: assert a `session_update` broadcast on AA `approved`/`evaluating`.
- **P6 (transcript):** unit-test client phantom-eviction (diff cached vs known, stale-age guard); integration with real `~/.claude/projects` fixtures for the durability index + longer fallback + port-marker scan; validate via the existing real-claude e2e harness.

## Sequencing — DECISION: notification core first (D4)

Order: **P2 → P1 → P3 → P4 → P5 → P6**.
- P2 first: tiny, and it's actively biting — AA auto-pressed "1" on an `AskUserQuestion` in the live session, hijacking the user's own answers. The always-escalate classifier removes that immediately and is conceptually part of the "don't let the LLM decide design questions" core.
- P1 (hold + cancel) then P3 (faithful text/options + Model-B binary answer) are the heart of the rethink.
- P4 (iOS: relay + pre-wake + NSE + Live Activities) is the largest and builds on P3's answer model.
- P5 (status) and P6 (transcript binding) are independent low-risk; land after the core. P6 is also biting (recurring NOT_FOUND) — its one-line client eviction (Fix A) can be pulled forward opportunistically if cheap.

## Decisions (resolved 2026-06-18)

- D1 (Issue 1 semantics): **Immediate push on escalate + slow-eval fallback** — push the instant AA escalates; separately, if an eval hasn't approved within ~60s (config `auto_approve.push_hold_timeout`), push so the user can step in.
- D2 (answer model): **Model B — hold the hook**, answer binary via the `allow`/`deny` hook response; long/indefinite human-paced hold timeout + escape/release path; multi-choice via expanded contract if available, else passthrough+relay+inject. (See architecture section; docs check pending.)
- D3 (Issue 6 ambition): **Full** — pre-wake + connection-independent relay + deadline/fail-fast **plus** Notification Service Extension (dynamic labels) + Live Activities (fresh lock-screen status).
- D4 (sequencing): **Notification core first** (order above).
