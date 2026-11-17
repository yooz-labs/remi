# Keep-awake level 2 (awake-level2-2026-11)

<!--
manager-loop board: state only, history goes to the -log file beside it, specs to the plan and cards.
Write through the helper (manager_board.py set, tick, ask, propose, spend) and run `check` after any hand edit.
The owner owns Parity, Slots, and Budget limits: the manager proposes changes there, never makes them.
These are the defaults; the owner's approval of the plan accepts them.
Step states: outline (not dispatchable), todo, active, review, blocked, owner (waits on the owner), done, dropped.
In Steps and Questions, the first column holds each row's identifier (ID); in Steps, PR holds the pull request (PR) number.
-->

## Now

| Key | Value |
|---|---|
| Plan | .context/awake-level2-2026-11/plan.md |
| Repo | yooz-labs/remi |
| Integration branch | develop |
| Manager id | mba-claude-sonnet |
| State | running |
| Cadence | 30m with workers running, 60m waiting on people |
| Last tick | 2026-11-17T06:57-08:00 |
| Next tick | 2026-11-17T07:27-08:00 |
| Stop when | every step done, or all remaining work waits on the owner |
| Created | 2026-11-17T06:54-08:00 |

## Parity

| Tier | Claude | Codex | Notes |
|---|---|---|---|
| worker | Sonnet (sonnet) high | gpt-6-luna max | copied from land-branches-2026-11; docs, web, P1C, A4, DV; Codex by default |
| worker-hard | Opus (opus) xhigh | gpt-6.1-terra xhigh | copied; daemon steps and native A1 to A3; Codex by default |
| lead | Opus (opus) xhigh | gpt-6.1-sol xhigh | copied; lead wakes, checkpoints, advisor; Sol only if a card says so (none does) |
| frontier | Fable (claude-fable-5-2) | gpt-6-astra xhigh | copied; only if the owner asks; this plan names no frontier use |
| reviewer | Sonnet (sonnet) xhigh | gpt-6-luna max | copied; Sonnet only (owner rule); reviewers are extra to the worker slots |

## Slots

| Slot | Platform | Tiers | Max | Can | Notes |
|---|---|---|---|---|---|
| codex-terra | Codex | worker-hard | 0 | macos, xcode, docs | implementers; sandbox per runbook 5 (full access for native cards and after a sandbox denial) |
| codex-luna | Codex | worker | 2 | macos, xcode, docs | implementers, DV; sandbox per runbook 5 |
| claude-sonnet | Claude | worker | 2 | macos, xcode, docs, simulator | implementers (owner 2026-11-13); reviewers run extra to this slot |
| claude-opus | Claude | lead, worker-hard | 1 | macos, xcode, docs, simulator | worker-hard implementer (owner 2026-11-13: 1 Opus worker); lead wakes and advisor run extra |
| claude-fable | Claude | frontier | 1 | | unused unless the owner asks |

## Budget

| Item | Limit | Used | Resets | Notes |
|---|---|---|---|---|
| Agents today | 100 | 22 | daily | owner CP0 value (J1b option 1, 2026-11-14); every agent dispatch incl. reviewers, lead, advisor; at the limit: stop and ask |
| Codex Luna today | 24 | 2 | daily | owner CP0 value; Luna implementers, fix rounds, DV |
| Codex Terra today | 16 | 0 | daily | owner CP0 value; Terra implementers and fix rounds |
| Claude Sonnet today | 44 | 15 | daily | owner CP0 value; Claude Sonnet implementers and every reviewer |
| Claude Opus today | 16 | 5 | daily | owner CP0 value; Opus implementers, lead wakes, advisor consults |
| Advisor consults | 20 | 0 | never | owner CP0 value; lead wakes and advisor consults, whole plan; never --over |
| Fable consults | 1 | 0 | never | copied; only if the owner asks; never --over |
| Agents this wave | 0 | 0 | wave | unused: this plan has no waves |

## Waves

| Wave | Goal | Agents | State | Exit gate |
|---|---|---|---|---|

## Steps

| ID | Title | Wave | Tier | Needs | Slot | State | Depends | PR | Started | Timebox | Next |
|---|---|---|---|---|---|---|---|---|---|---|---|
| G0 | [G0 password-on-wake](cards/G0-password-on-wake.md) | - | worker | - | codex-luna | done | - | 1804 | 2026-11-17T06:56 | 3h | dispatch now; note only |
| G1 | [G1 power readings](cards/G1-power-readings.md) | - | worker | - | claude-sonnet | review | - | 1806 | 2026-11-17T06:56 | 1d | PR 1806 head 491ec135: wait CI incl. soak, then gate item 7 (done by me: 54 pass 0 fail) and merge; killGraceMs test cannot fail when the option is ignored (documented limit, accepted) |
| W1 | [W1 lease and watchdog](cards/W1-lease-and-watchdog.md) | - | worker-hard | - | claude-opus | review | - | 1807 | 2026-11-17T06:56 | 1d | dispatch now; reviews add privilege and failsafe lenses |
| L2-POL | [L2-POL level 2 policy](cards/L2-POL-level2-policy.md) | - | worker-hard | - | claude-opus | review | - | - | 2026-11-17T09:10 | 1d | Fix round after the 3 reviews (lead ea2c770e: no timer limit on any key, safe-integer check, persist every beat), then delta review, gate item 8, merge |
| OG-CAP | [Owner gate: MacBook captures](owner-gates.md) | - | - | - | - | owner | - | - | - | 30m | rule: owner runs OG-CAP section of owner-gates.md; seven folders under artifacts/awake-level2-2026-11/captures/OG-CAP |
| G2 | [G2 level 1 battery floor](cards/G2-level1-battery-floor.md) | - | worker-hard | - | - | todo | G1,OG-CAP | - | - | 1d | after G1 merged and OG-CAP; keys per plan section 6 (Q15 a, Q16 b: mechanism bounds also settings: the lead reconciles) |
| OG-G2 | [Owner gate: battery floor on the MacBook](owner-gates.md) | - | - | - | - | blocked | G2 | - | - | 30m | rule: set owner when G2 is done; owner-gates.md OG-G2 |
| CP-L2 | [Checkpoint before level 2](plan.md) | - | - | - | - | blocked | G0,G1,W1,L2-POL,G2,OG-CAP | - | - | - | wake the lead when G0, G1, W1, L2-POL, G2 and OG-CAP are done (Q1-Q3, Q9, Q10, Q12-Q14 closed); CP-L2: decide line, anticipation pass, ask go |
| L2-CORE | [L2-CORE switch and controller](cards/L2-CORE-switch-and-controller.md) | - | worker-hard | - | - | todo | CP-L2 | - | - | 1.5d | after CP-L2 go |
| L2-HUB | [L2-HUB config and hub](cards/L2-HUB-config-and-hub.md) | - | worker-hard | - | - | todo | L2-CORE | - | - | 1.5d | after L2-CORE |
| L2-CLI | [L2-CLI keep-awake command](cards/L2-CLI-keep-awake-command.md) | - | worker-hard | - | - | todo | L2-HUB | - | - | 1d | after L2-HUB and only when gh pr view 1798 prints MERGED |
| OG-L2 | [Owner gate: setup and hardware tests (a)-(h)](owner-gates.md) | - | - | - | - | blocked | L2-CLI | - | - | 2h | rule: set owner when L2-CLI is done; owner-gates.md OG-L2 |
| CP-HW | [Checkpoint after hardware tests](plan.md) | - | - | - | - | blocked | OG-L2 | - | - | - | rule: wake the lead with the brief of plan section 4 |
| L2-SLEEPNOW | [L2-SLEEPNOW third rule](cards/L2-SLEEPNOW-third-rule.md) | - | worker-hard | - | - | outline | CP-HW | - | - | 6h | outline: completed at CP-HW, only if OG-L2 (b) failed |
| L2-APP | [L2-APP phone surface](cards/L2-APP-phone-surface.md) | - | worker-hard | - | - | outline | CP-HW | - | - | 2d | outline: completed at CP-HW |

## Questions

| ID | Step | Question | Options | Default | Needed by | State | Answer |
|---|---|---|---|---|---|---|---|
| Q1 | - | Q1: How does a level 2 period start? (a) only by an explicit start (remi keep-awake start now, the phone later); (b) armed by level2 = true at the first real work | (a) explicit start (Recommended) / (b) armed | none | 2026-11-18T12:00 | answered | (b) armed by config (owner, 2026-11-17T06:56-08:00) |
| Q2 | - | Q2: Do the battery limits (level 1 floor; level 2 start, revert and time limits) apply only on battery power, with AC power exempt? | Yes (Recommended) / No, also on AC | none | 2026-11-18T12:00 | answered | Yes (owner, 2026-11-17T06:56-08:00) |
| Q3 | - | Q3: Level 2 on a Mac with no battery (a desktop): refuse it or allow it? | Refuse (Recommended) / Allow | none | 2026-11-18T12:00 | answered | Refuse (owner, 2026-11-17T06:56-08:00) |
| Q4 | - | Q4: An unknown [awake] key: keep stopping every remi command at config load, or warn and ignore ADR 0050 keys this build lacks? | Keep stopping (Recommended) / Warn and ignore | none | 2026-11-18T12:00 | answered | Keep stopping (owner, 2026-11-17T06:56-08:00) |
| Q5 | - | Q5: Add a total time limit to level 1? ADR 0050 gives it only the question cap and the stuck bound. | No (Recommended) / Yes | none | 2026-11-18T12:00 | answered | No (owner, 2026-11-17T07:02-08:00) |
| Q6 | - | Q6: Run this plan beside the profiles plan on shared slots and budget, worker-hard steps on claude-opus, codex-terra left to the profiles lane? | Yes (Recommended) / Other | none | 2026-11-18T12:00 | answered | Yes (owner, 2026-11-17T07:02-08:00) |
| Q7 | - | Q7: May a release contain level 2 (off by default, marked experimental) before the MacBook gate OG-L2 passes, or hold such releases? | (a) ship marked experimental (Recommended) / (b) hold releases / (c) gate an unmerged branch | none | 2026-11-18T12:00 | answered | (a) ship experimental (owner, 2026-11-17T07:02-08:00) |
| Q8 | - | Q8: Confirm ADR 0050's level 2 battery defaults: refuse to start below 35 percent, revert at 30 percent (both configurable)? | Yes (Recommended) / Other values | none | 2026-11-18T12:00 | answered | Yes (owner, 2026-11-17T07:02-08:00) |
| Q9 | - | Q9: After a level 2 period ends, what re-arms the automatic start? (a) only remi keep-awake arm; (b) also a clean hub restart; (c) natural ends re-arm, only safety reverts latch | (a) only arm (Recommended) / (b) arm or clean restart / (c) natural ends re-arm | none | 2026-11-18T12:00 | answered | (a) only arm (owner, 2026-11-17T07:06-08:00) |
| Q10 | - | Q10: Extra condition for automatic starts? (a) none; (b) a phone or web client connected to the hub in the last 30 minutes; (c) only on AC power | (a) none, if Q9 is (a) (Recommended) / (b) recent remote client / (c) AC only | none | 2026-11-18T12:00 | answered | (a) none (owner, 2026-11-17T07:06-08:00) |
| Q11 | - | Q11: Tell the person when an automatic period starts and ends? (a) hub log and status now, a phone push with L2-APP; (b) log and status only | (a) log, status, then push (Recommended) / (b) log and status only | none | 2026-11-18T12:00 | answered | (a) (owner, 2026-11-17T07:06-08:00) |
| Q12 | - | Q12: When does a new hub come up armed? (a) never, arm after every restart; (b) only after a clean exit with no lease left, never after a crash; (c) always | (a) never / (b) only after a clean exit (Recommended) / (c) always | none | 2026-11-18T12:00 | answered | (b) clean exit only (owner, 2026-11-17T08:43-08:00) |
| Q13 | - | Q13: Should automatic start and resume need the lid open for the whole dwell (a running level 2 stays on when the lid closes; explicit start unaffected)? | Yes (Recommended) / No | none | 2026-11-18T12:00 | answered | Yes (owner, 2026-11-17T08:43-08:00) |
| Q14 | - | Q14: Period limits under pause and resume: (a) 3 h longest run then pause, 12 h on-time per 24 h; (b) only the 12 h per 24 h cap; (c) either limit disarms | (a) run limit and daily cap (Recommended) / (b) daily cap only / (c) limits disarm | none | 2026-11-18T12:00 | answered | (a) with every limit a setting (owner, 2026-11-17T08:43-08:00) |
| Q15 | - | Q15: Every former maximum and the 5-point gap are now warnings. Keep any hard limit? (a) none; (b) refuse revert battery below 10 percent; (c) refuse a heartbeat above 300 s | (a) none (Recommended) / (b) refuse revert below 10 / (c) refuse heartbeat above 300 s | none | 2026-11-18T12:00 | answered | (a) none (owner, 2026-11-17T08:51-08:00) |
| Q16 | - | Q16: Keep mechanism bounds (subprocess deadlines, size caps, retry backoff, shutdown budget) as named constants rather than settings? (a) named constants; (b) settings too | (a) named constants (Recommended) / (b) settings too | none | 2026-11-18T12:00 | answered | (b) settings too (owner, 2026-11-17T08:51-08:00) |

## Proposals

| ID | Time | Proposal | Why | State |
|---|---|---|---|---|

## Agents

| Agent | Role | Slot | Model | Step | Started | State |
|---|---|---|---|---|---|---|
| G0-1 | implementer | codex-luna | gpt-6-luna max | G0 | 2026-11-17T06:56 | done |
| G1-1 | implementer | codex-luna | gpt-6-luna max | G1 | 2026-11-17T06:56 | stopped-incomplete |
| W1-1 | implementer | claude-opus | opus (ad62c17fc6af47519) | W1 | 2026-11-17T06:56 | done |
| G1-2 | implementer (redispatch on a Claude slot) | claude-sonnet | sonnet high | G1 | 2026-11-17T07:08 | done |
| RV-G0 | reviewer docs | claude-sonnet | sonnet xhigh | G0 PR1804 | 2026-11-17T07:12 | done |
| RV-G1-contract | reviewer contract | claude-sonnet | sonnet xhigh | G1 PR1806 | 2026-11-17T07:20 | done |
| RV-G1-verification | reviewer verification | claude-sonnet | sonnet xhigh | G1 PR1806 | 2026-11-17T07:20 | done |
| FX-G0 | fix round 1 (PR1804) | claude-sonnet | sonnet high (ad42c5d0050dee321) | G0 PR1804 | 2026-11-17T07:25 | done |
| FX-G1 | fix round 1 (PR1806) | claude-sonnet | sonnet high (a85bfd9e9ecd1e4d6, resumed) | G1 PR1806 | 2026-11-17T07:35 | running |
| RV-W1-contract | reviewer contract | claude-sonnet | sonnet xhigh | W1 PR1807 | 2026-11-17T08:58 | done |
| RV-W1-verification | reviewer verification | claude-sonnet | sonnet xhigh | W1 PR1807 | 2026-11-17T08:58 | done |
| RV-W1-privilege | reviewer privilege | claude-sonnet | sonnet xhigh | W1 PR1807 | 2026-11-17T08:58 | done |
| RV-W1-failsafe | reviewer failsafe | claude-sonnet | sonnet xhigh | W1 PR1807 | 2026-11-17T08:58 | done |
| L2-POL-1 | implementer | claude-opus | opus (a37ea6ad9be74c593) | L2-POL | 2026-11-17T09:10 | done |
| FX-W1 | fix round 1 (PR1807) | claude-opus | opus (ad62c17fc6af47519, resumed) | W1 PR1807 | 2026-11-17T09:20 | done |
| RV-POL-contract abb5a638150408212 | reviewer (contract abb5a638150408212) | claude-sonnet | sonnet () | L2-POL PR1809 | 2026-11-17T09:52 | done |
| RV-POL-verification adb8086a849545b27 | reviewer (verification adb8086a849545b27) | claude-sonnet | sonnet () | L2-POL PR1809 | 2026-11-17T09:52 | done |
| RV-POL-failsafe a8c447f6023c80181 | reviewer (failsafe a8c447f6023c80181) | claude-sonnet | sonnet () | L2-POL PR1809 | 2026-11-17T09:52 | done |
| FX-POL | fix round 1 (PR1809) | claude-opus | opus (a37ea6ad9be74c593, resumed) | L2-POL PR1809 | 2026-11-17T10:25 | running |
| RV-W1D-watchdog ad9df8c35ac4b5fa0 | delta reviewer (watchdog ad9df8c35ac4b5fa0) | claude-sonnet | sonnet () | W1 PR1807 | 2026-11-17T10:08 | done |
| RV-W1D-setup a35f311fdea97f017 | delta reviewer (setup a35f311fdea97f017) | claude-sonnet | sonnet () | W1 PR1807 | 2026-11-17T10:08 | done |
| FX-W1B | final fix (PR1807 delta) | claude-opus | opus (ad62c17fc6af47519, resumed) | W1 PR1807 | 2026-11-17T10:25 | done |
