# Profiles epic (#1157): phases 1 to 4, 5A, Apps 1 to 4: log

<!--
Append-only history for the board beside this file.
Written by `manager_board.py log` and `decide`; never rewrite or delete a row.
The manager reads the newest rows through `status`, never the whole file.
-->

## Decisions

| Time | Decision | By | Reason |
|---|---|---|---|
| 2026-11-14T18:23-08:00 | CP0: J1a answered: yes, Parity, Slots and Codex sandbox defaults of plan section 6 | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J1b answered: option 1 | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J1b limits set by owner 2026-11-14 (go to 100 total): Agents today 100, Codex Luna 24, Codex Terra 16, Claude Sonnet 44, Claude Opus 16, Advisor consults 20 | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J2 answered: (b) the manager merges the yooz-docs profiles PR only after the REL-DOCS recheck, the owner's explicit release go on the board and the release being published; never another yooz-docs PR; owner's informed choice against the recommendation (public site publish) | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J3 answered: no release with phase 1 without P2A, and none before OG-P1 passes | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J4 answered: keep docs/tools/remi/guides/profiles.md and commands/profile.md | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J5 answered: yes, merge PR 1785 and mark ADR 0051 Accepted at or before CP1 | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J6 answered: yes, phase 2 may start while OG-P1 runs | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J7 answered: the manager (or a worker it dispatches) may make the stopped-remi latency measurement itself, on a test hub under a temporary REMI_HOME, never the real hub; a real account need keeps it an owner gate | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J8 answered: serial, phase 4 after phase 3 | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J9 answered: sidecar session-profiles.json, fail closed | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J10 answered: manager-run visual gate with the owner's announced consent per slice | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J11 answered: yes, only under the four conditions of plan section 7 | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J12 answered: yes, record only that the fields exist; keep owner values off the public board | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J13 answered: (a) refuse the three Claude settings flags and pass --claudeai explicitly | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J14 answered: (c) a [profiles] error disables profiles only | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J15 answered: (a) loader accepts an unknown safe-token expects, check returns unknown, launch refused | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J18 answered: (a) one loop at a time; the land-branches board stays paused | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J16 deferred to CP2 | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J17 deferred to CP1 | owner |  |
| 2026-11-14T18:23-08:00 | CP0: plan approved with the answers above | owner |  |

## Log

| Time | Event |
|---|---|
| 2026-11-14T18:24-08:00 | First tick: setup done (verify worktree profiles-develop-verify at 095ef7cc), DV-1 dispatched (agent a713ea0097c9bc9a8, Sonnet); no implementation card before DV green; stat metadata saved |
| 2026-11-14T18:24-08:00 | D51: owner approved the ADR (2026-11-14, J5 yes); docs reviewer RV-D51 dispatched on PR 1785 head abd584fe; merge gate after its report |
