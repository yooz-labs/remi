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
| 2026-11-17T07:08-08:00 | Owner 2026-11-17 amends Q9: once level 2 is active or armed it stays on until a condition prevents it, and when the condition goes away it re-arms by itself (the one-period-per-arming latch of the cards is replaced by condition-driven pause and automatic resume); explicit stop or disarm by the person still ends it until arm | owner |  |
| 2026-11-17T08:43-08:00 | Q12 answered: (b) a new hub comes up armed only after a clean exit with no lease left, never after a crash (amends ADR 0050 item 5 in L2-HUB) | owner |  |
| 2026-11-17T08:43-08:00 | Q13 answered: Yes, automatic start and resume need the lid open for the whole dwell | owner |  |
| 2026-11-17T08:43-08:00 | Q14 answered: (a) 3 h longest run then pause, 12 h on-time per 24 h; owner rule 2026-11-17: EVERY limit is a setting the person can change, the plan only sets defaults (no hard-coded limit) | owner |  |
| 2026-11-17T08:51-08:00 | Q15 answered: (a) no hard limit at all (only sanity validation; everything else a warning) | owner |  |
| 2026-11-17T08:51-08:00 | Q16 answered: (b) settings too: mechanism and format bounds (subprocess deadlines, size caps, retry backoff, shutdown budget) are also settings with defaults; differs from the recommendation (a) | owner |  |
| 2026-11-17T08:51-08:00 | Owner 2026-11-17: merge gate item 3 extension: code merged on develop since a PR's checks ran counts as a fresh base when it touches no file the PR changes AND the PR's focused tests and typecheck pass on a local merge of develop into the PR head; any overlap still forces a branch update and a checks rerun | owner |  |
| 2026-11-17T09:00-08:00 | Q17 answered: Yes, the 5 s remi stop wait becomes [daemon] stop_timeout_seconds in L2-HUB | owner |  |

## Log

| Time | Event |
|---|---|
| 2026-11-17T06:57-08:00 | Dispatched G0 (Luna, bme6yrpaj), G1 (Luna, bnrnfrmj9), W1 (Opus agent ad62c17fc6af47519) on develop bbcec7d6; pre-dispatch power state: SleepDisabled No, no sudoers/launchd files, watchdog launchctl exit 113; L2-POL waits for the lead to correct cards for Q1 (b) |
| 2026-11-17T07:05-08:00 | Lead commit 6af41772 verified (11 cards pass, board OK): Q1 (b) armed applied to L2-POL, L2-CORE, L2-HUB, L2-CLI, L2-APP outline, plan section 6a (what armed mode changes and what bounds it), owner-gates OG-L2; new owner questions Q9 (re-arm), Q10 (extra guard rail), Q11 (notify) recorded |
| 2026-11-17T07:07-08:00 | G1-1 (Codex Luna) stopped without changes: inside the Codex sandbox 'notifyutil -g com.apple.system.thermalpressurelevel' fails with code 9 (outside the sandbox it prints level 0, checked by me), so the card's live thermal acceptance cannot pass there; power-state checks clean (SleepDisabled No, no sudoers or launchd files, watchdog exit 113); G1 redispatched on a Claude Sonnet slot (card says Claude slots when free), no sandbox escalation needed |
| 2026-11-17T07:08-08:00 | Owner amended Q9 (see decision); L2-POL held; lead woken to apply it and to frame any ADR 0050 conflicts as owner questions |
| 2026-11-17T07:11-08:00 | G0-1 reported PR 1804 (head c5385b09, one file .context/awake-password-on-wake.md, conclusion: not settled; level 2 refuses unless require_password_on_wake=false until the owner's OG-CAP step 5 shows which read-only source follows the setting); post-run power checks clean (SleepDisabled No, no sudoers or launchd files, watchdog exit 113), develop unchanged; docs reviewer dispatched |
| 2026-11-17T07:15-08:00 | G1-2 (Sonnet) reported PR 1806 (head 4d9b9cb8; 3 readers no caller; scope inside the card; deviations: tighter pmset guard, .gitattributes in the fixtures folder, readingSpawnCount export; revert check 1 used a fake pmset); post-run power checks clean by my own run (SleepDisabled No, three paths absent, watchdog exit 113, no remi/yooz launch files); contract and verification reviewers dispatched |
| 2026-11-17T07:15-08:00 | PR 1804 docs+privacy review: 1 Important (note vs OG-CAP step 5: needs an off state and separate stdout/stderr), 1 Moderate (name the constant argument vector, same verb with other args writes the setting), 2 Minor; all accepted; Sonnet fix agent on the note; lead asked to fix owner-gates OG-CAP step 5 BEFORE the owner runs it |
| 2026-11-17T07:17-08:00 | PR 1804 (G0 note) merged after the verified fix round (head 6762f991: all four findings, one file, checks green, scan []); conclusion stays 'not settled' until the owner's OG-CAP step 5; OG-CAP stream fix 8154c18f verified (separate .stdout/.stderr/.exit, lock-never state, read-only) |
| 2026-11-17T07:17-08:00 | PR 1806 round-1 reviews: contract (2 Moderate: guard pins only pmset; thermal nominal fails open on a dead key; 2 Minor), verification (1 Important: five fail-closed parser branches untested; 2 Moderate: the refusal test would run a real pmset sleepnow if the guard regressed; line-boundary truncation parses ok; 1 Minor); all accepted; fix round sent to the G1 worker (resumed) |
| 2026-11-17T08:51-08:00 | Lead 7b446697 verified (every keep-awake limit a setting, Q15 a, Q16 b answered by the owner: mechanism bounds also settings, differs from the recommendation); G1 (#1806) and W1 (#1807) merges HOLD until the lead says how their constants (deadlines, size caps, lease max bytes, backoff, shutdown budget) become settings; L2-POL held for the same reconcile |
| 2026-11-17T08:56-08:00 | W1 (Opus) reported PR 1807 (head ee4b9e6c, hosted CI green, 72 tests 0 fail 0 skip, 7 revert checks, ten deviations listed in the PR body); post-run power checks clean; four reviewers (contract, verification, privilege, failsafe) dispatched; merge also waits for the lead's Q16 reconcile of its mechanism constants |
| 2026-11-17T09:00-08:00 | Lead 5e6b4d37 verified (every mechanism bound a setting; fix-round change lists for G1 and W1 in plan Appendix B); G1 fix round 2 done (head 491ec135, 54 pass 0 fail, my rerun confirms, CI restarted incl. soak); L2-POL dispatched on Opus |
