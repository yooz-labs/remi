# Profiles epic (#1157): phases 1 to 4, 5A, Apps 1 to 4

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
| Plan | .context/profiles-epic-2026-11/plan.md |
| Repo | yooz-labs/remi |
| Integration branch | develop |
| Manager id | mba-claude-sonnet |
| State | running |
| Cadence | 30m with workers running, 60m waiting on people |
| Last tick | 2026-11-17T04:14-08:00 |
| Next tick | 2026-11-17T04:44-08:00 |
| Stop when | every step done, or all remaining work waits on the owner |
| Created | 2026-11-14T17:30-08:00 |
| Pack branch | chore/profiles-epic-plan |

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
| codex-terra | Codex | worker-hard | 1 | macos, xcode, docs | implementers; sandbox per runbook 5 (full access for native cards and after a sandbox denial) |
| codex-luna | Codex | worker | 2 | macos, xcode, docs | implementers, DV; sandbox per runbook 5 |
| claude-sonnet | Claude | worker | 2 | macos, xcode, docs, simulator | implementers (owner 2026-11-13); reviewers run extra to this slot |
| claude-opus | Claude | lead, worker-hard | 1 | macos, xcode, docs, simulator | worker-hard implementer (owner 2026-11-13: 1 Opus worker); lead wakes and advisor run extra |
| claude-fable | Claude | frontier | 1 | | unused unless the owner asks |

## Budget

| Item | Limit | Used | Resets | Notes |
|---|---|---|---|---|
| Agents today | 100 | 44 | daily | owner CP0 value (J1b option 1, 2026-11-14); every agent dispatch incl. reviewers, lead, advisor; at the limit: stop and ask |
| Codex Luna today | 24 | 3 | daily | owner CP0 value; Luna implementers, fix rounds, DV |
| Codex Terra today | 16 | 10 | daily | owner CP0 value; Terra implementers and fix rounds |
| Claude Sonnet today | 44 | 16 | daily | owner CP0 value; Claude Sonnet implementers and every reviewer |
| Claude Opus today | 16 | 14 | daily | owner CP0 value; Opus implementers, lead wakes, advisor consults |
| Advisor consults | 20 | 19 | never | owner CP0 value; lead wakes and advisor consults, whole plan; never --over |
| Fable consults | 1 | 1 | never | copied; only if the owner asks; never --over |
| Agents this wave | 0 | 0 | wave | unused: this plan has no waves |

## Waves

| Wave | Goal | Agents | State | Exit gate |
|---|---|---|---|---|

## Steps

| ID | Title | Wave | Tier | Needs | Slot | State | Depends | PR | Started | Timebox | Next |
|---|---|---|---|---|---|---|---|---|---|---|---|
| CP0 | [Plan approval: defaults, merge authority, J1a to J15 and J18](plan.md) | - | - | - | - | done | - | - | - | - | rule: owner approves; J1a-J15, J18 answered, J16/J17 recorded deferred; CP0: lines recorded, then done (runbook 2); no dispatch before |
| P1A | [Profile model and commands #1748](cards/P1A-profile-model-and-commands.md) | - | worker-hard | - | - | done | CP0 | - | 2026-11-17T04:14-08:00 | 1.5d | dispatch after CP0 (owner approves the plan); Codex Terra |
| P1C | [Codex credential characterization #1748](cards/P1C-codex-credential-characterization.md) | - | worker | - | - | done | CP0 | - | 2026-11-17T04:14-08:00 | 4h | dispatch after CP0; beside P1A; docs lens review |
| P1B | [Launches follow the profile #1748](cards/P1B-launches-follow-profile.md) | - | worker-hard | - | codex-terra | active | P1A, P1C | - | 2026-11-17T08:55 | 2d | after P1A and P1C merge; card follows J9 and J11 answers |
| DOCS-P1 | [Profile guide, phase 1 (yooz-docs)](cards/DOCS-P1-profile-guide.md) | - | worker | docs | - | todo | P1B | - | - | 6h | after P1B's bump and green DV; done = draft docs PR verified and reviewed, not merged; merges only at REL-DOCS |
| OG-P1 | [Owner gate: two profiles, 24 h](owner-gates.md) | - | - | - | - | blocked | P1B | - | - | - | rule: set owner when P1B is done; notify owner-gates.md OG-P1 |
| CP1 | [Checkpoint after phase 1](checkpoints.md) | - | - | - | - | blocked | P1B, DOCS-P1 | - | - | - | rule: wake lead (complete P2A-P2D, DOCS-P2); ask go and J17 in one batch; owner go |
| D51 | Merge PR 1785 (ADR 0051) after owner approval | - | - | - | - | done | - | - | - | - | rule: owner approves PR 1785 (J5); then docs merge gate and merge |
| P5A-PREP | [Capture prep for #1752](cards/P5A-PREP-capture-config.md) | - | worker | - | - | done | CP0 | - | 2026-11-17T04:14-08:00 | 4h | complete card; dispatch after CP0 beside P1A and P1C; docs lens review |
| P2A | [Profile paths #1749 (outline)](cards/P2A-profile-paths.md) | - | worker-hard | - | - | outline | CP1 | - | - | 1.5d | lead completes at CP1 |
| P2B | [session_profiles #1749 (outline)](cards/P2B-session-profiles-protocol.md) | - | worker-hard | - | - | outline | P2A, D51 | - | - | 2d | lead completes at CP1 |
| P2C | [profile_status #1749 (outline)](cards/P2C-profile-status-protocol.md) | - | worker-hard | - | - | outline | P2B | - | - | 2d | lead completes at CP1 |
| P2D | [Web profiles #1749 (outline)](cards/P2D-web-profiles.md) | - | worker | - | - | outline | P2C | - | - | 1.5d | lead completes at CP1 |
| DOCS-P2 | [Profile guide, phase 2 (outline)](cards/DOCS-P2-P4-profile-guide-updates.md) | - | worker | docs | - | outline | P2D | - | - | 6h | lead completes at CP1 |
| OG-P2 | [Owner gate: phone-started session](owner-gates.md) | - | - | - | - | blocked | P2D | - | - | - | rule: set owner when P2D is done; notify OG-P2 |
| CP2 | [Checkpoint after phase 2](checkpoints.md) | - | - | - | - | blocked | P2D, DOCS-P2 | - | - | - | rule: wake lead (complete P3A-P3C, DOCS-P3); ask go and J16 in one batch; owner go |
| CPA1 | [Owner go for Apps 1](checkpoints.md) | - | - | - | - | blocked | CP2 | - | - | - | rule: wake lead (complete A1, visual plan J10); owner go |
| A1 | [Apps 1 #1788 (outline)](cards/A1-apps-badge-picker-filter.md) | - | worker-hard | xcode | - | outline | CPA1 | - | - | 2d | lead completes at CPA1 |
| P3A | [Usage observations #1750 (outline)](cards/P3A-usage-observations.md) | - | worker-hard | - | - | outline | CP2 | - | - | 2d | lead completes at CP2 |
| P3B | [profile_usage and usage_warning #1750 (outline)](cards/P3B-profile-usage-protocol.md) | - | worker-hard | - | - | outline | P3A | - | - | 2d | lead completes at CP2 |
| P3C | [Web usage #1750 (outline)](cards/P3C-web-usage.md) | - | worker | - | - | outline | P3B | - | - | 1d | lead completes at CP2 |
| DOCS-P3 | [Profile guide, phase 3 (outline)](cards/DOCS-P2-P4-profile-guide-updates.md) | - | worker | docs | - | outline | P3C | - | - | 4h | lead completes at CP2 |
| OG-P3 | [Owner gate: usage vs CLIs](owner-gates.md) | - | - | - | - | blocked | P3C | - | - | - | rule: set owner when P3C is done; notify OG-P3 |
| CP3 | [Checkpoint after phase 3](checkpoints.md) | - | - | - | - | blocked | P3C, DOCS-P3 | - | - | - | rule: wake lead (complete P4A, P4B, DOCS-P4); owner go |
| CPA2 | [Owner go for Apps 2](checkpoints.md) | - | - | - | - | blocked | A1 | - | - | - | rule: wake lead (complete A2); owner go |
| A2 | [Apps 2 #1789 (outline)](cards/A2-apps-profile-manager.md) | - | worker-hard | xcode | - | outline | CPA2 | - | - | 2d | lead completes at CPA2 |
| CPA3 | [Owner go for Apps 3](checkpoints.md) | - | - | - | - | blocked | CP3, A2 | - | - | - | rule: wake lead (complete A3); owner go |
| A3 | [Apps 3 #1790 (outline)](cards/A3-apps-usage.md) | - | worker-hard | xcode | - | outline | CPA3 | - | - | 2d | lead completes at CPA3; OG-A3 after merge |
| P4A | [Compaction #1751 (outline)](cards/P4A-compaction.md) | - | worker-hard | - | - | outline | CP3 | - | - | 1.5d | lead completes at CP3; merge waits for OG-P4 latency (J7) |
| P4B | [Handoff brief #1751 (outline)](cards/P4B-handoff-brief.md) | - | worker-hard | - | - | outline | P4A | - | - | 1d | lead completes at CP3 |
| DOCS-P4 | [Profile guide, phase 4 (outline)](cards/DOCS-P2-P4-profile-guide-updates.md) | - | worker | docs | - | outline | P4B | - | - | 4h | lead completes at CP3 |
| OG-P4 | [Owner gate: compaction and latency](owner-gates.md) | - | - | - | - | blocked | P4A | - | - | - | rule: latency before P4A merges; real compaction after; notify OG-P4 |
| CP4 | [Checkpoint after phase 4](checkpoints.md) | - | - | - | - | blocked | P4B, DOCS-P4 | - | - | - | rule: wake lead (one-page note); owner review |
| CPA4 | [Owner go for Apps 4](checkpoints.md) | - | - | - | - | blocked | CP4, A3 | - | - | - | rule: wake lead (complete A4); owner go |
| A4 | [Apps 4 #1791 (outline)](cards/A4-apps-compact-brief.md) | - | worker | xcode | - | outline | CPA4 | - | - | 1.5d | lead completes at CPA4 |
| OG-5A | [Owner-run characterization #1752](owner-gates.md) | - | - | - | - | blocked | P5A-PREP | - | - | - | rule: owner captures when a real limit is hit; notify OG-5A once P5A-PREP is done |
| CP5 | [Checkpoint before phase 5](checkpoints.md) | - | - | - | - | blocked | OG-5A | - | - | - | rule: owner go or no-go for phase 5; a go starts a new plan |
| P5 | Phase 5 confirmed continuation (not filed) | - | - | - | - | blocked | CP5 | - | - | - | parked: unfiled until #1752 passes and the owner says go |
| P5B | Phase 5B resume characterization (not filed) | - | - | - | - | blocked | CP5 | - | - | - | parked: unfiled until phase 5 is approved |
| P6 | Phase 6 opt-in automatic continuation | - | - | - | - | blocked | P5 | - | - | - | parked: not approved to start (ADR 0049 D9) |
| A5 | Apps 5 confirmed continuation (not filed) | - | - | - | - | blocked | P5 | - | - | - | parked: follows phase 5 |
| REL-DOCS | [Release docs recheck and merge](cards/REL-DOCS-release-recheck.md) | - | worker | docs | - | blocked | - | - | - | 2h | rule: dispatch when the owner says a release shipping a profile phase is published |

## Questions

| ID | Step | Question | Options | Default | Needed by | State | Answer |
|---|---|---|---|---|---|---|---|
| J20 | - | May a profile env carry cloud identity pointers (AWS_PROFILE, GOOGLE_APPLICATION_CREDENTIALS...)? Detail in plan section 7 J20; P1B proceeds under a. | a scrub and refuse (Recommended) / b allow pointers in profile env / c stop scrubbing | none | 2026-11-19T12:00 | open |  |

## Proposals

| ID | Time | Proposal | Why | State |
|---|---|---|---|---|

## Agents

| Agent | Role | Slot | Model | Step | Started | State |
|---|---|---|---|---|---|---|
| DV-1 | DV | claude-sonnet | sonnet high | DV@095ef7cc | 2026-11-14T18:31 | done |
| RV-D51 | reviewer docs | claude-sonnet | sonnet xhigh | D51 PR1785 abd584fe | 2026-11-14T18:35 | done |
| FX-D51 | fix round 1 | claude-sonnet | sonnet high | D51 PR1785 | 2026-11-14T18:42 | done |
| P1A-1 | implementer | codex-terra | gpt-6.1-terra xhigh | P1A | 2026-11-17T04:14 | stopped-incomplete |
| P1C-1 | implementer | codex-luna | gpt-6-luna max | P1C | 2026-11-17T04:14 | stopped-incomplete |
| P5A-1 | implementer | codex-luna | gpt-6-luna max | P5A-PREP | 2026-11-17T04:14 | done |
| CI-1 | CI analysis (owner request, issue 1793) | claude-opus | opus high (agent a8e5c55d269096de4) | none | 2026-11-17T04:20 | done |
| PAIRV2-1 | implementer (owner request, issue 1794) | claude-sonnet | sonnet high | none | 2026-11-17T04:25 | running |
| P1A-2 | implementer (continuation) | codex-terra | gpt-6.1-terra xhigh | P1A | 2026-11-17T04:42 | stopped-incomplete |
| RV-PAIR-A | reviewer contract+verification | claude-sonnet | sonnet xhigh (a92b6314a46035836) | PR1795 | 2026-11-17T04:43 | done |
| RV-PAIR-B | reviewer maintainability+docs | claude-sonnet | sonnet xhigh (ace81289b673465b5) | PR1795 | 2026-11-17T04:43 | done |
| FX-PAIR | fix round 1 (PR1795) | claude-sonnet | sonnet high (a806c7b34bb738fb7) | PR1795 | 2026-11-17T04:55 | running |
| P1C-2 | implementer (continuation) | codex-luna | gpt-6-luna max | P1C | 2026-11-17T05:00 | done |
| RV-P5A | reviewer docs | claude-sonnet | sonnet xhigh | P5A-PREP PR1796 | 2026-11-17T05:05 | done |
| P1A-3 | implementer (continuation 2) | codex-terra | gpt-6.1-terra xhigh | P1A | 2026-11-17T05:10 | done |
| FX-P5A | fix round 1 (PR1796) | codex-luna | gpt-6-luna max | P5A-PREP | 2026-11-17T05:20 | done |
| RV-P1A-contract | reviewer contract | claude-sonnet | sonnet xhigh (ab8f6e1d337dd7f7c) | P1A PR1798 | 2026-11-17T05:30 | done |
| RV-P1A-verification | reviewer verification | claude-sonnet | sonnet xhigh (a537eabc772199af5) | P1A PR1798 | 2026-11-17T05:30 | done |
| RV-P1A-maintainability | reviewer maintainability | claude-sonnet | sonnet xhigh (ad4607de846f691b1) | P1A PR1798 | 2026-11-17T05:30 | done |
| RV-P1A-privacy | reviewer privacy | claude-sonnet | sonnet xhigh (ae0962c4de508f2c9) | P1A PR1798 | 2026-11-17T05:30 | done |
| P1A-4 | fix round 1 (PR1798) | codex-terra | gpt-6.1-terra xhigh | P1A | 2026-11-17T05:50 | running |
| RV-P1C | reviewer docs | claude-sonnet | sonnet xhigh | P1C PR1800 | 2026-11-17T05:05 | done |
| FX-P1C | fix round 1 (PR1800) | codex-luna | gpt-6-luna max | P1C | 2026-11-17T05:15 | done |
| MB-A | research A Remi inventory (issue 1801) | claude-sonnet | sonnet (ab2308c26d8716d42) | none | 2026-11-17T05:20 | running |
| MB-B | research B harness mechanisms (issue 1801) | claude-sonnet | sonnet (a31ddf35a2971942c) | none | 2026-11-17T05:20 | running |
| MB-C | research C prior art+security (issue 1801) | claude-sonnet | sonnet (acfd6b47e0d6c051c) | none | 2026-11-17T05:20 | running |
| MB-PLAN | Fable planner (owner asked, issue 1801) | claude-fable | fable | none | 2026-11-17T05:45 | done |
| LEAD-AWAKE2 | lead: awake level 2 cards (owner go 2026-11-17) | claude-opus | opus xhigh | none | 2026-11-17T06:00 | running |
| DV-2 | DV on develop 884dcf80 (merged PRs 1795 and 1798) | claude-sonnet | sonnet high | DV@884dcf80 | 2026-11-17T08:47 | done |
| P1B-1 | implementer | codex-terra | gpt-6.1-terra xhigh | P1B | 2026-11-17T08:55 | stopped-incomplete |
| P1B-2 | implementer (continuation) | codex-terra | gpt-6.1-terra xhigh | P1B | 2026-11-17T09:05 | stopped-incomplete |
| P1B-3 | implementer (continuation 2) | codex-terra | gpt-6.1-terra xhigh | P1B | 2026-11-17T09:25 | stopped-incomplete |
| P1B-4 | implementer (continuation 3) | codex-terra | gpt-6.1-terra xhigh | P1B | 2026-11-17T09:20 | stopped-incomplete |
| P1B-5 | implementer (continuation 4) | codex-terra | gpt-6.1-terra xhigh | P1B | 2026-11-17T09:30 | stopped-incomplete |
| P1B-6 | implementer (continuation 5) | codex-terra | gpt-6.1-terra xhigh | P1B | 2026-11-17T09:50 | stopped-incomplete |
| P1B-7 | implementer (continuation 6) | codex-terra | gpt-6.1-terra xhigh | P1B | 2026-11-17T10:05 | running |
