# ADR 0020: A client-visible status cue must be total over its gate's end paths

**Status:** accepted
**Date:** 2026-08-01
**Owner:** Yahya

## Context

`#560` gave the terminal statusline an "evaluating" cue driven by a start/end
count on `AutoApproveGate`: `autoApproveStart` increments, `autoApproveEnd`
decrements, floored at 0. `status-writer.ts` states the invariant this
buys outright: "Because every gate end-path calls this exactly once, the
count returns to 0 and the 'evaluating' cue can never get stuck." It holds
because it is checked against the full set of gate end paths, not against
whichever ones existed when it was written.

`#576` added a second, independent cue for remote clients:
`broadcastAutoApproveStatus` sends a client-only `session_update` on
`onEvalStart`/`onHandled`. It is explicitly **not** wired into the
StatusWriter or the registry's own `sessionStatus` — by design, so it cannot
double-emit against the real hook-driven status path. That design choice has
a cost the terminal cue does not pay: the daemon holds **no record** that a
client is currently showing `'evaluating'`. The only things that can move a
client off it are another broadcast, or a later unrelated hook.

#970 (field report: "the evaluating indicator got stuck") found the gap by
enumerating the gate's end paths against what each one broadcasts:

| Gate end path | Terminal (StatusWriter) | Client broadcast |
|---|---|---|
| `onEvalStart` | `autoApproveStart` (+1) | `'evaluating'` |
| `onHandled` (silent approve) | `autoApproveEnd('approved')` | `'approved'` |
| `onEscalate` | `autoApproveEnd('escalated')` | none (relies on the question path's own `'waiting'`) |
| `onCancelled` | `autoApproveEnd('cancelled')` | **none** |
| `resolveHeld` (Part-B late `allow`/`deny`) | already ended at escalate | `'approved'`, via `markHandled` — **already covered**, see below |
| `releaseHeld` (hold timeout, `part-b-cancelled`) | already ended at escalate | hold-timeout: none needed (`'waiting'` still correct); `part-b-cancelled`: **none** until this ADR's follow-up fix |

`onCancelled` left the pill on `'evaluating'` with nothing scheduled to clear
it; it "self-healed" only incidentally, when a later `Stop`/`SessionEnd`
happened to emit `'idle'` or a `PreToolUse` emitted `'executing'` — neither
guaranteed, and by construction absent when the eval was cancelled at the end
of a turn or during a disconnect, which is exactly the state a live log
captured mid-relay-reconnect-storm.

## Decision

**A client-visible status cue driven by a gate's lifecycle must cover every
end path of that gate, the same way the terminal cue's count already does —
verified by enumerating the callback list, not by adding a fix for whichever
report came in.** PR #973 closed the `onCancelled` gap: it now calls
`broadcastCurrentStatus()`, which re-broadcasts the session's own
`currentStatus` from the registry rather than a hardcoded constant — the gate
does not know what the session became when nothing was approved, denied, or
escalated, so guessing a value would just trade one wrong status for another.

## Consequences

Easier: a client that reconnects or is watching live no longer has the pill
stuck on `'evaluating'` after a cancelled eval — the most commonly hit case
(disconnect mid-hold, hold-timeout under a flaky relay) — nor after a HELD
hold's Part-B `cancelled` late verdict, the same failure mode one layer down
(see below).

**Correction to this ADR's own first draft.** The paragraph originally here
claimed "`resolveHeld` does not call `markHandled` either... neither the
hold-timeout path nor `resolveHeld`'s own late-verdict path calls
`broadcastCurrentStatus` or any equivalent," and left #970 open on that
basis. That claim did not survive a grep: `resolveHeld` has called
`this.markHandled(hold.isSubagent)` unconditionally since #711 (commit
`d1b3c5e2`, 2026-07-06 — a month before this ADR was written), which routes
through `onHandled` -> `broadcastAutoApproveStatus('approved')` exactly like
a silent primary-eval decision. A Part-B late `allow`/`deny` verdict
(`reconcileLateVerdict` -> `resolveHeld`) was therefore **already total**
before this ADR's own follow-up work started. This is exactly the failure
[ADR 0011](./0011-verify-before-you-describe.md) exists to catch, caught by
this ADR itself: a security/correctness description believed without
checking the call site, which reads as "handled" and stops anyone from
looking again.

**What was actually still open, and is now closed:** `releaseHeld` (a
*different* method — no `markHandled`, ever) is what a HELD hold's
`cancelled` late verdict (`reconcileLateVerdict`'s `part-b-cancelled`
branch) calls. That path genuinely emitted nothing: the pill sat wherever
`onEscalate`'s `'waiting'` left it, stale the moment the session moved on to
something else during the slow eval. A new `onHeldCancelled` cue on
`AutoApproveGateDeps`, wired to the SAME `broadcastCurrentStatus()`
`onCancelled` uses, closes it. The other `releaseHeld` callers
(hold-timeout/undelivered fail-open, `cancelStale`'s Stop/SessionEnd
teardown, `cancelStaleForAgent`, and PreToolUse/PostToolUse
external-resolution) were each checked against this same question and
deliberately left without a broadcast — see the `#970 totality note` comments
at each call site in `auto-approve-gate.ts` for the specific reasoning
(either the pill is already correct, or the driving hook event already
carries its own status update in the same synchronous handler).

The specific wrong "cleanup" this ADR exists to head off: treating the
client pill as harmless decoration because it is explicitly *not* wired into
`sessionStatus` or the StatusWriter. That was true of the mechanism's
blast radius (a stuck pill cannot re-enter the decision/buffer path,
unlike the gate's own internal state), but it does not make a stuck cue
harmless to the user, who is being told to expect a decision that already
happened. A second wrong cleanup this update adds to the warning list:
trusting an ADR's own prior enumeration without re-running it against the
live code, which is precisely how the `resolveHeld` claim above survived
across a whole PR review undetected.

## Alternatives considered

- **A client-side timeout that clears `'evaluating'` after N seconds
  (a leak-safety cap, mirroring `status-bar.ts`'s 600s terminal cap).**
  Not rejected outright — #970's own suggested-fix list keeps it as a
  belt-and-suspenders step — but not sufficient alone: it turns a stuck cue
  into a slow, silently-wrong one instead of an honest, immediate one, and a
  30-45s hold-timeout window (this codebase's typical `holdMs`) means the cap
  would need to race the very thing it is meant to catch.
- **Fold the client broadcast into `sessionStatus`/StatusWriter after all.**
  Rejected by the original #576 design specifically to avoid double-emitting
  against the real hook-driven status path; re-litigating that coupling is a
  bigger change than closing the enumerated gap.

## Receipts

- `packages/daemon/src/cli/status-writer.ts:118-124` — the terminal
  invariant's own stated proof ("every gate end-path calls this exactly
  once")
- `packages/daemon/src/cli/session-phases/hook-bridge-setup.ts` —
  `broadcastAutoApproveStatus`, `broadcastCurrentStatus`, and the
  `onEvalStart`/`onHandled`/`onCancelled`/`onHeldCancelled` wiring (the
  function's own docstring carries the corrected, full enumeration table)
- `packages/daemon/src/auto-approve/auto-approve-gate.ts` — `resolveHeld`
  (calls `markHandled` unconditionally since #711's `d1b3c5e2`, contra this
  ADR's original claim — see the `#970 note` on its docstring), `releaseHeld`
  (never calls `markHandled`; each of its five call sites carries its own
  `#970 totality note` explaining whether it needs a cue), and the new
  `onHeldCancelled` dep + its wiring in `reconcileLateVerdict`'s cancelled
  branch
- `packages/daemon/tests/auto-approve/auto-approve-gate.test.ts` — describe
  block `#970 held-hook client status cue totality`: direct cue-level proof
  for Part-B allow/deny (`onHandled`), Part-B cancelled (`onHeldCancelled`),
  and hold-timeout (neither cue fires)
- `packages/daemon/tests/cli/session-phases/hook-bridge-setup.test.ts` —
  describe block `#970 held-hook (Model B / Part B) totality`: the same four
  scenarios exercised end-to-end through the real hook wiring
- #970 (issue, closed by the follow-up PR to #973), PR #973 (MERGED
  2026-08-01, `onCancelled` only — the primary-eval half), the follow-up PR
  (held-hook half: `onHeldCancelled` + the `resolveHeld` correction above)
- #576 (introduced the client pill), #711 (`isSubagent` skip; also the PR
  that quietly made `resolveHeld`'s coverage already-total), #573 (Part B
  early push+hold)
