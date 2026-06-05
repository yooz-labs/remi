# Transcript-binding failure-mode matrix

Reference for the e2e harness: each historical failure mode, how to reproduce it
with a real `claude` under remi, and the exact PASS/FAIL oracle. Distilled from
the epic #453 bug history (#321, #427/#428, #429/#430/#433, #438, #451, #452,
#435) and validated against the merged binder.

## The oracle

The shadow binder (`REMI_TRANSCRIPT_BINDER_SHADOW=true`) computes decisions
alongside the live old path and logs `[ShadowBinder] DISAGREE <event>: <diffs>`
on any divergence in three fields only: durable-store **boundId**, **rotation**
emitted-this-event, **watcherPath** (advisory). Silent on agreement. It is
**hook-fed only** — silent when hooks are down.

`[ShadowBinder] DISAGREE` is a valid pass/fail signal **only** for:
- **fm-438** — `rotation binder=false old=true` on the duplicate-carrying event (binder dedups the old path's double-emit).
- **fm-430** — `rotation binder=true old=false` on the `/clear` SessionStart when the store raced ahead of the hook.
- **fm-451** — `boundId binder=<new> old=<old>` when the old path defers on a false-live zombie sibling and the binder rebinds.

It is **silent-by-design / not a bug** for fm-321 (no field captures admit-vs-drop), fm-427 (`watcherPath` is advisory; deterministic binding already agrees), and **structurally blind** for fm-452 (the dir-poll is disabled in shadow). Those are **drive-mode** validations.

## Two non-negotiable traps

1. **Assert the on-disk `<id>.jsonl` actually changed (B ≠ A) before scoring.** A
   reused/`/compact` session id makes `isRotation` false and the classifier
   short-circuits to `match` (`session-lock-classifier.ts`) — the code under
   test never runs and the test passes for the wrong reason.
2. **In any zombie variant, kill the inner `claude` child PID only, never the
   remi wrapper.** `pkill remi` self-reaps the sibling and the wedge never forms
   (vacuous). The zombie is: live remi pid + dead `claudeChildPid`.

## Per-mode summary

| Mode | Symptom (pre-epic) | Trigger | Oracle | Flag |
|---|---|---|---|---|
| **fm-321** sibling hook-lock cached | a daemon goes permanently deaf to its own claude with a sibling in the dir; killing the sibling never recovers it | two daemons same cwd; kill sibling; permission in survivor | drive: survivor processes its own PermissionRequest after sibling dies (shadow silent here) | drive |
| **fm-427** cross-bind | daemon-B answers a question claude-A asked; "messages not from this session" | two daemons same cwd, fresh bindings | each binds its own `<uuid>.jsonl`; content segregated; co-located events classify `foreign` | both |
| **fm-430** binding drift / STALE_BINDING | after `/clear`, second client stuck on old id, no `session_rotated` | single daemon; `/clear` (store pre-assigns new id before SessionStart) | shadow: `DISAGREE SessionStart rotation binder=true old=false`; drive: one `session_rotated`, binding updates | both |
| **fm-438** double-emit | chat clears/reloads twice; or a stale re-emit re-binds to the dead id → STALE_BINDING | `/clear`, or kill+resume (store-race ordering), or A→B→A re-resume | exactly one rotation per A→B; shadow `DISAGREE rotation binder=false old=true` on the duplicate event | both |
| **fm-451** zombie poisons sibling-defer | long session returns "Transcript for session not found" after `/clear`; log floods `Dropped foreign` | two daemons same cwd; kill one's inner claude child; `/clear` the other | victim rebinds + streams; `owned by port X, not Y; ignoring`; no "not found" | both |
| **fm-452** no-hooks / slow-flush wedge | `/clear` with hooks down → locked-but-unwatched → "Transcript for session not found" | single daemon, hooks down; `/clear`; follow-up | drive: `[Binder] No-hooks rotation detected via dir poll`, watcher rearmed | **drive only** |
| **fm-435** (a/c/d) false-positive questions, multi-question, fails-to-connect | phantom question cards; one question slot; retries a dead port | numbered-list prompt; concurrent subagent+main permission; occupy default port then attach | flag-independent (epic #435 phases 1/2/4); binder must be **inert** (no `[Binder]`/`[ShadowBinder]` lines) | off |

## Minimal run order

1. Two daemons, same cwd, **shadow** — fm-427 race + fm-451 zombie shadow leg.
2. Two daemons, same cwd, **drive** — fm-427 + fm-451 + fm-321 recovery end-to-end.
3. Single daemon, hooks up, **shadow**, one long session — fm-430 + fm-438 + A→B→A + `/compact` negative.
4. Single daemon, hooks up, **drive**, one long session — the same, end-to-end + the positive binding invariant + the newly-wired dropped hooks.
5. Single daemon, hooks **down**, **drive** — fm-452 (the only run exercising the dir-poll; highest value, lowest redundancy).
6. Single daemon, binder **off** — fm-435 a/c/d (binder must be inert).

`run.sh` implements a practical subset (shadow + drive single-daemon, and the
two-daemon cross-bind/zombie). The hooks-down (5) and binder-off (6) legs are
documented here for manual execution.
