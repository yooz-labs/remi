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
