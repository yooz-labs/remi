# ADR 0043: Structured chat submissions

Status: proposed contract; connected direct and relay implementations under validation.
Date: 2026-10-13 Pacific.
Issue: #1207.

## Context

The owner chose structured Codex chat with the existing full-access default retained (ADR 0033).
The existing input ACK precedes its handler, so it cannot establish submission.
The internal writer returns accepted/refused/uncertain without a PTY fallback or per-turn policy overrides.
A generic chat write also needs bounded duplicate handling: evicting an old request ID must not authorize running old input again.

## Proposed contract

A request names the exact Remi session and Codex thread, carries a fresh UUID and a positive sequence, and contains at most 16 KiB of nonblank scalar UTF-8 text with no NUL.
The sequence starts at one for each concrete connection/Remi-session pair.
It continues across binding changes, session switching and detach/reattach within that pair.
A fresh transport generation has a new counter and never automatically replays an old intent.
This per-session scope permits the same contract through a hub's separate logical child connections.

`chat_submit_request` has exactly type, id, timestamp, sessionId, seq, binding and content.
Binding has exactly `harness: codex` and the thread's harnessSessionId.
`chat_submit_result` has type, id, timestamp, sessionId, seq, requestId and one outcome:

- accepted: method (turn/start or turn/steer) and turnId;
- refused: a refusal code, meaning no model write was attempted for this variant;
- uncertain: delivery_unknown, receipt_expired or conflict, with no retry authority.

All UUIDs are lowercase; envelope/request IDs are version4.
Timestamps are canonical millisecond UTC strings, used for display/correlation rather than admission by device clock.
Sequence is an integer from1 through4294967295.
The raw frame limit is128 KiB so every valid16-KiB text, including six-byte JSON escapes, fits.
Unknown/duplicate members, invalid Unicode/UTF-8, wrong field types and extra policy/cwd/model/raw fields are refused by the standalone codec.
The capability name is structured_chat. It is conditionally advertised on an attached signed direct connection or an admitted relay child proxy with the actual Codex harness writer. A sessionless hub, ordinary capability-only connection and Claude connection do not qualify.
Availability describes the connected handler; a first thread may bind after hello, and submission still requires its exact current identity.

## Bounded sequencing

One internal SubmissionSequence belongs to each concrete connection/Remi-session pair.
It stores a high-water mark, at most32 recent SHA-256 digest/result receipts and one pinned pending receipt within that bound.
It captures immutable request fields before any await and hashes a fixed field order.
No completed receipt needs to retain message text.

A matching recent sequence/digest shares the original pending operation or immutable result.
Changed fields or a reused recent UUID conflict; a possible original effect stays uncertain.
A skipped future sequence is refused.
A new next sequence is consumed even when refused busy, so it cannot later acquire write authority.
An evicted older sequence returns uncertain/receipt_expired and never reaches the effect again.
Request UUIDs correlate intent and must be fresh for new sequences; the high-water guarantee is scoped to sequence, not unbounded UUID history across connections.

Closing before the scheduled effect prevents that call.
Closing or an exception after the possible effect returns uncertainty and never retries.
The connected handler owns actual device grant, concrete attachment, binding and runtime checks before invoking this component and before sending any result, including a cached result.
Shape validity, receipt replay and a sequence counter grant no authority by themselves.

The direct service retains at most128 concrete connections and64 session pairs per connection, refusing new pairs at capacity rather than evicting their consumed sequence marks.
A grant/attachment/binding/runtime change invalidates cached receipts without resetting the sequence watermark or pending serialization.
The original authorization epoch lock covers the actual synchronous RPC send and current-owner result delivery.
The web controller sends once, retains uncertainty, and requires reconnection after unknown delivery before another explicit intent; it never resends across a socket generation.

## Evidence and remaining gates

The standalone corpus has17 positive and213 negative vectors.
Both Buns pass237 codec/sequence controls with371 assertions.
Those sequence unit controls wrap the genuine unavailable CodexTextWriter/AppServerClient and make no model-admission claim.
A separate installed accountless Codex0.162.1 probe passes on both Buns using actual RPC acceptance: concurrent duplicate admission makes one turn RPC, conflict makes none, and eviction after35 submissions never re-executes the old accepted input.
Post-admission close and controlled delivery exceptions remain uncertain without another RPC.
Its private account is null, its owned process is reaped, and its private profile is removed.
This is local admission evidence, not model completion, a Remi authenticated route or permission enforcement.

Completion of1207 requires independent contract/component review, strict runtime routing and total conformance, actual harness caller, authenticated direct and separately relay paths, rendered App UI, fresh hub first-turn binding and separately approved model acceptance.
Native contract conformance/UI remain with the Xcode developer.
The exported installed Thread schema omitted environments, but the later actual native TUI frame included one environment and the existing production parser/tracker bound that exact thread.
No discovery guard was relaxed from the schema-only concern.
That probe had an observer connected before the TUI, so it does not replace genuine hub-created startup acceptance.

## Connected direct evidence

The implementation uses CodexSession's actual writer, a strict ingress before legacy ID/ACK handling, and a dedicated web result callback before ordinary message delivery.
Installed accountless0.162.1 controls run the real signed direct WebSocketAdapter, IdentityStore, SessionRegistry, CodexHarness and native server.
They observe the real grant lock at each RPC send, one effect for duplicate input, no queued effect after detach/revoke, old-sequence retirement after restoration, and the shipping WebSocketClient/controller.
Their PTY is inert cat; they are admission and routing controls, not model completion or fresh native TUI startup.

The actual rendered App check found transcript replacement erasing submission status; replacement now retains that separately correlated status and refused input is not merged by matching content alone.
Pending/accepted/refused/uncertain stay distinct from transport ACK and model completion; uncertainty has no blind Retry action.
Native app UI remains with the Xcode developer and is not changed here.

Installed0.162.1 also returned method-not-found for thread/items/list.
History selects thread/turns/list with full items only on first-page method absence, never after a cursor or another error, preserving bounded raw-item/page/deadline limits.
Its exact first-thread not-materialized response means empty history; malformed or other failures remain errors.
The earlier112 legacy history/session controls pass, and the actual installed first-thread and materialized-user-history controls pass.
Prompt-free warm and cold native0.162.1 startup checks also bound genuine hub-created first threads without an observer connected before the child.
The cold case began without a private control link or prestarted server; the TUI bootstrapped its own managed daemon, whose executable hash matched the standalone CLI.
These checks used a private file-only copy of the previously approved account, sent zero prompt/input/model-turn requests and preserved the exhausted three-start/two-steer budget and owner authentication bytes.
Initial ownership-matcher and cleanup-grace failures are retained; every owned child/hub/native/update-loop process subsequently exited and the private profile was removed.
This is startup/binding evidence, not another model-completion or OS sandbox-enforcement result.

Relay frame controls reuse the existing strict protocol codec and encoder; the hub already preserves the original BOM and rejects reversed directions.
The web relay receiver now preserves that BOM too and rejects a host-to-client chat request before application delivery.
Actual Worker/HubRelay/RelayMachineChannel controls reproduce those two original failures; both corrections pass on both Buns and removing either correction fails its original control.
No relay writer authority or capability is enabled by these frame checks.

## Relay child authority and recovery

The hub passes its original immutable device key, fingerprint, grant epoch and enrollment epoch in a canonical internal descriptor only on a current-capability-authenticated TCP loopback child upgrade.
The child stores it separately from direct identity; direct public-key/fingerprint getters remain null and image authority is unchanged.
Shape alone grants nothing: the existing child service checks the original grant and enrollment under the grant lock, plus the concrete connection, attachment, session, PTY, exact binding and writer epoch at the actual RPC send and result delivery.
Restoring a grant or enrollment cannot refresh an old descriptor.

The existing child SubmissionSequence is the sole sequence owner.
Before forwarding the first structured request, the proxy marks that concrete child socket as its chat owner, including a request the writer may refuse.
Losing or replacing that socket, registry generation or receipt path retires the whole authenticated machine channel before another child can reset its consumed watermark.
Other child streams on that machine reconnect too; possible delivery remains uncertain.
A remote close cannot retract bytes already forwarded or a turn already admitted.

The web controller keeps bounded counters per session and one pending input per machine.
Child hello metadata supplies capability, binding and attachment; a fresh verified relay channel supplies the new transport generation.
Unknown delivery blocks further input on its generation and exposes an explicit Reconnect action, including when the socket otherwise remains healthy.
Reconnect reattaches the last selected child with hello metadata only, never old chat input.
A new explicit intent then starts its fresh sequence at one; the uncertain prior row remains visible.

An actual native systemError is an inactive failed turn, not a permanent loss of chat support.
The writer permits a new explicit start from that state while retaining all authority and policy checks; it never retries the failed turn automatically.
The original installed-server control reproduced refusal while native turn/start accepted, and the corrected control passes on both Buns.

Actual Worker, hub, capability child, installed accountless Codex and shipping web transport controls cover exact override-free RPCs, cached/conflicting requests, binding/attachment changes, revocation/enrollment restoration and child-owner loss.
Rendered App checks cover phone/tablet/desktop submission and a measured 15-second paused-hub timeout, retained uncertainty, explicit reconnect and new input after real native systemError.
These establish routing/admission and UI behavior with account=null and an inert PTY, not provider completion or OS sandbox enforcement.
Final hosted checks, independent relay review and native conformance/UI remain separate gates; #1207 remains open.
