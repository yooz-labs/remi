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

## Log

| Time | Event |
|---|---|
| 2026-11-12T19:58-08:00 | Owner answered Q1, Q4, Q5, Q6, Q8, Q9, Q10 and approved the defaults; Q2, Q3, Q7 stay open |
| 2026-11-12T20:13-08:00 | Pack review (executability, design) applied: CP1 and L14 added, L07 L08 L09 A01 dependencies changed, Q11 to Q14 asked |
