# Codex structured remote chat (#1207)

## Availability on develop

The direct and encrypted relay text paths landed in [#1507](https://github.com/yooz-labs/remi/pull/1507)
at merge `49094b025b18e4156bd834c7a4b607504cbb1a91` (develop build 169).
The [actual CI run](https://github.com/yooz-labs/remi/actions/runs/38529063958)
passed 9,808 tests with 30 skips and zero failures, and 91.79% line coverage;
the [relay run](https://github.com/yooz-labs/remi/actions/runs/38529063934)
passed 280 short controls with four existing skips and the actual 61-minute soak.
The earlier direct-head timeouts remain separate unresolved observations.
This source landing makes the contracts available for native integration;
native app conformance, rendered UI and device acceptance are not established.

## Decision and current scope

The owner chose structured `turn/start` and `turn/steer` on 2026-10-13,
with the current full-access default retained.
An explicit read-only session remains read-only.
The host's existing launch policy and remote argument allowlist still apply.
See [ADR 0033](../.context/decisions/0033-codex-adapter-app-server.md#structured-remote-chat-decision-1207-2026-10-13).

The connected direct implementation reuses the reviewed `CodexTextWriter`, strict submit/result codec and bounded sequence receipts.
The actual Codex session exposes its neutral structured-input member to the signed direct service.
An attached signed direct client or admitted relay child sees `structured_chat` only where that handler/writer exists; first-thread binding is still required for admission.
Codex's existing `acceptsTypedChat: false` is unchanged.
Nothing in this module types text or Enter into a PTY.

## Internal submission

A request names the exact bound main thread and a client message UUID.
Text is nonblank, valid UTF-8, NUL-free and at most 16 KiB.
A caller supplies a synchronous current-authority check and an opaque runtime epoch,
replaced on runtime, app-server connection or main-thread identity changes.

The writer checks live metadata and local blocking questions.
An idle first turn does not need materialized history.
After a native `systemError`, a new explicit message can start another turn; failed input is never automatically retried.
An active turn uses a bounded latest-turn read and atomic `expectedTurnId` on steer.
The writer checks authority again immediately before its single possible turn RPC.
Every turn request omits sandbox, approval-policy, working-directory and model overrides.

Results mean:

- `accepted`: Codex returned a valid correlated turn ID on the current runtime.
  The named method is not proof of a newly created turn; a start can append to a turn that became active meanwhile.
  Acceptance is not model completion.
- `refused`: no turn RPC was attempted by this writer.
- `uncertain`: a turn RPC may have taken effect, but its outcome cannot be established.
  The writer never automatically retries, falls back from steer to start, or writes PTY input.

The connected production service described below owns authenticated device/session
authority, bounded sequence replay/conflict handling and uncertain-result retention.
`clientUserMessageId` provides correlation; this implementation does not claim server deduplication.
The ordinary Remi input ACK is receipt before its handler and cannot serve as a submission result.

## Accountless installed-server control

Ordinary tests construct the real client in an unstarted state and check local refusal.
The installed-server control is opt-in and requires the actual native Codex binary.
For example, with a short canonical temporary path:

```sh
TMPDIR=/Volumes/S1/yooz/remi/tmp \
REMI_CODEX_ACCOUNTLESS_CLI=/absolute/path/to/native/codex \
bun test packages/daemon/tests/harness/codex/codex-text-writer.test.ts
```

The control starts an owned app-server with a new private HOME and CODEX_HOME,
file-only credential storage and an explicit environment whitelist.
It asserts `account: null` before any turn request and stops on any non-null account.
It checks actual default/read-only thread settings,
then exact start/steer parameters, binding/authority changes and a withheld real response.
Its transport tap forwards every request to the installed server and fabricates no response.
It reaps its owned process and removes its private profile afterward.
An optional `REMI_CODEX_ACCOUNTLESS_RECEIPT` path records binary hash,
account absence, measured checks and process cleanup without message bodies.

These checks establish local RPC admission and omission of policy overrides.
They do not establish model completion, model-side steering or sandbox enforcement.
An account-backed model check needs separate bounded owner approval.
Native device UI remains separate; the connected direct and relay paths are described below.


## Bounded installed-model observation (2026-10-13)

The owner approved three short starts and two steer messages using only a generated private project.
The actual Codex0.162.1 server used a private file-only copy of the approved account, gpt-6.1-sol at low reasoning effort, and the production internal writer.
A durable counter bounded transmissions across attempts.
The default thread retained dangerFullAccess/on-request/auto_review and completed its requested private marker write with the expected bytes.
Both steer messages were accepted on the same active turn, and its completed final response was REMI_STEER_C, reflecting the second message.

The read-only fixture selected readOnly/on-request/user at creation, preserving that narrower posture through the writer.
It returned REMI_READONLY_BLOCKED and created no marker.
No command or permission request was emitted, so the stricter command-attempt control did not pass; this is model refusal and file-absence evidence, not a measured OS write denial.
The original receipt retains completed-with-case-failure for that control.
No additional model turn was run; the three-start/two-steer budget is exhausted.

A separate prompt-free native TUI startup in the same private server emitted an actual user thread with one environment.
The existing production parser and ThreadTracker bound that exact thread without a guard change.
The exported schema alone had omitted that field; it was not sufficient evidence of an actual TUI regression.
The observer was connected first, so genuine hub-created first-turn startup remains a connected-path gate.

The owned server and TUI were reaped, the private profile removed, and the owner's credential file remained byte-identical.
These model observations do not establish a Remi route, relay/native UI or broader sandbox qualification; the direct route has separate accountless evidence below.
Local receipts and the bounded plan are retained under the S1 Codex remote-chat artifacts.

## Signed direct delivery and web caller

`chat_submit_request` names the exact Remi session, Codex binding, UUID, monotonic connection/session sequence and text.
The strict codec owns original text and binary frames before legacy parsing or generic ACK/deduplication.
The host checks the original signed device grant, actual attached connection/session, PTY, binding and live writer context.
The final grant lock covers the synchronous app-server send; metadata reads happen outside it.
Tracked pending main requests block structured chat, including answered requests until Codex resolves them.
Legacy typed chat stays refused; no PTY or policy-override fallback is enabled.

The host retains32 recent receipts per pair, at most64 pairs per connection and128 concrete connections.
It never evicts a pair's sequence watermark to make room.
Context changes clear receipts without resetting that watermark or making old input executable.
The caller sends once and receives accepted/refused/uncertain separately from transport delivery.
Unknown delivery is retained and requires checking the session and reconnecting before another explicit intent; no automatic resend or blind Retry is offered.
Live transcript replacement preserves the submission status; matching text alone does not turn uncertainty into acceptance.

Installed0.162.1 no longer has `thread/items/list`.
On first-page method-not-found only, history uses `thread/turns/list` with full items, one turn per page, preserving the raw-item/page/time bounds.
Its exact not-materialized first-thread response is empty history, not a chat startup failure.
Both empty and materialized text history are measured against that installed server, alongside legacy-source controls.

The optional accountless connected control is:

```sh
TMPDIR=/Volumes/S1/yooz/remi/tmp \
REMI_CODEX_ACCOUNTLESS_CLI=/absolute/path/to/native/codex \
bun test packages/web/tests/integration/structured-chat-direct.test.ts
```

It constructs the real signed WebSocketAdapter, identity/session stores, CodexHarness, installed server and shipping WebSocketClient/controller.
It measures original-grant commit locking, duplicate input, detach/revoke/restoration, strict bad frames and closed service.
Its PTY is inert cat and account is null, so it proves routing/admission, not model completion, OS sandbox enforcement or fresh native startup.
The actual App is also checked against an owned compiled hub/child at phone, tablet and desktop widths, including paused-daemon uncertainty with no replay.
Prompt-free warm and cold native startup controls also bound genuine hub-created first threads, without an observer connected before the child. These used zero model turns and do not establish another model completion.
The reviewed combined implementation landed through #1507 with actual full-suite, coverage and relay acceptance. Native conformance/UI and device acceptance remain separate; #1207 stays open.

## Encrypted relay child delivery

The relay reuses the direct service and the child's existing sequence owner.
The hub forwards its original device/grant/enrollment snapshot through a bounded canonical internal header on a capability-proved loopback child upgrade.
The child rechecks that snapshot under the original grant lock at the synchronous RPC send and receipt delivery, alongside its actual connection, attachment, session, binding and writer context.
Ordinary capability connections acquire no chat authority, direct identity getters remain null on proxies, and image permissions are unchanged.

Once a chat request may reach a child socket, losing or replacing that owner retires the whole machine channel.
This prevents a replacement child from resetting an old request's consumed sequence; other streams reconnect as well.
Distributed close cannot undo bytes already forwarded, so missing outcomes remain uncertain.

The web caller tracks the exact child's hello, capability, binding and attachment.
It sends once, with a counter per session and no automatic replay across verified relay generations.
After unknown delivery, **Reconnect** creates a fresh transport and reattaches the last selected child using metadata only.
The old uncertain row remains visible; sending again requires a new explicit message.

The optional installed-server relay control reuses the direct fixture:

```sh
TMPDIR=/Volumes/S1/yooz/remi/tmp \
REMI_CODEX_ACCOUNTLESS_CLI=/absolute/path/to/native/codex \
REMI_CODEX_RELAY_CONTROL=1 \
bun test packages/web/tests/integration/structured-chat-direct.test.ts
```

It runs the actual Worker, hub, capability child, Codex harness and native server, checks account absence and original-grant RPC locking, and retains duplicate/conflict, revoke/restore, enrollment and child-owner loss controls.
The rendered App check additionally pauses its owned hub courier: delivery becomes unknown after 15 seconds, reconnect sends no old input, and a new explicit message is accepted after a real native failure state.
These are admission/UI controls, not model completion, deployment acceptance or native app conformance.


## Native integration handoff

Consume the existing [strict codec](../packages/shared/src/structured-chat.ts),
[17 positive/213 negative vectors](../packages/shared/tests/fixtures/structured-chat/vectors.json)
and [ADR 0043](../.context/decisions/0043-structured-chat-submission.md).
Web reference callers are `packages/web/src/lib/structured-chat.ts`,
`relay-transport.ts` and `hooks/useConnectionManager.ts`.
The native developer owns RemiKit/SwiftUI integration; this handoff changes no native files.

### Client behavior

1. Require structured_chat on the actual attached Codex child and a non-null exact harnessSessionId. The sessionless hub has no writer. Retain existing protocol/capability checks; version strings are not feature tests.
2. Send chat_submit_request with fresh version4 envelope id, timestamp, sessionId, seq, binding{harness:codex,harnessSessionId},content. At most 16 KiB of nonblank scalar UTF-8 text, no NUL, frame at most 128 KiB. Preserve original text bytes without Unicode normalization. Never add model/cwd/sandbox/policy/raw fields. No legacy user_input or typed Enter fallback.
3. Sequence starts at 1 for each concrete connection/session pair and advances when an explicit request is handed to the transport, even if sending throws or reports failure. Preserve the watermark through rebind, session switching and detach/reattach. Use independent per-session counters on a machine relay; retain at most 64 pairs without evicting consumed marks. A fresh verified transport generation resets its counters, with no old input replay.
4. Match result requestId+sessionId+seq and the captured current binding/generation. A generic transport ACK is not submission acceptance; results need a dedicated strict path outside automatic input retry.
5. Show pending, accepted, refused and uncertain separately. accepted includes turn/start or turn/steer plus turnId; it is not model completion or proof that start created a new turn. Refused means the writer attempted no turn RPC. Unknown delivery, receipt_expired and conflict uncertainty do not authorize retry.
6. Keep the uncertain row through transcript replacement. The reference web controller waits 15 seconds, then blocks that generation until explicit reconnect. Never auto resend, including after an apparently healthy socket reconnect. Reattach selection with hello metadata only, then permit a new explicit message with a new id.
7. Serialize reconnect through the old authenticated close and replacement handshake. Two rapid actions must produce one replacement, not an orphan channel. Cancel stale continuations by generation. This exact race was found/fixed in web R1/R2.
8. Relay child-owner loss can close the entire machine channel to preserve its sole sequence owner. Treat outstanding deliveries as uncertain. No public internal-proxy descriptor is sent by native clients.
9. Preserve the owner-selected existing full-access default and explicit narrower thread settings. The host writer sends no per-turn policy overrides. A new explicit message can start after native systemError; never automatically replay the failed turn.
10. Reuse existing app foreground/background lifecycle. This contract needs no extra background polling, permanent socket wake-up or push transmission of chat text. Codex image input is outside this text-only contract; keep its image insertion UI unavailable.

### Native acceptance still required

Run the strict corpus, first bound turn, start/steer, held-prompt refusal, direct
and relay routes, uncertainty/no replay/transcript retention, two rapid reconnect
actions, child switching without counter mixing, revoke/regrant, detach/rebind and
child-owner loss. Check rendered Mac/iPhone UI and lifecycle power separately.

Installed accountless server admission and rendered web at 390/1024/1440-pixel widths are
existing evidence, not native app/device acceptance. The bounded model check
verified the full-access marker and steering; read-only made no command attempt,
so it does not establish OS write denial. Its approved three-start/two-steer
budget is exhausted; further model calls need new approval. No additional
background polling or push transmission of chat text is required by this contract.
