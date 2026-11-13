# Plan: land the pushed branches into develop (2026-11)

Lead: Claude Opus, 2026-11-12.
Goal: every valuable pushed-but-unmerged branch of yooz-labs/remi reaches `develop` through a reviewed pull request (PR), or is folded, parked or dropped by a recorded decision.
After landing, two late phases run in the same loop: an adaptive multi-column iPad Board (design, then implementation) and the account-switching design (design and epic only, no code).
`develop` was at `1cbdcc6f` (2026-10-31, no merges since) when this plan was written.

## 0. How the manager uses this plan

### 0.1 Start prompt

```text
You are the manager of yooz-labs/remi land-branches-2026-11.
Run one tick of the runbook at /Volumes/S1/worktrees/remi/land-branches-plan/.context/land-branches-2026-11/runbook.md, exactly as written, using the project:manager-loop skill.
The state is the board beside it: /Volumes/S1/worktrees/remi/land-branches-plan/.context/land-branches-2026-11/board.md.
Read lead.md beside it before anything else.
Your manager id is mba-claude-sonnet, the same on every tick.
Do not write product code.
Do not change the plan, a card, a gate, the parity, or a budget limit.
When the runbook says to stop or to ask, or does not cover what you see, record it on the board, ask the owner with a structured question, and stop that thread of work.
```

Run it in Claude Code, from the main checkout's session, as `/loop ` followed by the prompt, with no interval.
The pack and the board live on branch `chore/land-branches-plan` in the worktree `/Volumes/S1/worktrees/remi/land-branches-plan`, never on `develop` (runbook, "Where the pack lives").

### 0.2 Tick

The tick is the skill's, with this project's handlers in [runbook.md](runbook.md).
The intermittent lead and its continuity file [lead.md](lead.md) are described there.

### 0.3 Precedence

The owner's later instructions override this plan and are logged with `decide ... --by owner`.
The repository's `AGENTS.md` (and `packages/native/AGENTS.md`) override this plan, with two explicit exceptions:

1. **Never rebase a pushed branch.** `packages/native/AGENTS.md` says "rebase on develop at least daily"; in this plan the branch's worker merges `origin/develop` into the branch instead, and never force-pushes.
2. **Native gate wrapper.** Native gates run under the shared Xcode lock (runbook, "Xcode lock"), which `packages/native/AGENTS.md` does not mention.

### 0.4 Merge authority

The manager may merge a step's PR into `develop`, with `gh pr merge N --merge` (a merge commit, as the repository does; never `--squash`, never `--delete-branch`), only when the merge gate passes:
every review report is in, every finding has an outcome, no accepted Critical is open, and `gh pr checks N` shows every check passing or skipping (none pending, none failing) on the final head.

Never merged by the manager:

- anything into `main` (releases are the owner's);
- #1512 (L09) unless Q1 says the phone gate is met or waived;
- the P01 design PR and the A03 design PR: they merge only after the owner approves them at their checkpoints;
- a PR that relaxes a gate's assertion (to the lead).

`develop` pushes trigger `auto-bump-dev.yml`, which commits a version bump; never hand-edit versions, never add `[skip ci]` to a PR head.

### 0.5 Question classes that may take a default

None.
Every owner question waits for an answer; silence is never an answer.

### 0.6 Routing

| Role | Tier | Model |
| --- | --- | --- |
| Manager | worker | Claude Sonnet (`sonnet`), id `mba-claude-sonnet` |
| Lead (intermittent) and ordinary escalation advisor | lead | Claude Opus (`opus`), xhigh |
| Implementers | worker / worker-hard | Codex `gpt-6-luna` max / `gpt-6.1-terra` xhigh |
| Reviewers | reviewer | Claude Sonnet xhigh (owner's global rule) |
| Optional second reviewer | reviewer | Codex `gpt-6-luna` max, only where Q9 says |
| A02 account-switching advisor review | frontier | Claude Fable, `claude-fable-5-2` |

**Fable is an owner-requested use, not a default.**
The owner asked for a Fable advisor for exactly one step, A02 (technical nuance and competitive position of the account-switching design).
No other card, escalation or checkpoint uses the frontier tier; Codex `gpt-6-astra` is not used.
Codex `gpt-6.1-sol` (lead tier on Codex) is not in the slot budget and is used only if a card says so (none does).

## 1. Inventory and decision per branch

Observed on 2026-11-12 between 18:55 and 19:30 PST with `git fetch --prune`, `git log`, `git diff --stat`, `git merge-tree --write-tree`, `gh pr view` and `gh pr checks`.
"Behind" counts commits on `origin/develop` that the branch lacks.

| Branch | Issue / PR | What was seen | Decision |
| --- | --- | --- | --- |
| `chore/agents-md-split` | PR #1733 | open, not draft, CLEAN, head `b379ea64`, 2 commits, 0 behind, 6 docs files; checks green; no review on record | **Land** (L01), first: every later worker reads the slimmed AGENTS.md |
| `feature/issue-1656-terminal-relay-qualification` | #1656, PR #1657 | draft, CLEAN, head `26fbf947`, 2 commits, 304 behind; TS probe, docs, `tsconfig.json`; **no checks on the head**; its prerequisite #1655 merged 2026-10-31 (`c101877a`); body claims one review round, none on record | **Land** (L02): merge develop, get checks, review |
| `patch/issue-1724-direct-child-key` | #1724, PR #1728 | draft, CLEAN, head `5c1f9380`, 14 commits, 0 behind, 12 native files incl. `RemiConnection.swift`, `MachineStore.swift`; every check green at the head (native build/test, 61-minute relay); body: local Mac `xcodebuild test` stalled, gate "unpassed"; two reviews claimed, none on record | **Land** (L03), first native step: security foundation, conflicts with native-images |
| `scratch/issue-1724-*` (3) | #1724 | `hosted-scheduler-af0` tree equals the #1728 head; `1724-fence-diagnostic` and `1724-hosted-diagnostic` are one wip diagnostics commit each, 28 behind | **Evidence only** (named in the L03 PR body); delete after L03 merges (Q8) |
| `patch/issue-1732-question-session-identity` | #1732 | no PR, head `9727af7c`, 2 test-only commits, 0 behind; the second test calls `question(sessionID:questionID:)`, which no source defines, so the branch needs the implementation the issue describes | **Implement and land** (L04); prerequisite of #1720 |
| `feature/issue-1681-notification-preferences` | #1681, PR #1707 | draft, DIRTY (conflict in `Mac/MacLiveRootView.swift`), head `860a03b8`, 79 behind, 18 native files; two review rounds on record (R1 one Important, R2 no findings) | **Land** (L05): merge develop, no third review round |
| `patch/issue-1731-idle-recovery` | #1731 | no PR, head `ea7064fd`, 4 test commits plus wip `ea7064fd`; 0 behind; the wip diff equals `approved-fix-candidate.patch` in the #1731 artifacts, whose focused run passed 5 tests; the issue says owner approval of that fix plan is pending | **Land** (L06) after Q3 |
| `patch/issue-1720-local-notification-order` | #1720 | no PR, head `8225b2eb`, 42 commits (39 non-merge), 28 behind, 39 native files, +5,256; merges clean on develop; its last commit adds the same test lines as #1732's `e6cca52e`, so it conflicts once L04 lands | **Land** (L07) as ONE PR with chunked review |
| `feature/issue-1313-native-images` | #1313 | no PR, head `82db1172`, 154 commits (151 non-merge), 0 behind, 39 files (38 native, 1 daemon line pair), +6,727; image ingress ships gated off (`imageIngressQualified = false`); conflicts with the #1728 head in `RemiConnection.swift` | **Land** (L08) as ONE PR with chunked review, after L03 and L06 |
| `feature/issue-1313-image-availability` | #1313 | no PR, head `38f5691d`, 3 commits; not an ancestor of native-images, but a strict subset: two commits are patch-identical to native-images' last two, and the third's files equal native-images' except one reflowed signature line | **Fold** into native-images (Q4); delete after L08 merges |
| `chore/issue-1273-bun142-pins` | #1273, PR #1512 | open, DIRTY, head `3a654273`, 787 behind; 6 workflows, CI scripts, AGENTS.md, plan.md, relay tests; body: keep unmerged until physical-phone acceptance; develop still pins Bun 1.3.11 | **Land last** (L09) if Q1 allows |
| `feature/issue-1641-native-wss-route` | #1641 | no PR, head `0c075a28`, 1 commit, 28 behind, one 92-line Swift test characterizing the legacy route writer | **Owner question** (Q6): recommended fold into the first #1641 implementation PR; L12 lands it alone if the owner prefers |
| `feature/issue-1711-compact-preview` | #1711 | no PR, head `fda985af`, 1 commit, 79 behind, 6 feasibility files under `scripts/preview-proof/` (Python using system Pillow, C probes); no consumer | **Owner question** (Q5): recommended park (keep branch, no PR) |
| `patch/issue-1727-store-callback-order` | #1727 | **local only**, worktree `/Volumes/S1/worktrees/remi/store-callback-order` at `4a525a14` (no commits of its own), no remote branch; 3 untracked files (7,002, 20,157 and 3,949 bytes) that may derive from real transcripts; not read by the lead | **Owner check first** (L10, Q7); nothing is committed or pushed by any agent |
| `patch/issue-1717-apns-test-scheduling` | #1717 | 2 commits; its one file equals develop's (landed through #1719, `32aa9483`); issue #1717 still open | **Drop**: delete branch, close #1717 pointing at #1719 (Q8, owner commands in L13) |
| `chore/native-build-21` | - | PR #1672 closed, superseded by #1704; develop's build number is already 22 | **Drop** (Q8) |
| `patch/issue-1346-secure-push-expiry-fixture` | #1346 (closed) | PR #1347 closed, its commit included in #1345 | **Drop** (Q8) |
| `feature/issue-1195-epic-relay` | - | 0 commits ahead of develop | **Drop**: fully merged (Q8) |

## 2. Steps

Board order is dispatch priority.
Tiers map to models through the board's Parity table.
`xcode` in Needs means the step runs native gates under the Xcode lock.

| ID | Card | Goal | Tier | Depends | Timebox |
| --- | --- | --- | --- | --- | --- |
| L01 | [L01](cards/L01-agents-md-split.md) | #1733 merged after a verbatim-move check and one docs review | worker | - | 4h |
| L03 | [L03](cards/L03-direct-child-key.md) | #1728 merged with the Mac test gate settled by Q2 | worker-hard | - | 2d |
| L02 | [L02](cards/L02-terminal-relay-qualification.md) | #1657 refreshed from develop, checked, reviewed, merged | worker | - | 1d |
| L04 | [L04](cards/L04-question-session-identity.md) | #1732 implemented per the issue and merged | worker | - | 1d |
| L05 | [L05](cards/L05-notification-preferences.md) | #1707 conflict resolved, verified, merged | worker | L03 | 1d |
| L06 | [L06](cards/L06-idle-recovery.md) | #1731 narrow fix finished per its approved plan and merged | worker-hard | L03 | 2d |
| L07 | [L07](cards/L07-local-notification-order.md) | #1720 as one PR, chunk-reviewed, merged | worker | L03, L04, L05 | 3d |
| L08 | [L08](cards/L08-native-images.md) | native-images as one PR, chunk-reviewed, merged | worker-hard | L03, L06 | 3d |
| L09 | [L09](cards/L09-bun142-pins.md) | #1512 refreshed, checked, reviewed; merged only as Q1 allows | worker-hard | L01, L07, L08 | 2d |
| L12 | [L12](cards/L12-native-wss-characterization.md) | only if Q6 says land: #1641 tests in a small PR | worker | - | 4h |
| L11 | [L11](cards/L11-compact-preview.md) | only if Q5 says land: #1711 probes in a small PR | worker | - | 4h |
| L10 | [L10](cards/L10-store-callback-owner-check.md) | the owner checks the #1727 untracked files (owner step) | - | - | - |
| L99 | (manager rule) | landing complete: every L step done or dropped; lead checkpoint CP2 | - | - | - |
| L13 | [L13](cards/L13-cleanup-commands.md) | exact cleanup commands handed to the owner | worker | L99 | 2h |
| P01 | [P01](cards/P01-ipad-board-design.md) | iPad multi-column Board design, verified against Apple docs and the simulator | lead | L99 | 1d |
| P02 | (outline) | iPad Board implementation, with visual acceptance; the lead writes the card at CP3 | worker-hard | P01 | - |
| A01 | [A01](cards/A01-account-switching-design.md) | account-switching ADR and epic draft, no code | lead | L99 | 1d |
| A02 | [A02](cards/A02-account-switching-fable-review.md) | Fable advisor review of the A01 draft | frontier | A01 | 4h |
| A03 | [A03](cards/A03-account-switching-checkpoint.md) | A02 findings folded in; owner checkpoint | lead | A02 | 1d |

L03 and L04 start in `owner` (wait on Q2 and Q10), L06 in `owner` (Q3), L09 in `owner` (Q1), L11 and L12 in `owner` (Q5, Q6), L10 in `owner` (Q7).
P01 and A01 start `blocked`; the manager sets them `todo` when L99 is `done` (runbook).
The board counts a `dropped` dependency as unmet, which is why the late steps depend on L99, not on each L step.

### Dependency and slot graph

```text
codex-luna (2)   L01 ─────────────────────────────────────────┐
                 L02 (independent)                             │
                 L04 ──────────────┐                           │
codex-terra (1)  L03 ──┬── L05 (luna) ──┴── L07 (luna, chunked) ┤
                       └── L06 (Q3) ── L08 (chunked) ──────────┴── L09 (Q1)
owner            L10 (Q7)   L11 (Q5)   L12 (Q6)
all L done/dropped ── L99 ──┬── L13 cleanup (owner runs commands)
                            ├── P01 iPad design (opus) ── owner CP3 ── P02 (outline)
                            └── A01 (opus) ── A02 (fable) ── A03 (opus) ── owner CP4
claude-sonnet (2): reviewers and synthesis only; xcode lock: one native gate run at a time
```

At the first tick the dispatch plan places L01 and L02 on `codex-luna` (checked with `manager_board.py status`); once Q2 and Q10 are answered, L03 goes to `codex-terra` and L04 to the first free Luna slot (L01 frees one quickly).
The Xcode lock, not the slots, serializes the native gate runs of L03, L04, L05 and later steps, so two native implementers may work at once and queue only for gate runs.

## 3. Review policy

Every PR follows `project:pr-review-toolkit`'s `review-convergence.md`: round 1, an optional delta round 2, never a third.

| PR | Round 1 | Notes |
| --- | --- | --- |
| L01 (#1733) | 1 Sonnet reviewer (docs-only) | [RV-panel](cards/RV-panel.md), lens group `docs` |
| L02, L11, L12 | 2 Sonnet reviewers: `contract`, `verification` | test or probe only |
| L03, L04, L06, L09 | 3 Sonnet reviewers: `contract`, `verification`, `maintainability` | L03, L06 security path: contested findings go to the advisor |
| L05 (#1707) | none | two rounds are on record; the develop-merge resolution is verified by one advisor consult when the merge commit has a manual resolution (`git show --cc` not empty) |
| L07, L08 | chunked: 4 chunks x 2 Sonnet reviewers, then 1 Sonnet synthesis | chunk cards below; one PR each, never split |
| P01, A01-A03 docs PRs | 1 Sonnet reviewer | then the owner checkpoint |

The earlier review rounds that #1728, #1657 and #1512 describe in their bodies have no record on the PR, so this landing runs their round 1 fresh (decided by the lead; the owner may override).
Q9 asks whether a Codex Luna second reviewer joins the security-path reviews (L03, L06, and chunk R4 of L08), where the implementer family of the existing commits is unknown (every commit carries the owner's git identity).

Finding outcomes: every finding starts as `fix`.
The implementer may propose `reject` (one-sentence reason) or `issue` (only for code the PR did not touch); all proposed rejects of one round go to one advisor consult, whose ruling the manager records with `decide` and on the PR.

### 3.1 Chunked review of the two big PRs

Commits on both branches interleave tests and sources across components, so commit ranges do not separate concerns; **path chunks are authoritative** and every changed file is in exactly one chunk (checked: no file uncovered).
Each chunk card is dispatched twice, with `Lens group: contract` (code, types, security, concurrency) and `Lens group: verification` (tests, error paths, comments and docs).

| Chunk | Card | Files | Changed lines | Commits touching |
| --- | --- | --- | --- | --- |
| L08-R1 journal and ledger | [L08-R1](cards/L08-R1-journal-ledger.md) | 5 | 1,583 | 43 |
| L08-R2 lease, key, protection | [L08-R2](cards/L08-R2-lease-key-protection.md) | 8 | 1,553 | 39 |
| L08-R3 snapshot, transfer, UI | [L08-R3](cards/L08-R3-snapshot-transfer-ui.md) | 15 | 1,972 | 46 |
| L08-R4 wire and authority | [L08-R4](cards/L08-R4-wire-authority.md) | 11 | 1,640 | 43 |
| L08 synthesis | [L08-S](cards/L08-S-synthesis.md) | reports only | - | - |
| L07-R1 ledger core | [L07-R1](cards/L07-R1-ledger-core.md) | 6 | 1,175 | 10 |
| L07-R2 lifecycle and startup | [L07-R2](cards/L07-R2-lifecycle-startup.md) | 7 | 1,366 | 16 |
| L07-R3 recovery and forget | [L07-R3](cards/L07-R3-recovery-forget.md) | 10 | 1,082 | 17 |
| L07-R4 inventory, owner, app | [L07-R4](cards/L07-R4-inventory-owner-app.md) | 16 | 1,639 | 12 |
| L07 synthesis | [L07-S](cards/L07-S-synthesis.md) | reports only | - | - |

Line counts are against `origin/develop` on 2026-11-12, before the develop merges L07 and L08 will make; the worker's merge adds the conflict resolution, which the chunk that owns the file reviews (`RemiConnection.swift` is in L08-R4; `SessionAddressingTests.swift` and `MachineStore.swift` are in L07-R4).

**Context budget per chunk reviewer:** read the chunk's diff in full (at most about 2,000 changed lines), plus at most 800 lines of unchanged code through targeted reads; do not read other chunks' files beyond `grep` for call sites; at most 5 findings; if the budget runs out, report what was covered and what was not.
**Synthesis budget:** the 8 chunk reports (at most 40 findings) plus the cited lines of each Critical or Important finding; it deduplicates, verifies those it can by reading the cited lines, and returns one list; it adds no new findings.
Per big PR, round 1 costs 9 Sonnet agents; at 2 concurrent Sonnet sessions that is about five reviewer turns.

## 4. Capacity, Parity and budgets (defaults the owner approves with this plan)

Owner capacity: Claude Code up to 2 Sonnet and 1 Opus sessions; Codex up to 2 Luna and 1 Terra sessions.
Slots on the board mirror it: `codex-terra` 1 (worker-hard), `codex-luna` 2 (worker), `claude-opus` 1 (lead), `claude-sonnet` 2 (reviewers and synthesis only, never a step), `claude-fable` 1 (A02 only).
The single Opus session is shared by lead-tier steps, lead wakes and advisor consults: during landing no step uses it, so it is free for wakes and consults; in the late phases a lead wake waits for a free Opus session, except an escalation on the integration branch, which the manager raises before dispatching anything else.

Daily limits per tier and platform are in the board's Budget table; a Codex row at its limit is a stop-and-ask (parity question), never a silent fallback to Claude.
Projected agent use for the whole plan: about 70 dispatches (landing about 60, late phases about 10), over about four working days at the daily limits; the 61-minute relay gate and the Xcode lock bound the pace more than the budget does.

## 5. Late phases

### 5.1 iPad adaptive multi-column Board (P01, P02)

Owner context: on iOS 27.2 an iPad connected to a second monitor can run any app in a large, Mac-like window; the owner wants the iPad dashboard to show cards in multiple resizable columns and rows like the Mac Board, not one column.
Verified facts: #1629 (closed) gave the iPhone app a regular-width shell with a readable single column (`RemiLayoutMode`, `remiReadableColumn`); the Mac Board (epic #1708, open; #1729 merged) is `packages/native/RemiKit/Sources/RemiUI/RemiBoard.swift` (686 lines) and `RemiLayoutMode.swift` (44 lines); the app targets list device families `1,2` in `Remi.xcodeproj`.
Not verified here: the iOS 27.2 external-display windowing behavior; P01 verifies it against current Apple documentation and the simulator.
P01 is design only and ends at owner checkpoint CP3; P02 stays `outline` until the lead writes its card from the approved design, with the visual-acceptance gate of `packages/native/VISUAL-ACCEPTANCE.md` and the parity rules of `packages/native/PARITY.md`.
Precondition: the Xcode MCP server answers on the manager host (it was not responding at the coordinator's last check); P01's first gate checks it.
The issue to file is in [issues-to-file.md](issues-to-file.md).

### 5.2 Account switching (A01, A02, A03)

Owner idea: track usage per account; at about 98 percent, notify the user and compact the session, then switch smoothly to another account the user has and continue the work; let sessions with different scopes use different logins; for Claude Code and Codex.
A01 researches how each installed CLI exposes usage and login (installed on 2026-11-12: Claude Code 2.1.323, codex-cli 0.167.0), writes an ADR under `.context/decisions/` and a phased epic with issue bodies, and writes **no implementation code**.
A02 is the owner-requested Fable advisor review; its findings go into the design before the owner sees it.
A03 folds the findings in and ends at owner checkpoint CP4; issues are filed only after the owner approves, by the owner's commands.

## 6. Later work, not in this plan

The TestFlight crash triage is a separate stream handled elsewhere.
Implementation of the account-switching epic waits for CP4 and a new plan.

## Appendix A: pack review

The skill requires an executability reviewer (worker tier) and a design reviewer (lead tier) before the first tick, each finding with a disposition here.
Status on 2026-11-12: **not run**; the lead was asked to write the pack only.
Run both before the owner starts the loop; record dispositions below.

| Reviewer | Finding | Disposition |
| --- | --- | --- |
| executability | (pending) | |
| design | (pending) | |

## Appendix B: facts the lead could not verify

- Whether local Mac `xcodebuild ... test` still stalls before loading a bundle (Q2).
- Whether Codex `workspace-write` with the listed writable roots can run SwiftPM and `xcodebuild` (they write under `~/Library`); Q10.
- Whether the #1720 branch's tests pass at its head: its last commit is a test-first reproduction of the #1732 defect, which is expected to fail until L04 lands; no native CI ran on branches without a PR.
- Whether the 3 untracked #1727 files contain sensitive content (not read on purpose).
- `packages/native/AGENTS.md` says the hosted native job is "the only place the Mac `xcodebuild test` is known to run", but `native-app.yml` runs `swift test` and four `xcodebuild build` commands, no `xcodebuild test`; the `RemiMac` scheme's only testable is `RemiKitTests`, which `swift test` runs, so the tests run but not under Xcode's Mac test runner; filed as a doc fix in [issues-to-file.md](issues-to-file.md).
- `Remi.xcodeproj` sets `TARGETED_DEVICE_FAMILY = "1,2"` for RemiPhone (Debug and Release) while #1629 recorded "device family stays iPhone"; P01 resolves which is true for shipped builds.
