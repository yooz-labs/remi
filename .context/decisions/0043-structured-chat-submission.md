# ADR 0043: Structured chat submissions

Status: proposed, not registered, advertised or frozen.
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
The proposed capability name is structured_chat; no capability is currently advertised.

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
The future handler still owns actual device grant, concrete attachment, binding and runtime checks before invoking this component and before sending any result, including a cached result.
Shape validity, receipt replay and a sequence counter grant no authority by themselves.

## Evidence and remaining gates

The standalone corpus has17 positive and213 negative vectors.
Both Buns pass237 codec/sequence controls with371 assertions.
Those sequence unit controls wrap the genuine unavailable CodexTextWriter/AppServerClient and make no model-admission claim.
A separate installed accountless Codex0.162.1 probe passes on both Buns using actual RPC acceptance: concurrent duplicate admission makes one turn RPC, conflict makes none, and eviction after35 submissions never re-executes the old accepted input.
Post-admission close and controlled delivery exceptions remain uncertain without another RPC.
Its private account is null, its owned process is reaped, and its private profile is removed.
This is local admission evidence, not model completion, a Remi authenticated route or permission enforcement.

Before advertisement or closure of1207: independent contract/component review, strict runtime routing and total conformance, actual harness caller, authenticated direct and separately relay paths, rendered App UI, fresh hub first-turn binding and separately approved model acceptance.
Native contract conformance/UI remain with the Xcode developer.
The exported installed Thread schema omitted environments, but the later actual native TUI frame included one environment and the existing production parser/tracker bound that exact thread.
No discovery guard was relaxed from the schema-only concern.
That probe had an observer connected before the TUI, so it does not replace genuine hub-created startup acceptance.
