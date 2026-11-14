# Card F1772: make receiving a transcript message not scan and rewrite the whole transcript (issue #1772)

Status: ready
Tier: worker
Timebox: M, 4 hours; escalate at 1 day or two failed approaches
Needs: xcode
Depends: develop `c5471eda` or later
Branch: `fix/issue-1772-transcript-apply` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/transcript-apply` (the manager creates it with `git worktree add -b` and runs `bun install`)
Plan: issue #1772 and its 2026-11-14 comment (read both first)

## Goal

Receiving one transcript message costs time that does not grow with the length of the session's transcript, so replaying a long history after a reconnect cannot stall the main actor; the order and replacement semantics that the app has today stay exactly as they are unless the daemon's streaming shows they can safely differ.

## Context

- Evidence (symbolicated with the matching dSYM): the build 25 TestFlight watchdog kill had the main thread in `closure in MachineStore.connect` then `MachineStore.receive(_:from:generation:)` (MachineStore.swift line 2559 in that build) then `MachineStore.apply(_:to:)`, then `removeAll(where:)` and `destroy for TranscriptContentMessage`. In current develop (`packages/native/RemiKit/Sources/RemiKit/Store/MachineStore.swift`, `private static func apply(_ message: TranscriptContentMessage, to transcript: inout [TranscriptContentMessage])` near line 1867): `transcript.removeAll { $0.entryUuid == message.entryUuid }` then `transcript.append(message)`.
- After a reconnect each session's whole history is streamed again with one message per entry (`packages/daemon/src/.../transcript-events.ts`); each incoming entry matches an entry the app already holds, so every message scans the whole array and moves its entry to the end. Quadratic work on the main actor.
- Current semantics to preserve unless proven safe to change: an entry with an existing `entryUuid` is replaced and ends up LAST; a new entry is appended. Find out from the daemon side (the streaming order of a history load, whether an entry is ever re-sent later because it changed, such as a tool result completing) and from the existing tests whether "moves to the end" is relied on. If it is, keep it; if a replay of the same ordered history yields the same final order either way, say so and prove it with a test.
- Other readers of the transcript array and its `transcriptsBySession` storage are in `MachineStore.swift` and the views (`ChatView` or similar); grep for every use before changing the type of what is stored.
- No simulator, no app launch, no Xcode MCP. No wall-clock timing assertions in tests (they flake under load; see issue #1778).

## Scope

May change: `packages/native/RemiKit/Sources/RemiKit/Store/MachineStore.swift` (the transcript apply path and, if needed, the storage of a session's transcript); a new pure, tested ordered-transcript type in `packages/native/RemiKit/Sources/RemiKit/` (for example `RemiOrderedTranscript.swift`) if that is the chosen design; new tests in `packages/native/RemiKit/Tests/RemiKitTests/`; the PR body.
No other file; not the daemon, not the wire, not the views unless a type change forces a mechanical edit (list each in the PR body).
Another worker (F1771, PR #1775) is changing question-related parts of `MachineStore.swift` (the `.connected` and `.questionSnapshot` handlers and the session-removal path); stay out of those regions and merge develop in (merge commit, never rebase) if the PR conflicts.

## Decided design

Settled:
1. A pure, public-or-package ordered store for a transcript (for example `RemiOrderedTranscript`) whose `apply(message)` is amortized constant time per message, using an index from `entryUuid` to position (a dictionary plus tombstones with periodic compaction, or an ordered structure of your choice), with the exact replacement semantics found above, and an `entries` view in order for the readers.
2. Deterministic tests, no timing: (a) literal tables for new entry, duplicate entry (replaced, ends last), interleaved duplicates, replay of the same ordered history twice (final content and order equal to a single pass), and an empty transcript; (b) a deterministic work-count guard: the pure type exposes an internal counter of element visits or moves (for example `testingElementVisits`) and a test asserts the count for 1,000 and for 4,000 replayed duplicates is linear (less than a small constant times the entry count), so a reintroduced scan fails the test without any clock.
3. `MachineStore` uses the new type for every transcript write; the old `removeAll` scan is gone; one source-read guard (repo style, `ComposerSubmissionTests`: `#filePath`, `String(contentsOf:)`, range-based slicing with `#require`) asserts `apply` no longer contains `removeAll`.
4. A store-level behavior test drives `store.receive(...)` the way `SessionAddressingTests` does with a replay of a multi-hundred-entry history, asserts the resulting transcript equals the original order, and that replay on a new connection generation does not duplicate entries.
Not changing: what a transcript message means, the daemon's streaming, the views' presentation, the `transcriptComplete` handling.
The worker may choose: the data structure, names, test names.

Never do: add a timer, a time window or a wall-clock assertion; change the wire; delete or invert an existing assertion (list changed assertion texts in the PR body).

## Acceptance

1. The pure type and its literal tables and the work-count guard pass, and the guard fails if a linear scan per message is reintroduced (a revert check: temporarily restore a scan inside the type or the old `removeAll` and show the guard or the source guard fails).
2. The store behavior test passes and fails with the old `removeAll` apply (revert check, log in the evidence folder).
3. `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiOrderedTranscript` passes (use the name you chose for the type; name the tests in the PR body).
4. The build script ends with a receipt for the final head, no simulator.
5. The PR body states what changed, the semantics found and kept (or proved safe to change), which tests cover each part, what is not verified (the real replay on a device; no timing measurement was made), and uses only "Addresses #1772" as a reference.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiOrderedTranscript` passes; then `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes (a failure in `APNsCallbackOrderTests` alone is the known timing flake #1778: rerun that suite once and say so); `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock packages/native/scripts/build-exact-native.sh --expected FINAL_HEAD --receipt-dir /Volumes/S1/derived/remi-transcript-apply-receipt` (no `--simulator`) ends with `Receipt:` for that head (replace FINAL_HEAD with the pushed head hash); `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing.
Another agent also uses the Xcode lock; waiting is normal; never signal a process you did not start.

## Stop conditions

The semantics cannot be preserved without a change to the wire or the views beyond a mechanical edit; a test outside the scoped files fails for a reason other than #1778.

## Report

The preamble's report, plus the semantics finding, one line per acceptance item with the test or command that covers it, the receipt path, and the final head after one push.
