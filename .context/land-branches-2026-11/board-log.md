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

## Log

| Time | Event |
|---|---|
