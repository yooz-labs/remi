# Card F1771: do not re-notify questions that were already pending when a connection (re)established (issue #1771)

Status: ready
Tier: worker
Timebox: M, 4 hours; escalate at 1 day or two failed approaches
Needs: xcode
Depends: develop `3bb7ad9d` or later
Branch: `fix/issue-1771-notification-replay` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/notif-replay` (exists; `bun install` done)
Plan: issue #1771 (read it first), `docs/agent-reference/questions-and-notifications.md`

## Goal

When the app reconnects or relaunches, the questions that were already pending are not posted again as local notifications; only a question that first appears after its machine's connection is established is posted, so the burst of notifications on opening the app disappears, and the one doc line that says the iPhone posts no local question notifications is corrected.

## Context

Owner decision (2026-11-14, "yes" to the manager's recommendation): keep local question notifications, but only for questions that are genuinely new; do not remove them.
Mechanism (read from source, develop `3bb7ad9d`): `packages/native/iPhone/PhoneLiveRootView.swift`, the `.onChange(of: activeQuestionIDs, initial: true)` block, sets its baseline from the first value it sees; at a cold launch that is an empty list, so every question that then loads counts as new and goes through `PhoneNotificationCoordinator.notify`. On a reconnect the daemon re-sends every pending question as a live `question` message (`packages/daemon/src/.../pending-question-resend.ts`, `connection-events.ts`), the phone appends them (`MachineStore.swift`, search for where `question` messages are applied), and the same block posts each one.
Unknown to you at dispatch: whether the wire marks a re-sent question (a `resent` flag, a snapshot-complete message, or a question timestamp that predates the connection). Find out first; read the `Question` model and the question message in `packages/shared/src` and `WireMessages.swift`.
The local notification id is `machine|session|question` and does not match the id of an APNs card for the same question; do not try to merge the two in this card (note it in the PR body as not done).
No simulator, no app launch, no Xcode MCP (a simulator may hold the real hub).

## Scope

May change: `packages/native/iPhone/PhoneLiveRootView.swift`; a new pure public rule type in `packages/native/RemiKit/Sources/RemiUI/` (for example `RemiQuestionNotificationPolicy.swift`) and its tests in `packages/native/RemiKit/Tests/RemiKitTests/`; at most one small additive change in `MachineStore.swift` or the shared wire model only if the wire gives no usable signal and a purely client-side signal needs a hook (list it in the PR body; no protocol change); `docs/agent-reference/questions-and-notifications.md` (the "APNS push only (no local notifications for questions)" sentence near line 375 and any sentence it contradicts); the PR body.
No other file; not the daemon, not the Mac app, not `PhoneNotificationCoordinator.swift`'s notify behavior.

## Decided design

Settled:
1. A pure, public, table-tested rule: given the question ids known so far, the current question ids, and whatever signal step 2 finds, return the ids to post and the new known set. Literal expectations in the tests; the screen calls the rule once.
2. A question already pending when its machine's connection (re)established is never posted locally. Choose the signal in this order and say which one you used and why: (a) an explicit wire marker for a re-sent question; (b) the question's own timestamp compared with the time the machine's connection became established; (c) a per-machine snapshot-complete point. Never a fixed delay or a time window after launch (flaky). If none of (a) to (c) can be built without a protocol change, stop and report.
3. Cold launch: the empty first list must no longer make every later-loaded question look new.
4. A question that is genuinely new while connected still posts exactly once; removing a question still removes its delivered notification as today.
5. The doc sentence says what the code does: the iPhone posts a local question notification for a question first seen while connected, in addition to APNS cards when secure push is active, and the two ids differ.
Not changing: notification content, preferences, the summarizer, the coordinator, the APNS path, the Mac.
The worker may choose: names, the signal among (a) to (c), test names.

Never do: add a delay or timer heuristic; change the wire without stopping; delete or invert an existing assertion (list any changed assertion text in the PR body); use a size class, device or idiom.

## Acceptance

1. A pure rule with a literal table covering at least: cold launch with an empty first list then three questions loaded together (none posted when they were pending at connection; all posted when they are genuinely newer than the connection), one new question while connected (posted once), the same question seen twice (posted once), a question removed then re-added, reconnect re-send of the same ids (none posted), and an empty current set.
2. A source-read guard in the repo style (`ComposerSubmissionTests`, range-based slicing) that `PhoneLiveRootView.swift` calls the rule and no longer builds the baseline inline; one revert check per behavior (restore the old inline baseline and show the new tests fail).
3. The doc line is corrected and `typos` is clean.
4. `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiQuestionNotificationPolicy` passes and the PR body names the file and tests.
5. The build script ends with a receipt for the final head, no simulator.
6. The PR body states what changed, the signal chosen and why, what is not verified (the real burst on a device; duplicate APNS plus local notification is not addressed), that no visual or device run was done, and uses only "Addresses #1771" as a reference.

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter RemiQuestionNotificationPolicy` passes; then `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests` passes; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock packages/native/scripts/build-exact-native.sh --expected FINAL_HEAD --receipt-dir /Volumes/S1/derived/remi-notif-replay-receipt` (no `--simulator`) ends with `Receipt:` for that head (replace FINAL_HEAD with the pushed head hash); `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing.
Another agent also uses the Xcode lock for stress runs; waiting for it is normal, never kill another process.

## Stop conditions

No signal among (a) to (c) exists without a protocol change; a fix would change notification content, the APNS path or the Mac; a test outside the scoped files fails.

## Report

The preamble's report, plus one line per acceptance item with the test or command that covers it, the signal chosen, the receipt path, and the final head after one push.
