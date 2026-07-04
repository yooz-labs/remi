# Transcript-binding failure-mode matrix

Reference for the e2e harness: each historical failure mode, how to reproduce it
with a real `claude` under remi, and the exact PASS/FAIL oracle. Distilled from
the epic #453 bug history (#321, #427/#428, #429/#430/#433, #438, #451, #452,
#435) and validated against the merged binder.

## The oracle

Before #470, a shadow-mode `TranscriptBinder` (`REMI_TRANSCRIPT_BINDER_SHADOW=true`)
computed decisions alongside the still-driving old inline hook-binding path and
logged `[ShadowBinder] DISAGREE <event>: <diffs>` on divergence in three fields
(durable-store **boundId**, **rotation** emitted-this-event, **watcherPath**
advisory) — the differential harness that proved the binder's behavior before it
was allowed to drive. That comparison path, and the old inline path it compared
against, were both deleted in #470 once the binder had soaked as the
unconditional driver (#503, tagged 0.6.18-dev range). There is now a **single**
binding path: the `TranscriptBinder` always runs in `'drive'` mode
(`hook-bridge-setup.ts` constructs it with the literal `'drive'` mode, no flag).
`REMI_TRANSCRIPT_BINDER_SHADOW` no longer exists anywhere in the daemon;
`REMI_TRANSCRIPT_BINDER_ENABLED` is still read but only logs a one-line
deprecation warning on `false` — it no longer restores an alternate path.

Every failure mode below is validated **directly against the binder's own
behavior**, not by disagreement with an alternate implementation. The oracle is
the live daemon log plus the on-disk transcripts:

- `[Binder] Lock adopted from binding store: claude=<id>` — first bind, the
  common case (cli.ts pre-writes the binding before spawn; the first hook event
  finds it already in the store).
- `[Binder] Transcript from <hook-or-DirPollRotation>: claude=<id>, transcript=<path>`
  — first-adopt-via-event path (the store did not yet have the id when the
  event arrived), or the tail of a dir-poll-driven rotation (fires with
  `hook-or-DirPollRotation` = `DirPollRotation`).
- `[Binder] Claude restart detected (ended=<bool>): <old> -> <new>` — a rotation
  classified via a real hook event (`/clear`, `/resume`).
- `[Binder] No-hooks rotation detected via dir poll: <old> -> <new> (<path>)` —
  a rotation the 1.5s re-arming dir-poll caught (the #452 backstop; it also
  frequently wins the race against the hook path even when hooks are up, since
  it is a local `readdir` versus a hook POST round-trip).
- `[Binder] rotation poll: <id> owned by port <p>, not <ours>; ignoring` —
  sibling-marker gate rejecting a foreign transcript during the poll.
- `[Binder] Dropped foreign <event>: lock=<id> incoming=<id>` — sibling-marker
  gate rejecting a foreign transcript at the hook-listener boundary
  (`binder.admits()`).
- the on-disk `<id>.jsonl` files themselves — an id actually changed, content
  segregated, the old file frozen.

## Two non-negotiable traps

1. **Assert the on-disk `<id>.jsonl` actually changed (B ≠ A) before scoring.** A
   reused/`/compact` session id makes `isRotation` false and the classifier
   short-circuits to `match` (`session-lock-classifier.ts`) — the code under
   test never runs and the test passes for the wrong reason.
2. **In any zombie variant, kill the inner `claude` child PID only, never the
   remi wrapper.** `pkill remi` self-reaps the sibling and the wedge never forms
   (vacuous). The zombie is: live remi pid + dead `claudeChildPid`.

## Per-mode summary

| Mode | Symptom (pre-epic) | Trigger | Oracle |
|---|---|---|---|
| **fm-321** sibling hook-lock cached | a daemon goes permanently deaf to its own claude with a sibling in the dir; killing the sibling never recovers it | two daemons same cwd; kill sibling; permission in survivor | survivor processes its own PermissionRequest after sibling dies |
| **fm-427** cross-bind | daemon-B answers a question claude-A asked; "messages not from this session" | two daemons same cwd, fresh bindings | each binds its own `<uuid>.jsonl`; content segregated; co-located events classify `foreign` |
| **fm-430** binding drift / STALE_BINDING | after `/clear`, second client stuck on old id, no `session_rotated` | single daemon; `/clear` (store pre-assigns new id before SessionStart) | one `session_rotated`, binding updates; no double-emit even when the store raced ahead of the hook |
| **fm-438** double-emit | chat clears/reloads twice; or a stale re-emit re-binds to the dead id → STALE_BINDING | `/clear`, or kill+resume (store-race ordering), or A→B→A re-resume | exactly one `[Binder] Claude restart detected` (or dir-poll equivalent) per A→B; `emitRotated`'s `lastAnnouncedRotationId` guard prevents a duplicate on the same id |
| **fm-451** zombie poisons sibling-defer | long session returns "Transcript for session not found" after `/clear`; log floods `Dropped foreign` | two daemons same cwd; kill one's inner claude child; `/clear` the other | victim rebinds + streams; `owned by port X, not Y; ignoring`; no "not found" |
| **fm-452** no-hooks / slow-flush wedge | `/clear` with hooks down → locked-but-unwatched → "Transcript for session not found" | single daemon, hooks down; `/clear`; follow-up | `[Binder] No-hooks rotation detected via dir poll`, watcher rearmed. The only failure mode that needs hooks **actually** disabled (not just racing the poll) — not automated in `run.sh`; see the manual leg below |
| **fm-435** (a/c/d) false-positive questions, multi-question, fails-to-connect | phantom question cards; one question slot; retries a dead port | numbered-list prompt; concurrent subagent+main permission; occupy default port then attach | epic #435 phases 1/2/4 behavior (numbered prompt renders once; concurrent subagent+main permission both surface; a dead port is not retried), validated under the single always-on binder path. Pre-#470 this ran with the binder flagged **off** to prove the bug was unrelated to it; that isolation leg no longer exists — the binder can no longer be disabled (`REMI_TRANSCRIPT_BINDER_ENABLED` is a no-op, #470) |

## Minimal run order

1. Two daemons, same cwd — fm-427 cross-bind + fm-451 zombie recovery,
   end-to-end.
2. Single daemon, hooks up, one long session — fm-430 + fm-438 + A→B→A +
   `/compact` negative, end-to-end, plus the positive binding invariant (bind,
   follow-up routes to the rotated session, old transcript stays frozen).
3. Single daemon, hooks **down** — fm-452 (the only run exercising the dir-poll
   as the *sole* path; highest value, lowest redundancy). Manual only — the
   harness has no way to actually disable hook delivery, only to race it.

`run.sh` implements a practical subset: the single-daemon run (2) and the
two-daemon cross-bind/zombie run (1). The hooks-down leg (3) is documented here
for manual execution.
