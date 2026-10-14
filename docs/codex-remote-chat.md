# Codex structured remote chat (#1207)

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

The later production caller must own authenticated device/session authority,
request-ID replay/conflict handling and uncertain-result retention.
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
Hosted review/checks and native UI remain separate gates; #1207 remains open.

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
