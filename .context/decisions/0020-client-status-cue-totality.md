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
| `releaseHeld` (hold timeout, `part-b-cancelled`) | already ended at escalate | **none**, and `resolveHeld` skips `markHandled` too |

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
(disconnect mid-hold, hold-timeout under a flaky relay).

**Harder, and the reason this ADR exists as a warning, not a closed
success story: the fix is partial, and #970 is still open.** `resolveHeld`
does not call `markHandled` either (verified by grep — `releaseHeld` is the
sole owner of the per-hold teardown, and neither the hold-timeout path nor
`resolveHeld`'s own late-verdict path calls `broadcastCurrentStatus` or any
equivalent). That means a Part B late verdict — the user's answer arriving
after the hold already timed out and handed off, or a `part-b-cancelled`
reconciliation — still emits **no** client status update. The pill sits on
`'waiting'` after a slow eval silently auto-approves. "The cue is now total"
describes the *intent* PR #973 pursued, not the current coverage table; a
future reader should re-run the enumeration above against the live code
before treating this as closed, and #970 should stay open until it does.

The specific wrong "cleanup" this ADR exists to head off: treating the
client pill as harmless decoration because it is explicitly *not* wired into
`sessionStatus` or the StatusWriter. That was true of the mechanism's
blast radius (a stuck pill cannot re-enter the decision/buffer path,
unlike the gate's own internal state), but it does not make a stuck cue
harmless to the user, who is being told to expect a decision that already
happened. Closing #970 means finishing the same enumeration this ADR
performed, against `releaseHeld` and `resolveHeld`, not declaring victory at
`onCancelled`.

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
- `packages/daemon/src/cli/session-phases/hook-bridge-setup.ts:582-745` —
  `broadcastAutoApproveStatus`, `broadcastCurrentStatus`, and the
  `onEvalStart`/`onHandled`/`onCancelled` wiring
- `packages/daemon/src/auto-approve/auto-approve-gate.ts:847-931` —
  `resolveHeld`, `releaseHeld`; grep confirms neither calls
  `broadcastCurrentStatus` or `markHandled` on the late-verdict/hold-timeout
  path — the still-uncovered end paths this ADR flags
- #970 (issue, OPEN as of 2026-08-01 — the enumeration table above and the
  live-log evidence), PR #973 (MERGED 2026-08-01, `onCancelled` only)
- #576 (introduced the client pill), #711 (`isSubagent` skip), #573
  (Part B early push+hold, whose timeout path is the still-uncovered case)
