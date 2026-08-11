# ADR 0022: The status bar waits for a quiet PTY; it never stops painting

**Status:** accepted
**Date:** 2026-08-10
**Owner:** Yahya

## Context

The reserved-row status bar (#565) and Claude's own PTY output are two
unsynchronized writers on one fd. #932 named the real hazard precisely: not
byte-level interleaving (both writes are synchronous `fs.writeSync` on the same
thread) but a paint landing BETWEEN two forwarded chunks, at a boundary that
splits one of Claude's own escape sequences — the bar's DECSC/DECRC pair shares
Claude's cursor-save slot, 166 of 421 occurrences in the installed binary.

Two fixes were written for it, two hours apart on 2026-07-30:

- **PR #933 (19:35), a blanket freeze.** `render()` returned early for as long
  as `hasLiveQuestions()` was true, painting once on the transition in and once
  on the way out.
- **PR #942 (21:28), the durable fix.** `PtyQuiescenceGate`: `isBoundaryClean()`
  as a hard gate (a write can never land mid-sequence) plus `isQuiescent()` as a
  soft one (500 ms since the last chunk).

The durable fix subsumed the freeze, but the freeze was never removed. It
shipped in v0.7.4 and v0.7.5, and the freeze has **no upper bound**: a prompt a
human sits on for ten minutes freezes row N for ten minutes. Worse, the frame it
freezes on is not arbitrary. The escalate that raises the prompt is also what
sets the state to `needs you` — a cue whose entire contract is that it decays
after `ESCALATE_FRESH_S` (60 s). So the common case was a decaying cue pinned on
screen indefinitely, reported from the field as:

```
remi:18766 website:main | no clients | needs you
```

reproduced verbatim, unchanged across 20 simulated minutes and a phone
attaching. This is the [ADR 0020](0020-client-status-cue-totality.md) failure
mode — a status cue with no path back off itself — arriving through the
renderer instead of through the gate's end paths.

## Decision

While a question is live, `isQuiescent()` is promoted to a **hard** gate on every
paint — no heartbeat exemption, no onset/resumed exemption — and the bar keeps
its normal cadence. It does not freeze.

## Consequences

Strictly stronger per-write than the freeze it replaces: the freeze still
permitted its onset paint while Claude was mid-render of the prompt; this
permits nothing mid-render. It is also strictly better for the DECSTBM
re-assertion `buildBarSequence` carries — the freeze suppressed that for the
entire life of a question, where the heartbeat now still fires every
`HEARTBEAT_MS` whenever the PTY is quiet.

What is given up: the onset paint is no longer instantaneous. It waits for the
next tick that finds the PTY quiescent, so up to ~750 ms (250 ms cadence +
500 ms `QUIESCENCE_MS`) can pass between a question going live and the row
reflecting it. That was an explicit exemption before, justified by Claude's
native statusLine disappearing while a dialog is open. It is affordable now
precisely because the bar no longer stops: the value arrives one tick later
instead of being the only value for the whole window.

"Mode 2" exposure (a paint inside a save/restore pair spanning a quiet gap)
remains an accepted residual, unchanged — it was already accepted for every
paint outside a live question, and closing it needs a full VT emulator.

**Obligation this creates:** anything that suppresses paints must be bounded by
something other than a human's attention span. A future gate keyed on "is a
prompt showing" is this bug again.

## Alternatives considered

- **Keep the freeze, make the frozen content time-independent.** Would stop
  `needs you` sticking, but leaves `attached`/`no clients` and the session
  status stale for the whole window — and the bar is the *only* cue on screen
  while a dialog hides Claude's native statusLine. Treats the symptom.
- **Bound the freeze with a timeout.** Picks an arbitrary number, and every
  value is either too short to protect or too long to be useful. The quiescence
  gate already answers the underlying question ("is it safe to paint right
  now?") with a measurement instead of a guess.
- **Remove the live-question gating entirely, relying on #942's gates as-is.**
  Rejected as too loose: the soft gate has documented exemptions (heartbeat,
  edges) that would then let a paint land mid-render of a prompt. Promoting it
  to hard *only* while a question is live keeps those exemptions where they were
  justified and removes them where they are not.

## Receipts

- #1038 (issue) — the field report, both defects, and the reproduction
- `ad8ec6e4` (PR #933, 2026-07-30 19:35) — the freeze, `if (questionLive &&
  !onset) return;`
- `635d1403` (PR #942, 2026-07-30 21:28) — the quiescence + boundary gate that
  subsumed it two hours later
- `git tag --contains ad8ec6e4` → `v0.7.4`; v0.7.5 shipped after, matching the
  field report's "at least two releases ago"
- `packages/daemon/src/cli/status-bar.ts` — module doc protection 1, and
  `render()`'s `(questionLive || !forced) && !this.isQuiescent()`
- `packages/daemon/src/cli/pty-quiescence-gate.ts` — `QUIESCENCE_MS = 500`,
  measured from a real capture
- `packages/daemon/tests/cli/status-bar.test.ts` — `a live question makes
  quiescence a HARD gate`, `a live question suspends the heartbeat exemption`,
  `a "needs you" cue still decays while the question that raised it is open`
- `packages/daemon/tests/cli/attach-client.test.ts` — `the bar keeps tracking
  status while a question (question_snapshot) stays live`, which reads the row
  MID-question so it cannot pass by catching up after the prompt closes
- [ADR 0020](0020-client-status-cue-totality.md) — the same "cue with no path
  back off itself" failure, found via the gate's end paths rather than the
  renderer
