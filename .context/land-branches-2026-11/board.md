# Land pushed branches into develop

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
| Plan | .context/land-branches-2026-11/plan.md |
| Repo | yooz-labs/remi |
| Integration branch | develop |
| Manager id | - |
| State | paused |
| Cadence | 30m with workers running, 60m waiting on people |
| Last tick | - |
| Next tick | - |
| Stop when | every step done, or all remaining work waits on the owner |
| Created | 2026-11-12T19:05-08:00 |

## Parity

| Tier | Claude | Codex | Notes |
|---|---|---|---|
| worker | Sonnet (sonnet) high | gpt-6-luna max | merges, gates, focused fixes; Codex by default |
| worker-hard | Opus (opus) xhigh | gpt-6.1-terra xhigh | security, concurrency, conflict resolution; Codex by default |
| lead | Opus (opus) xhigh | gpt-6.1-sol xhigh | lead wakes, design steps, advisor; Sol only if a card says so |
| frontier | Fable (claude-fable-5-2) | gpt-6-astra xhigh | owner-requested for A02 only; never a default; Astra unused |
| reviewer | Sonnet (sonnet) xhigh | gpt-6-luna max | Sonnet by default (owner rule); Luna only as Q9's optional second reviewer |

## Slots

| Slot | Platform | Tiers | Max | Can | Notes |
|---|---|---|---|---|---|
| codex-terra | Codex | worker-hard | 1 | macos, xcode | implementers; native gates under the Xcode lock; sandbox per Q10 |
| codex-luna | Codex | worker | 2 | macos, xcode | implementers; native gates under the Xcode lock; sandbox per Q10 |
| claude-opus | Claude | lead | 1 | macos, xcode, simulator | P01, A01, A03; shares the one Opus session with lead wakes and advisor consults |
| claude-fable | Claude | frontier | 1 | | A02 only (owner-requested) |
| claude-sonnet | Claude | reviewer | 2 | | reviewers and synthesis only; never a step; count running reviewer agents (runbook 8) |

## Budget

| Item | Limit | Used | Resets | Notes |
|---|---|---|---|---|
| Agents today | 30 | 0 | daily | every dispatch on every platform; the plan approval covers this limit |
| Codex Luna today | 8 | 0 | daily | worker dispatches (gpt-6-luna); at the limit stop and ask, never fall back to Claude |
| Codex Terra today | 4 | 0 | daily | worker-hard dispatches (gpt-6.1-terra); at the limit stop and ask |
| Claude Sonnet today | 16 | 0 | daily | reviewers and synthesis (and a Luna second reviewer counts as Codex Luna) |
| Claude Opus today | 4 | 0 | daily | lead wakes, lead-tier steps, advisor consults |
| Advisor consults | 8 | 0 | never | lead tier (Opus), whole plan |
| Fable consults | 1 | 0 | never | A02 only, owner-requested |
| Agents this wave | 0 | 0 | wave | unused: this plan has no waves |

## Waves

| Wave | Goal | Agents | State | Exit gate |
|---|---|---|---|---|

## Steps

| ID | Title | Wave | Tier | Needs | Slot | State | Depends | PR | Started | Timebox | Next |
|---|---|---|---|---|---|---|---|---|---|---|---|
| L01 | [AGENTS.md split #1733](cards/L01-agents-md-split.md) | - | worker | - | - | todo | - | 1733 | - | 4h | verbatim-move check, then 1 docs reviewer (RV-panel, docs) |
| L03 | [Direct child key #1728](cards/L03-direct-child-key.md) | - | worker-hard | xcode | - | owner | - | 1728 | - | 2d | waits on Q2 only (Q10 answered: full access in a clean worktree); then 3 Sonnet reviewers plus 1 Luna |
| L02 | [Terminal relay probe #1657](cards/L02-terminal-relay-qualification.md) | - | worker | - | - | todo | - | 1657 | - | 1d | merge develop, start checks, then 2 reviewers |
| L04 | [Question session identity #1732](cards/L04-question-session-identity.md) | - | worker | xcode | - | owner | - | - | - | 1d | waits on Q2 only (Q10 answered); then implement per #1732 |
| L05 | [Notification preferences #1707](cards/L05-notification-preferences.md) | - | worker | xcode | - | todo | L03 | 1707 | - | 1d | merge develop; advisor checks the resolution; no third review |
| L06 | [Relay idle recovery #1731](cards/L06-idle-recovery.md) | - | worker-hard | xcode | - | owner | L03 | - | - | 2d | waits on Q3; reviews: 3 Sonnet plus 1 Luna (Q9) |
| L07 | [Local notification order #1720](cards/L07-local-notification-order.md) | - | worker | xcode | - | todo | L03, L04, L05 | - | - | 3d | one PR; chunked review L07-R1 to R4, then L07-S |
| L08 | [Native images #1313](cards/L08-native-images.md) | - | worker-hard | xcode | - | todo | L03, L06 | - | - | 3d | one PR; chunked review L08-R1 to R4 (R4 adds 1 Luna, Q9), then L08-S; risk R3 |
| L09 | [Bun 1.4.2 pins #1512](cards/L09-bun142-pins.md) | - | worker-hard | - | - | todo | L01, L07, L08 | 1512 | - | 2d | Q1 keep: after its gates pass it goes owner for the phone check; never merged before |
| L12 | [WSS writer tests #1641](cards/L12-native-wss-characterization.md) | - | worker | xcode | - | dropped | - | - | - | 4h | Q6 fold into the first #1641 implementation PR; branch kept |
| L11 | [Compact preview probes #1711](cards/L11-compact-preview.md) | - | worker | - | - | dropped | - | - | - | 4h | Q5 park: branch kept, no PR; not in the L13 delete list |
| L10 | [#1727 local files check](cards/L10-store-callback-owner-check.md) | - | - | - | - | owner | - | - | - | - | owner step; waits on Q7; no agent |
| L99 | Landing complete (CP2) | - | - | - | - | blocked | - | - | - | - | manager sets done when L01 to L12 are each done or dropped (runbook 8) |
| L13 | [Cleanup commands](cards/L13-cleanup-commands.md) | - | worker | - | - | todo | L99 | - | - | 2h | then the owner runs cleanup.md |
| P01 | [iPad Board design](cards/P01-ipad-board-design.md) | - | lead | xcode, simulator | - | blocked | L99 | - | - | 1d | todo when L99 done; iPad issue filed first; Xcode MCP precondition; CP3 |
| P02 | iPad Board implementation (outline) | - | worker-hard | xcode, simulator | - | outline | P01 | - | - | - | lead writes the card at CP3 after the owner approves P01 |
| A01 | [Account switching design](cards/A01-account-switching-design.md) | - | lead | - | - | blocked | L99 | - | - | 1d | todo when L99 done; no code |
| A02 | [Fable review](cards/A02-account-switching-fable-review.md) | - | frontier | - | - | todo | A01 | - | - | 4h | owner-requested Fable (claude-fable-5-2) |
| A03 | [Account switching checkpoint](cards/A03-account-switching-checkpoint.md) | - | lead | - | - | todo | A02 | - | - | 1d | ends at owner CP4; no merge before approval |

## Questions

| ID | Step | Question | Options | Default | Needed by | State | Answer |
|---|---|---|---|---|---|---|---|
| Q1 | L09 | #1512 says keep unmerged until physical-phone acceptance of the Bun 1.4.2 hub; what holds? | Keep the gate: L09 runs last, then waits for your phone check (Recommended) / Waive it for develop / Defer #1512 out of this plan | none | 2026-11-17T12:00 | closed | Keep the #1512 phone gate: L09 runs last, then waits for the owner's phone check (owner, 2026-11-12T19:58-08:00) |
| Q2 | L03 | Local Mac xcodebuild test stalled on #1728; what is the Mac test gate for native PRs if it stalls again? | One bounded 45-min attempt, then accept hosted swift test (same RemiKitTests target the Mac scheme tests) plus local swift test, recorded in the PR (Recommended) / Require a passing local Mac xcodebuild test | none | 2026-11-13T12:00 | open |  |
| Q3 | L06 | #1731: approve landing the narrow fix (reset the relay retry budget only after an admitted episode) per its fix-phase-plan? | Approve (Recommended) / Not now: keep the branch | none | 2026-11-14T12:00 | open |  |
| Q4 | L08 | image-availability is a strict subset of native-images; fold it, or land it first as a small PR? | Fold into native-images, delete after L08 (Recommended) / Land it first as a small PR | none | 2026-11-16T12:00 | closed | Fold image-availability into native-images; delete it after L08 via owner commands (owner, 2026-11-12T19:58-08:00) |
| Q5 | L11 | #1711 compact-preview is a feasibility probe (system Pillow, C probes) with no consumer; what happens to it? | Park: keep the branch, no PR (Recommended) / Land under scripts/preview-proof as uv scripts / Delete the branch | none | 2026-11-16T12:00 | closed | Park #1711: keep the branch, no PR (owner, 2026-11-12T19:58-08:00) |
| Q6 | L12 | #1641 adds 92 lines of tests pinning the legacy route writer; land now or keep for the #1641 implementation PR? | Fold into the first #1641 implementation PR, keep the branch (Recommended) / Land now as a small test PR | none | 2026-11-16T12:00 | closed | Fold #1641 tests into its first implementation PR; keep the branch (owner, 2026-11-12T19:58-08:00) |
| Q7 | L10 | Read the 3 untracked #1727 files (L10 card lists them) for sensitive content; what should happen to them? | Keep local until #1727 is planned (Recommended) / Safe: commit and push on the branch / Delete them | none | 2026-11-16T12:00 | open |  |
| Q8 | L13 | Delete these superseded branches at cleanup: #1717 apns-test-scheduling, native-build-21, #1346 fixture, 1195-epic-relay, 3 scratch/1724? | Delete all and close #1717 citing #1719 (Recommended) / Keep some (name them) | none | 2026-11-18T12:00 | closed | Delete the superseded branches only via commands handed to the owner (L13) (owner, 2026-11-12T19:58-08:00) |
| Q9 | L03 | Add a Codex Luna second reviewer (different family) on security PRs L03, L06 and chunk L08-R4? | Yes, those three only (Recommended) / Yes, every PR / No, Sonnet only | none | 2026-11-13T12:00 | closed | Add a Codex Luna second reviewer on L03, L06 and chunk L08-R4 only, on top of Sonnet (owner, 2026-11-12T19:58-08:00) |
| Q10 | L03 | Codex native cards: SwiftPM and xcodebuild write under ~/Library; which sandbox? | danger-full-access for xcode steps only (Recommended) / workspace-write; ask again if a gate is blocked | none | 2026-11-13T12:00 | closed | Codex danger-full-access for native Swift cards only, in a clean worktree; every other Codex card stays workspace-write (owner, 2026-11-12T19:58-08:00) |

## Proposals

| ID | Time | Proposal | Why | State |
|---|---|---|---|---|

## Agents

| Agent | Role | Slot | Model | Step | Started | State |
|---|---|---|---|---|---|---|
