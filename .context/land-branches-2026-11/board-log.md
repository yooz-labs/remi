# Land pushed branches into develop: log

<!--
Append-only history for the board beside this file.
Written by `manager_board.py log` and `decide`; never rewrite or delete a row.
The manager reads the newest rows through `status`, never the whole file.
-->

## Decisions

| Time | Decision | By | Reason |
|---|---|---|---|
| 2026-11-12T19:21-08:00 | Review big branches by path chunks, not commit ranges: commits interleave tests and sources | lead |  |
| 2026-11-12T19:21-08:00 | Fresh round 1 for #1728, #1657, #1512 (earlier reviews not on the PR); none for #1707 (two rounds on record) | lead |  |
| 2026-11-12T19:21-08:00 | Native gates serialize on an Xcode lock (lockf), not on slots; Sonnet slots hold reviewers only | lead |  |
| 2026-11-12T19:21-08:00 | Frontier tier (Fable claude-fable-5-2) only for A02, as the owner requested | owner |  |
| 2026-11-12T19:58-08:00 | Q1: Keep the #1512 phone gate: L09 runs last, then waits for the owner's phone check | owner | owner answer in chat, 2026-11-12 |
| 2026-11-12T19:58-08:00 | Q4: Fold image-availability into native-images; delete it after L08 via owner commands | owner | owner answer in chat, 2026-11-12 |
| 2026-11-12T19:58-08:00 | Q5: Park #1711: keep the branch, no PR | owner | owner answer in chat, 2026-11-12 |
| 2026-11-12T19:58-08:00 | Q6: Fold #1641 tests into its first implementation PR; keep the branch | owner | owner answer in chat, 2026-11-12 |
| 2026-11-12T19:58-08:00 | Q8: Delete the superseded branches only via commands handed to the owner (L13) | owner | owner answer in chat, 2026-11-12 |
| 2026-11-12T19:58-08:00 | Q9: Add a Codex Luna second reviewer on L03, L06 and chunk L08-R4 only, on top of Sonnet | owner | owner answer in chat, 2026-11-12 |
| 2026-11-12T19:58-08:00 | Q10: Codex danger-full-access for native Swift cards only, in a clean worktree; every other Codex card stays workspace-write | owner | owner answer in chat, 2026-11-12 |
| 2026-11-12T19:58-08:00 | Defaults approved as proposed: Parity, Slots, daily budget (30; Luna 8, Terra 4, Sonnet 16, Opus 4; advisors 8, Fable 1), merge authority develop only with merge commits | owner | owner answer in chat, 2026-11-12 |
| 2026-11-12T20:13-08:00 | Q4 answer (fold image-availability into native-images) is suspended: new evidence in the #1313 artifacts says native-images should not land as a dormant PR; Q11 asks again | lead | design review, 2026-11-12; owner answered Q4 without this evidence |
| 2026-11-12T21:20-08:00 | Q2: One bounded xcodebuild test attempt under the Xcode lock with a timeout; on a stall rely on hosted swift test and log it | owner | owner answer in chat, 2026-11-12 |
| 2026-11-12T21:20-08:00 | Q3: Approve the #1731 fix; L06 completes the plan's negative controls and lands after L03 | owner | owner answer in chat, 2026-11-12 |
| 2026-11-12T21:20-08:00 | Q7: Files are synthetic; the manager session pushed them to patch/issue-1727-store-callback-order; whether a PR is wanted is Q16 | owner | owner answer in chat, 2026-11-12 |
| 2026-11-12T21:20-08:00 | Q11: Image-availability only: land it as its own PR (L14) after L03; park native-images on its branch as evidence; L08 dropped (parked) | owner | owner answer in chat, 2026-11-12 |
| 2026-11-12T21:20-08:00 | Q12: Park #1720 until #1727 is resolved; L07 parked, not dropped | owner | owner answer in chat, 2026-11-12 |
| 2026-11-12T21:20-08:00 | Q13: Accept the recorded review rounds plus one delta review from each recorded head for #1728, #1657, #1512 | owner | owner answer in chat, 2026-11-12 |
| 2026-11-12T21:20-08:00 | Q14: Install the Codex rules file for the loop; the owner runs the copy command; the develop-unchanged check stays | owner | owner answer in chat, 2026-11-12 |
| 2026-11-12T21:20-08:00 | Q15: The manager may merge a large review-fix PR into its step PR's head branch only, after the same merge gate; never into develop directly | owner | owner answer in chat, 2026-11-12 |
| 2026-11-12T21:20-08:00 | Q4 (fold image-availability into native-images) is superseded by Q11: image-availability lands alone; native-images is parked | owner | owner answer to Q11, 2026-11-12 |
| 2026-11-12T21:23-08:00 | Q16: no PR for #1727 yet | owner |  |
| 2026-11-12T22:11-08:00 | Q17: accept hosted native CI as evidence for L03's local pairing baseline; proceed to review | owner |  |
| 2026-11-13T00:57-08:00 | Q18: Codex danger-full-access extended from native-only (Q10) to L02 and every other Codex card that needs it; same bounds (clean worktree, push only the card's branch, develop-unchanged check) | owner |  |
| 2026-11-13T01:02-08:00 | L03 advisor ruling (c): the Luna finding (child key pin has no proof of possession before auth_response) is a description defect, accepted as a documented protocol limit; fix = PR body and test wording, a 'copied' peer test, follow-up issue (owner files); no production change | advisor |  |
| 2026-11-13T01:06-08:00 | Owner (2026-11-13, chat): the manager may file and comment on issues, and open, edit, comment on and close PRs, in addition to merging into develop; still no main, no force-push, no branch or worktree deletion without a question | owner |  |
| 2026-11-13T01:10-08:00 | Owner (2026-11-13, chat): the manager and the lead (not workers or reviewers) may push to develop, push builds to TestFlight, and delete branches and worktrees that are done; main, force-push and anything for workers stay excluded | owner |  |
| 2026-11-13T05:46-08:00 | Q19: merge gate item 3 (fresh base) relaxed: a PR may merge when its branch merges cleanly with develop (git merge-tree), shares no changed file with the commits merged since its last CI run, and DV verifies the develop tip after every merge; a red DV stops all merges | owner |  |
| 2026-11-13T05:55-08:00 | Q20: DV baseline extended: the environment-dependent 'owned empty launch directory required' failures in PairingAttemptTests and PairingSourceTests are the local baseline; DV reruns with both skipped and everything else must pass; hosted native CI is the authority for those suites | owner |  |
| 2026-11-13T06:10-08:00 | Owner (2026-11-13, chat): do not wait for a free Luna slot: when the Codex Luna slots are full, run worker cards (L05, L14) on Claude Sonnet implementers instead | owner |  |
| 2026-11-13T06:13-08:00 | Owner (2026-11-13, chat): the rule that a Codex card never falls back to Claude is wrong: Codex and Claude worker slots are both used and maximized (a worker card goes to whichever platform has a free fitting slot); PR reviewers are Claude Sonnet only, the advisor is Claude Opus only (the Luna second reviewer of Q9 is superseded; no Codex reviewers), and the lead is the current session (no separate lead agent) | owner |  |
| 2026-11-13T06:14-08:00 | Owner (2026-11-13, chat): slots are for workers only; PR reviewers, advisors and the lead are extra to the slots (reviewers no longer wait for or consume a Claude Sonnet worker slot) | owner |  |
| 2026-11-13T06:14-08:00 | Slots are for workers only; reviewers, advisor and lead extra (owner); L09 given to an Opus worker since Terra is busy | manager |  |

## Log

| Time | Event |
|---|---|
| 2026-11-12T19:58-08:00 | Owner answered Q1, Q4, Q5, Q6, Q8, Q9, Q10 and approved the defaults; Q2, Q3, Q7 stay open |
| 2026-11-12T20:13-08:00 | Pack review (executability, design) applied: CP1 and L14 added, L07 L08 L09 A01 dependencies changed, Q11 to Q14 asked |
| 2026-11-12T21:20-08:00 | Owner answered Q2, Q3, Q7, Q11 to Q15; L03 L04 L06 L14 todo; L08 dropped (parked); L07 parked; Q16 asked for #1727 |
| 2026-11-12T21:23-08:00 | L10: push verified at 9e7ddf41; Q16 owner: no PR yet |
| 2026-11-12T21:25-08:00 | dispatched L01 (luna, -C main, thread 01a1d35d-5358), L02 (luna, thread 01a1d35d-546a), L03 (terra, full access, thread 01a1d35d-5641); develop at 1cbdcc6f; rules file confirmed forbidden for gh pr merge |
| 2026-11-12T21:51-08:00 | L01 report verified (head b379ea64, scope ok, 8 lost lines all classified, develop unchanged); RV docs reviewer dispatched |
| 2026-11-12T21:53-08:00 | L03 report: head unchanged 5c1f9380, PR body extended, iPhone build ok, local swift test only passes with --skip PairingAttemptTests; Mac test failed on the same baseline (not a stall); Q17 asked |
| 2026-11-12T21:53-08:00 | L02 round 1 stopped: node_modules symlinks pointed at removed worktree terminal-service (manager cleanup of 2026-11-12); replaced with real bun install; redispatched as round 3 with continuation (local merge commit 051e9900) |
| 2026-11-12T21:53-08:00 | L04 dispatched (luna, full access, thread 01a1d377-3dec); L01 RV docs reviewer running |
| 2026-11-12T22:11-08:00 | L01 RV docs report: 5 findings (2 Important, 2 Moderate, 1 Minor), all decided fix; findings.md in L01/r2; fix worker waits for a free Luna slot |
| 2026-11-12T22:38-08:00 | L04 report verified (PR 1734 head 48a569cf, base develop, scope 5 files, hosted checks green, revert check present); contract and verification reviewers dispatched; L01 fix round 2 dispatched (luna thread 01a1d3a0-4d3d); L03 Luna contract reviewer running (thread 01a1d3a0-7c44); L02 round 3 stopped: EPERM /bin/ps under workspace-write, Q18 asked; develop unchanged at 1cbdcc6f |
| 2026-11-12T22:38-08:00 | Q16 and Q17 acted on and closed |
| 2026-11-13T00:57-08:00 | L04 round 1: contract 0 findings; verification 2 findings (Moderate: six call sites untested + new Mac rawQuestion overload re-derives machine; Minor: no snapshot/kill-session test for same-id pair). Both decided fix. Maintainability reviewer dispatched. Note: last commit says Fixes #1732 (closes issue with the #1720/#1727 paragraph still open): notify owner before merge, reopen command after. |
| 2026-11-13T00:58-08:00 | L01 fix round pushed (5f8e57eb); hosted Native failed signal 11 (#1634 pattern), rerun once; RV-delta L01 dispatched. L03 Luna contract review: 1 Important security finding (child key pin checks announced key, no proof of possession before auth_response); advisor consult dispatched. Q18 broadened full access. |
| 2026-11-13T00:58-08:00 | L02 round 4 dispatched (luna, full access per Q18, thread 01a1d421) |
| 2026-11-13T00:59-08:00 | L04 maintainability: 3 findings (Moderate: 9 hand-written predicates; Minor x2 docs, test helper), all fix; fix round dispatched (luna, full access, thread 01a1d422-4895); the old 'Fixes #1732' commit cannot be rewritten (no force-push): owner notice at merge plus reopen command |
| 2026-11-13T01:00-08:00 | L01 delta review: 4 of 5 round-1 findings resolved; 1 Important introduced by the fix (standing-grant lock-screen bullet wrong). Fix r3 queued; Luna budget at its limit until the daily reset at next tick; last review round, no third |
| 2026-11-13T01:02-08:00 | L03 fix round dispatched (terra, full access, thread 01a1d424-f58c); owner action needed: file the follow-up issue from L03/r2/issue-body.md |
| 2026-11-13T01:06-08:00 | Filed #1735 (bind direct client auth signature to the server key) from the L03 advisor ruling; the L03 fix worker's PR body and test labels get the number after its run (manager edits the PR body once the worker finishes) |
| 2026-11-13T01:10-08:00 | Owner widened authority again: develop pushes, TestFlight uploads, deleting done branches and worktrees (manager and lead only); L13 cleanup commands can be run by the manager after its checks |
| 2026-11-13T01:24-08:00 | budget reset (daily): Agents today was 16 |
| 2026-11-13T01:24-08:00 | budget reset (daily): Codex Luna today was 8 |
| 2026-11-13T01:24-08:00 | budget reset (daily): Codex Terra today was 2 |
| 2026-11-13T01:24-08:00 | budget reset (daily): Claude Sonnet today was 5 |
| 2026-11-13T01:24-08:00 | budget reset (daily): Claude Opus today was 1 |
| 2026-11-13T01:25-08:00 | tick 4: L04 fix verified (head 4bfccf4c, 5 files in scope, 3 revert checks, closing ref #1732 known); RV-delta dispatched. L03 worker stopped on a contradictory revert requirement; advisor parenthetical resolves it (different-key case is the pin revert check); continuation dispatched with #1735. L01 fix r3 dispatched. L02 r4 failed the positive probe under local Bun 1.4.4 (client socket close; CI pins 1.3.11): manager pushed the local develop merge (051e9900) to PR 1657 so hosted CI is the evidence; budgets reset at tick |
| 2026-11-13T01:28-08:00 | L04 delta: no Critical/Important; 3 leftovers (Mac rawQuestion predicate copy, source pin too narrow, loop style): R1 and R2 fix, R3 rejected (uniqueness invariant, no cost); fix r3 dispatched (luna thread 01a1d43c-d76f) |
| 2026-11-13T01:52-08:00 | tick 5: L01 r3 pushed 750dc597, AGENTS.md standing-grant sentence verified against selectPushCategory (REMI_YNA only for [one-time Yes, addRules, No]; else standing gets none; detail gets none); native job failed signal 11 again, rerun requested. L04 r3 pushed bab01d67: scope 5 files, wide pin revert and Mac lookup revert recorded, contains develop, native CI pending. L03 Terra continuation still running (head 03735ab0 pushed). L02 CI relay soak pending. |
| 2026-11-13T05:46-08:00 | L04 merged (PR 1734 -> 2c06265f, bump 9382c0b0); #1732 reopened with comment; DV dispatched on 9382c0b0 (luna thread 01a1d466-7686). L03 continuation verified (diff 03735ab0 vs 5c1f9380: only DirectChildKeyIntegrationTests and direct-child-key-peer; PR body cites #1735; revert check = existing different-key case); develop merged into the branch (clean) and PR marked ready: hosted checks rerun. Q19 asked and answered (fresh-base relaxed). |
| 2026-11-13T05:55-08:00 | DV r1 on 9382c0b0: TypeScript gates pass; Swift failed only in PairingSourceTests (baseline family); Q20 answered: extend baseline; DV r2 dispatched with both suites skipped |
| 2026-11-13T05:56-08:00 | Owner approved downloading Bun 1.3.11 (bun-darwin-aarch64.zip 22342227 bytes from github.com/oven-sh/bun releases; sha256 6f5a3467ed9c...ffc matches SHASUMS256.txt) into /Volumes/S1/derived/bun-1.3.11; L02 r5 dispatched; L02 delta vs 26fbf947 is empty (own diff identical, 6 files) |
| 2026-11-13T05:58-08:00 | DV r2 on 9382c0b0 passed (942 tests, baseline suites skipped per Q20). L01 merged (PR 1733 -> 9ce4ea7f, bump 0c397251); DV r3 dispatched on 0c397251; L02 r5 (pinned Bun probe) running |
| 2026-11-13T06:04-08:00 | DV r3 on 0c397251 passed. L03 merged (PR 1728 -> f82f9978, bump 981123e1); closing-ref scan listed #1724 (intended: the PR is the #1724 fix; limits tracked in #1735); DV r4 dispatched |
| 2026-11-13T06:04-08:00 | L06 dispatched (terra, full access); L05 waits for a free Luna slot (L02 r5 and DV r4 running) |
| 2026-11-13T06:05-08:00 | cleanup (owner authority): removed worktrees agents-md-split, question-session-identity, direct-child-key and their local branches (remote branches were already auto-deleted on merge); deleted the three scratch/issue-1724-* evidence branches |
| 2026-11-13T06:11-08:00 | L05 and L14 dispatched as Claude Sonnet implementers (owner: do not wait for Luna): agents af3918dd (L05, #1707 merge with develop) and a402841c (L14, image-availability) |
| 2026-11-13T06:13-08:00 | Owner correction recorded: slots on both platforms maximized; reviews Sonnet, advisor Opus, lead = this session; Luna second reviewer dropped |
| 2026-11-13T06:14-08:00 | DV r4 on 981123e1 passed (952 tests, baseline suites skipped). #1724 closed with a comment pointing to #1735. L09 dispatched on a Claude Opus worker (agent a6a64c52): worktree bun142-pins created from the existing branch. |
