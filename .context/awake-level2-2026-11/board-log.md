# Keep-awake level 2 (awake-level2-2026-11): log

<!--
Append-only history for the board beside this file.
Written by `manager_board.py log` and `decide`; never rewrite or delete a row.
The manager reads the newest rows through `status`, never the whole file.
-->

## Decisions

| Time | Decision | By | Reason |
|---|---|---|---|
| 2026-11-17T06:56-08:00 | Q1 answered: (b) armed by config (level2 = true: the hub turns level 2 on at the first real work and keeps it for level2_default_hours; after any revert it stays off until an explicit start). Differs from the recommendation (a) | owner |  |
| 2026-11-17T06:56-08:00 | Q2 answered: Yes, battery limits apply only on battery power | owner |  |
| 2026-11-17T06:56-08:00 | Q3 answered: Refuse level 2 on a Mac with no battery | owner |  |
| 2026-11-17T06:56-08:00 | Q4 answered: Keep stopping on an unknown [awake] key | owner |  |
| 2026-11-17T07:02-08:00 | Q5 answered: No total time limit for level 1 | owner |  |
| 2026-11-17T07:02-08:00 | Q6 answered: Yes, shared slots and budget; worker-hard on claude-opus, codex-terra left to the profiles lane | owner |  |
| 2026-11-17T07:02-08:00 | Q7 answered: ship level 2 marked experimental (off by default) before OG-L2 passes | owner |  |
| 2026-11-17T07:02-08:00 | Q8 answered: Yes, 35 percent start and 30 percent revert | owner |  |
| 2026-11-17T07:06-08:00 | Q9 answered: only remi keep-awake arm re-arms (matches the recommendation; the cards already follow it) | owner |  |
| 2026-11-17T07:06-08:00 | Q10 answered: no extra guard rail on automatic starts (matches the recommendation) | owner |  |
| 2026-11-17T07:06-08:00 | Q11 answered: log and status now, a phone push with L2-APP (matches the recommendation) | owner |  |

## Log

| Time | Event |
|---|---|
| 2026-11-17T06:57-08:00 | Dispatched G0 (Luna, bme6yrpaj), G1 (Luna, bnrnfrmj9), W1 (Opus agent ad62c17fc6af47519) on develop bbcec7d6; pre-dispatch power state: SleepDisabled No, no sudoers/launchd files, watchdog launchctl exit 113; L2-POL waits for the lead to correct cards for Q1 (b) |
| 2026-11-17T07:05-08:00 | Lead commit 6af41772 verified (11 cards pass, board OK): Q1 (b) armed applied to L2-POL, L2-CORE, L2-HUB, L2-CLI, L2-APP outline, plan section 6a (what armed mode changes and what bounds it), owner-gates OG-L2; new owner questions Q9 (re-arm), Q10 (extra guard rail), Q11 (notify) recorded |
