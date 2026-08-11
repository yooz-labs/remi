# ADR 0022: Status-bar liveness is bounded by HEARTBEAT_MS, never by a human

**Status:** accepted
**Date:** 2026-08-10
**Owner:** Yahya

## Context

The reserved-row status bar (#565) and Claude's own PTY output are two
unsynchronized writers on one fd. #932 named the hazard precisely: not
byte-level interleaving (both are synchronous `fs.writeSync` on one thread) but
a paint landing BETWEEN two forwarded chunks, at a boundary that splits one of
Claude's own escape sequences.

Two fixes were written for it, two hours apart on 2026-07-30:

- **PR #933 (19:35), a blanket freeze.** `render()` returned early for as long
  as `hasLiveQuestions()` was true, painting once on the transition in.
- **PR #942 (21:28), the durable fix.** `PtyQuiescenceGate`: `isBoundaryClean()`
  as a hard gate (a write can never land mid-sequence) plus `isQuiescent()` as a
  soft one (500 ms since the last chunk), the latter with documented exemptions
  for the heartbeat and the onset/resumed edges.

The freeze was never removed and shipped in v0.7.4 and v0.7.5. It has **no upper
bound**: a prompt a human sits on for ten minutes freezes row N for ten minutes.
The frame it freezes on is not arbitrary — the escalate that raises the prompt
is also what sets the state to `needs you`, a cue whose contract is that it
decays after `ESCALATE_FRESH_S` (60 s). Field report, reproduced verbatim and
held across 20 simulated minutes and a phone attaching:

```
remi:18766 website:main | no clients | needs you
```

This is the [ADR 0020](0020-client-status-cue-totality.md) failure mode — a cue
with no path back off itself — arriving through the renderer rather than through
the gate's end paths.

**#1038's first attempt got this wrong in an instructive way.** Rather than just
deleting the freeze, it replaced it: `isQuiescent()` was promoted to a hard gate
while a question was live, removing the heartbeat and edge exemptions there. The
stated reasoning was that this is "strictly stronger per-write" (true) and that
a deliberating human leaves the PTY quiet (**false**). This repo had already
recorded the counter-evidence, from a live session: a held permission does not
idle the PTY, because Claude's TUI spinner keeps animating on its own timer
(#1026, see `attach-client.ts`'s `renderQuestionBanner`). Driven against the real
`PtyQuiescenceGate` with 150 ms spinner frames, `isQuiescent()` never once became
true and the bar painted **zero times in ten minutes** — worse than the freeze,
which at least guaranteed its onset paint. It passed its own test suite because
every test injected `isQuiescent` as a hand-flipped boolean.

## Decision

Delete the freeze and add nothing in its place: a live question suppresses no
paint. #942's gates are the protection, unchanged and unconditioned on whether a
question is open.

Consequently, **no suppression in this file may be scoped to a question being
live.** Liveness is bounded by `HEARTBEAT_MS`; it may never depend on the PTY
going quiet, because the case that most needs a live bar is exactly the case
where it never does.

## Consequences

Staleness while Claude streams is bounded by `HEARTBEAT_MS` (2 s), not by the
250 ms cadence — a status change during a spinning prompt reaches the row on the
next heartbeat. The 250 ms figure applies only when the PTY is quiescent.

That bound is conditional on the HARD boundary gate, and the condition is not a
technicality. `isBoundaryClean()` has no exception — not even the heartbeat —
and `render()` is only attempted on the timer, so a tick landing on a dirty
boundary is dropped with no retry. Measured residuals, none introduced by this
decision: an unterminated OSC followed by silence holds the gate dirty
indefinitely (the `MAX_*_RUN_BYTES` escape hatches are byte-counted, so they
never trip when no further bytes arrive) — 1 paint in ten minutes; alternating
mid-CSI chunk boundaries stretch the worst gap to ~2750 ms, over the stated
bound. The honest guarantee is therefore "`HEARTBEAT_MS` whenever the stream
reaches a clean boundary", which is every realistic stream. Closing the rest
means owning a VT parser, which is the same answer mode 2 gets.

The DECSTBM re-assertion `buildBarSequence` carries is restored during a live
question. The freeze suppressed it for the question's entire life — precisely
the window where row N is least protected from Claude resetting the region — and
so did the first attempt, for the same reason.

`notifyScrollRegionReset()` works again during a live question. It is called
synchronously from the chunk observer, so `isQuiescent()` is false by
construction at that moment; under either the freeze or the first attempt its
repaint could never land.

Mode-2 exposure (a paint inside a save/restore pair spanning a quiet gap) is
unchanged and remains an accepted residual — it already applied to every paint
outside a live question, and closing it needs a full VT emulator.

**Obligation:** a test that injects `isQuiescent` proves nothing about
starvation. The suite must also drive the real `PtyQuiescenceGate` with real
chunk bytes at spinner cadence, which is what
`StatusBar against the real PtyQuiescenceGate` exists for.

## Alternatives considered

- **Promote `isQuiescent()` to a hard gate while a question is live.** The first
  attempt. Measured at zero paints in ten minutes against a spinning PTY. Its
  premise — that a deliberating human means an idle PTY — is contradicted by
  #1026.
- **Keep the freeze, make the frozen content time-independent.** Stops `needs
  you` sticking, but leaves the attach label and session status stale for the
  whole window, and the bar is the *only* cue on screen while a dialog hides
  Claude's native statusLine. Treats the symptom.
- **Bound the freeze with its own timeout.** A second arbitrary constant beside
  `HEARTBEAT_MS`, which already means "the row must be rewritten at least this
  often." Two bounds that must agree is one more than necessary.

## Receipts

- #1038 (issue) — the field report, both defects, and the reproduction
- `ad8ec6e4` (PR #933, 2026-07-30 19:35) — the freeze
- `635d1403` (PR #942, 2026-07-30 21:28) — the gates that subsumed it two hours
  later; `git tag --contains ad8ec6e4` -> `v0.7.4`, and v0.7.5 shipped after
- `packages/daemon/src/cli/attach-client.ts` — `renderQuestionBanner`'s #1026
  note: "a held permission blocking Claude's hook call does NOT guarantee an
  idle PTY — the TUI spinner keeps animating on its own timer while the hook is
  pending", observed live
- `packages/daemon/src/cli/pty-quiescence-gate.ts` — `QUIESCENCE_MS = 500`,
  measured from a real capture
- `packages/daemon/tests/cli/status-bar.test.ts` — `a NEVER-quiescent PTY still
  paints while a question is live, bounded by HEARTBEAT_MS`; the
  `against the real PtyQuiescenceGate` block, which drives real chunks at 150 ms
  and would have caught the first attempt
- `packages/daemon/tests/cli/attach-client.test.ts` — the end-to-end path with
  `raw_pty_output` flowing throughout, reading the row mid-question so it cannot
  pass by catching up after the prompt closes
- [ADR 0020](0020-client-status-cue-totality.md) — the same "cue with no path
  back off itself" failure, and the totality requirement that
  `onAttachStateChanged` (this PR's second half) is emitted from the two
  mutation sites to satisfy
