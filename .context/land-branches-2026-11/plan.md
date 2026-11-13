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

The manager may merge a step's PR into `develop`, with `gh pr merge N --merge` (a merge commit, as the repository does; never `--squash`, never `--delete-branch`), only when the merge gate in the runbook ("Merge gate", section 10) passes.
In short: every dispatched review report is in (a missing one is redispatched, then done by the advisor, never skipped); every finding has an outcome and every `fix` finding is verified on the final head by its test or repro; no accepted Critical is open; the head contains every non-bump commit on `develop`; the named check set passes on the final head (Build and Test (Native) for native PRs, the real relay soak for relay-scoped PRs; "no checks reported" is not a pass); and issue-closing references in the branch's commits are handed to the owner.
Pushes to `develop` run only the version bump and issue closing, so the manager also verifies each new `develop` tip itself ([DV](cards/DV-develop-verify.md)) and never merges again before the bump commit lands; a red tip stops all merges, and a rollback is an owner decision ([RB](cards/RB-revert-merge.md)).
Owner answer Q15: the manager may also merge a large review-fix PR into its step PR's head branch (never into `develop` directly), after the same merge gate.

Never merged by the manager:

- anything into `main` (releases are the owner's);
- #1512 (L09) until the owner reports the physical-phone acceptance (Q1: keep the gate);
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
| Second reviewer (Q9) | reviewer | Codex `gpt-6-luna` max, on top of Sonnet, for L03, L06 and chunk L08-R4 only |
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
| `patch/issue-1731-idle-recovery` | #1731 | no PR, head `ea7064fd`, 4 test commits plus wip `ea7064fd`; 0 behind; the wip diff equals `approved-fix-candidate.patch` in the #1731 artifacts, whose focused run passed 5 tests; the issue says owner approval of that fix plan is pending | **Land** (L06) after L03 (Q3 approved, owner 2026-11-12) |
| `patch/issue-1720-local-notification-order` | #1720 | no PR, head `8225b2eb`, 42 commits (39 non-merge), 28 behind, 39 native files, +5,256; merges clean on develop; its last commit adds the same test lines as #1732's `e6cca52e`; its own handoff (`artifacts/notification-burst-20261030/issue-1720-current-handoff.md`) says it is "not ready for a PR or release" and not connected to live iPhone scheduling, gated on #1727 | **Parked** (Q12, owner 2026-11-12) until #1727 is resolved; L07 is `blocked` as parked, branch kept |
| `feature/issue-1313-native-images` | #1313 | no PR, head `82db1172`, 154 commits (151 non-merge), 0 behind, 39 files, +6,727; ingress gated off (`imageIngressQualified = false`); conflicts with #1728 in `RemiConnection.swift`; commit `40fb479f` ("closed #1313") would auto-close #1313; its artifacts say not to land it as a dormant PR (`reviewable-slices-current-20261031.md`, `split-and-dependency-inventory.md`) | **Parked as evidence** (Q11 option a, owner 2026-11-12); L08 dropped, branch kept, chunk cards for reference only |
| `feature/issue-1313-image-availability` | #1313 | no PR, head `38f5691d`, 3 commits, a strict subset of native-images (two patch-identical commits; the third differs by one reflowed line); merges clean after #1728 and #1731; no closing keyword; the artifacts name it the smallest slice with a caller | **Land alone** after L03 as L14 (Q11 option a, owner 2026-11-12; supersedes the Q4 fold) |
| `chore/issue-1273-bun142-pins` | #1273, PR #1512 | open, DIRTY, head `3a654273`, 787 behind; 6 workflows, CI scripts, AGENTS.md, plan.md, relay tests; body: keep unmerged until physical-phone acceptance; develop still pins Bun 1.3.11 | **Land last** (L09); the phone gate stays (Q1, owner 2026-11-12): merged only after the owner's phone check |
| `feature/issue-1641-native-wss-route` | #1641 | no PR, head `0c075a28`, 1 commit, 28 behind, one 92-line Swift test characterizing the legacy route writer | **Fold** into the first #1641 implementation PR (Q6, owner 2026-11-12); branch kept; L12 dropped |
| `feature/issue-1711-compact-preview` | #1711 | no PR, head `fda985af`, 1 commit, 79 behind, 6 feasibility files under `scripts/preview-proof/` (Python using system Pillow, C probes); no consumer | **Park** (Q5, owner 2026-11-12): branch kept, no PR; L11 dropped |
| `patch/issue-1727-store-callback-order` | #1727 | **local only**, worktree `/Volumes/S1/worktrees/remi/store-callback-order` at `4a525a14` (no commits of its own), no remote branch; 3 untracked files (7,002, 20,157 and 3,949 bytes) that may derive from real transcripts; not read by the lead | Owner: files are synthetic (Q7); the manager session pushed them (`9e7ddf41`); L10 verifies the push and Q16 decides whether a PR follows |
| `patch/issue-1717-apns-test-scheduling` | #1717 | 2 commits; its one file equals develop's (landed through #1719, `32aa9483`); issue #1717 still open | **Drop**: delete branch, close #1717 pointing at #1719 (Q8 approved: owner commands in L13) |
| `chore/native-build-21` | - | PR #1672 closed, superseded by #1704; develop's build number is already 22 | **Drop** (Q8 approved: owner commands in L13) |
| `patch/issue-1346-secure-push-expiry-fixture` | #1346 (closed) | PR #1347 closed, its commit included in #1345 | **Drop** (Q8 approved: owner commands in L13) |
| `feature/issue-1195-epic-relay` | - | 0 commits ahead of develop | **Drop**: fully merged (Q8 approved: owner commands in L13) |
| `feature/issue-1170-private-copy-adoption`, `feature/issue-1170-strict-staging-ingress`, `feature/issue-1243-mac-session-history` | #1170, #1243 | local branches only (no remote branch) | **Out of scope** for this plan: not pushed, so not part of the landing; no command touches them |

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
| L07 | [L07](cards/L07-local-notification-order.md) | parked (Q12) until #1727 is resolved; not dispatched | worker | L04, CP1 | 3d |
| L08 | [L08](cards/L08-native-images.md) | dropped as parked evidence (Q11 option a); card and chunk cards are reference only | worker-hard | L03, CP1 | 3d |
| L09 | [L09](cards/L09-bun142-pins.md) | #1512 refreshed, checked, reviewed; merged only after the owner's phone check (Q1); dispatched while no native PR is in review | worker-hard | L01 | 2d |
| L12 | [L12](cards/L12-native-wss-characterization.md) | dropped (Q6: fold into the first #1641 implementation PR; branch kept) | worker | - | 4h |
| L11 | [L11](cards/L11-compact-preview.md) | dropped (Q5: park; branch kept) | worker | - | 4h |
| L10 | [L10](cards/L10-store-callback-owner-check.md) | verify the #1727 push landed; Q16 decides whether a PR follows | - | - | - |
| CP1 | (manager rule) | lead's go or adjust for L07 and L08 after L01 to L06 are done or dropped | - | - | - |
| L14 | [L14](cards/L14-image-availability.md) | image-availability as its own PR (Q11 option a) | worker | L03 | 1d |
| L99 | (manager rule) | landing complete: L01 to L12, L14 and CP1 done or dropped, L07 done, dropped or parked; lead checkpoint CP2 | - | - | - |
| L13 | [L13](cards/L13-cleanup-commands.md) | exact cleanup commands handed to the owner | worker | L99 | 2h |
| P01 | [P01](cards/P01-ipad-board-design.md) | iPad multi-column Board design, verified against Apple docs and the simulator | lead | L99 | 1d |
| P02 | (outline) | iPad Board implementation, with visual acceptance; the lead writes the card at CP3 | worker-hard | P01 | - |
| A01 | [A01](cards/A01-account-switching-design.md) | account-switching ADR and epic draft, no code | lead | L99 | 1d |
| A02 | [A02](cards/A02-account-switching-fable-review.md) | Fable advisor review of the A01 draft | frontier | A01 | 4h |
| A03 | [A03](cards/A03-account-switching-checkpoint.md) | A02 findings folded in; owner checkpoint | lead | A02 | 1d |

After the owner's answers of 2026-11-12: L01 to L04, L06, L09 and L14 are `todo` (behind their dependencies); L07 is `blocked` (parked, Q12); L08, L11 and L12 are `dropped` (L08 parked as evidence); L10 waits on Q16.
P01 and A01 start `blocked`; the manager sets them `todo` when L99 is `done` (runbook); A01 stays behind L99 because the owner asked for the account-switching phase to wait until every landing step is done or dropped.
The board counts a `dropped` dependency as unmet; the runbook's "Dropped dependency" rule sends each such case to the lead, and the late steps depend on L99 and CP1 for the same reason.
Collision rule kept from the old L06 edge: if L06 is `active` or `review` when L08 runs, L08 merges `develop` again after L06 lands.

### Dependency and slot graph

```text
codex-luna (2)   L01 ── L09 (terra; Q1 phone gate; no native PR in review)
                 L02 (independent)
                 L04
codex-terra (1)  L03 ──┬── L05 (luna)
                       ├── L06
                       └── L14 (luna)
parked           L07 (#1720, until #1727)   L08 (native-images, evidence)
CP1 = lead go/adjust after L01 to L06 are done or dropped
owner            L10 (Q16)   (L11, L12 dropped: Q5 park, Q6 fold)
all L (L07 parked), L14, CP1 settled ── L99 ──┬── L13 cleanup (owner runs commands)
                            ├── P01 iPad design (opus) ── owner CP3 ── P02 (outline)
                            └── A01 (opus) ── A02 (fable) ── A03 (opus) ── owner CP4
claude-sonnet (2): reviewers and synthesis only; xcode lock: one native gate run at a time
```

At the first tick the dispatch plan places L01 and L02 on `codex-luna` (checked with `manager_board.py status` after the pack review); once Q2 is answered, L03 goes to `codex-terra` and L04 to the first free Luna slot.
The Xcode lock, not the slots, serializes the native gate runs of L03, L04, L05 and later steps, so two native implementers may work at once and queue only for gate runs.

## 3. Review policy

Every PR follows `project:pr-review-toolkit`'s `review-convergence.md`: round 1, an optional delta round 2, never a third.

| PR | Round 1 | Notes |
| --- | --- | --- |
| L01 (#1733) | 1 Sonnet reviewer (docs-only) | [RV-panel](cards/RV-panel.md), lens group `docs` |
| L02, L03, L09 | Q13 option a (owner): one RV-delta review from the recorded head (L03 adds the Q9 Luna reviewer) | recorded rounds: #1728 body plus run logs `review-r1-*`, `review-r2-*` in its artifacts (no report file found); #1657 receipt JSON round 1 (0 Critical, 0 Important, 1 Moderate, resolved); #1512 `PIN-REVIEW-R1.md` (no actionable findings at `3a654273`) |
| L04, L06, L14 | 3 Sonnet reviewers: `contract`, `verification`, `maintainability` | L06 adds a Codex Luna `contract` reviewer (Q9); security paths: contested findings go to the advisor |
| L05 (#1707) | none | two rounds are on record; the develop-merge resolution is verified by one advisor consult when the merge commit has a manual resolution (`git show --cc` not empty) |
| L07, L08 | parked (Q12, Q11): no review now; if either is unparked later, the chunked review below applies (4 chunks x 2 Sonnet reviewers, 1 cross-chunk, 1 synthesis; L08-R4 adds Luna) | chunk cards kept for reference |
| P01, A01-A03 docs PRs | 1 Sonnet reviewer | then the owner checkpoint |

The review form for #1728, #1657 and #1512 is the owner's answer to Q13: accept the recorded rounds plus one delta review.
Every reviewer reports `omitted_findings`, the count dropped by its 5-finding cap; a reviewer silent at 20 minutes is dispatched again once, then the advisor performs that lens; a report is never skipped.
Owner answer Q9: a Codex Luna second reviewer joins the security-path reviews (L03, L06, and chunk R4 of L08), on top of Sonnet, because the implementer family of the existing commits is unknown (every commit carries the owner's git identity).

Finding outcomes: every finding starts as `fix`.
The implementer may propose `reject` (one-sentence reason) or `issue` (only for code the PR did not touch); all proposed rejects of one round go to one advisor consult, whose ruling the manager records with `decide` and on the PR.

### 3.1 Chunked review of the two big PRs (reference: both are parked)

Both L07 and L08 are parked by the owner's answers; this section stays so the review can run unchanged if either is unparked.

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
**Cross-chunk reviewer:** one per big PR ([RV-cross-chunk](cards/RV-cross-chunk.md)), contract lens only, traces the composed paths across chunks within 1,500 lines.
**Synthesis budget:** the chunk reports, the cross-chunk report and (L08) the Luna report, at most about 50 findings, plus the cited lines of each Critical or Important finding; it deduplicates, verifies those it can, and returns one list; it adds no new findings and refuses to run while any `contract` report (or either L08-R4 report) is missing.
Per big PR, round 1 costs 10 Sonnet agents (11 with L08's Luna reviewer); at 2 concurrent Sonnet sessions that is about five to six reviewer turns.
Chunk reviewers of L07 read the branch's own remaining-work handoff first; chunk reviewers of L08 read the #1313 slices document first.

## 4. Capacity, Parity and budgets (approved by the owner as proposed, 2026-11-12)

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
Status: both reviews done on 2026-11-12 (executability by Sonnet, design by Opus); the coordinator spot-checked the design review's two critical claims (Q11, Q12 evidence) against the artifacts.
Owner approval (CP0, 2026-11-12, in chat): the Parity, Slots and Budget defaults and the merge authority (develop only, merge commits) were approved as proposed; Q1 to Q15 are answered and applied (Q4 superseded by Q11); Q16 (#1727 PR) is open.

| ID | Finding (short) | Disposition |
| --- | --- | --- |
| E1 | Q3 "not now" drops L06 and silently strands L08; other dropped-dependency paths | Fixed: L08 depends on L03 and CP1 only, with a collision rule for L06; runbook "Dropped dependency" rule sends every such case to the lead; L07 depends on L04 and CP1 |
| E2 | Worktree creation unspecified; `-C` for read-only cards; no lead-step recipe | Fixed: runbook section 5 worktree table (existing, existing branch, new branch, detached, read-only) with exact commands; lead-tier Agent recipe in section 4 |
| E3 | Agent tool model values and parameters | Fixed: `model: fable` for A02 (id `claude-fable-5-2` in a note), `description` instead of a name, `effort: xhigh` for Sonnet reviewers (review-panel protocol) and Opus lead work (owner rule) |
| E4 | L01's branch is checked out in `wt-agents` | Fixed: setup removes `wt-agents` after a status check; L01's typos gate reads from `git show` |
| E5 | Q2 wording; reviewer Codex command and slot; L13 schema; serve port; L04 judgment call | Fixed: Q2 mapping text matches the cards; read-only reviewer variant counted against Luna capacity; `pr` 0 for L13; port 8799; L04 closing keyword only after a literal `git grep` and the tests |
| D1 | A red `develop` is never detected | Fixed: fresh-base gate item, wait for the bump commit, [DV](cards/DV-develop-verify.md) after every merge, [RB](cards/RB-revert-merge.md) for an owner-decided rollback |
| D2 | Proceeding without a silent reviewer's report | Fixed: redispatch once, then the advisor performs the lens; synthesis refuses to run without every `contract` report, the cross-chunk report and both L08-R4 reports; plan 0.4 and the runbook agree |
| D3 | Merge gate too loose | Fixed: every `fix` finding verified on the final head; named check set per PR class; "no checks reported" is not a pass |
| D4 | Composed paths across chunks unreviewed; capped findings invisible | Fixed: [RV-cross-chunk](cards/RV-cross-chunk.md) per big PR; `omitted_findings` in every reviewer report |
| D5 | Delta review of big PRs; large fixes unreviewed | Fixed: one delta reviewer per touched chunk; large fixes go into a fix PR on the head branch; merging such a fix PR is outside the approved authority, so asked as **Q15** |
| D6 | close-on-develop would close #1313 | Fixed: merge gate item 5 scans every PR with the repository's own `extractClosingReferences`; only native-images' `40fb479f` matched across all landing branches (image-availability has none); owner gets the reopen command |
| D7 | Full-access cards could merge, close or post | Fixed: preamble forbids it; the manager checks `develop` and merged PRs after every full-access run; `codex-landing.rules` written and verified with `codex execpolicy check` (codex-cli 0.167.0); installing it into `~/.codex/rules` changes the owner's config, so asked as **Q14** |
| D8 | CP1 gate; A01 on capacity; L09 dependency; #1634 contradiction; PairingAttemptTests on hosted; out-of-scope branches | Fixed except one part: CP1 step added; L09 depends on L01 with the no-native-review rule; flakes go to owner-run `gh issue comment 1634`; L03 requires the hosted log line; three local-only branches named out of scope. **Rejected:** A01 on capacity alone, because the owner explicitly required the account-switching phase to stay blocked until every landing step is done or dropped |
| Q11 | native-images should not land dormant (artifacts) | Asked as **Q11** (supersedes Q4); L08 and L14 re-planned so each option is one board edit |
| Q12 | #1720 is not ready and not wired to live scheduling | Asked as **Q12**; L07 re-planned; chunk reviewers read the remaining-work list either way |
| Q13 | Earlier review rounds recorded outside the PRs | Asked as **Q13**, with what was found for #1728, #1657 and #1512 (plan section 3) |

Totals: 16 items; 13 fixed (E1 to E5, D1 to D4, D6, and the fixable parts of D5, D7 and D8), 1 rejected with reason (D8, A01 on capacity), 5 new owner questions (Q11 to Q15).

## Appendix B: facts the lead could not verify

- Whether local Mac `xcodebuild ... test` still stalls before loading a bundle (Q2).
- Whether Codex `workspace-write` with the listed writable roots can run SwiftPM and `xcodebuild` (they write under `~/Library`); moot for native cards after Q10 (full access in a clean worktree).
- Whether the #1720 branch's tests pass at its head: its last commit is a test-first reproduction of the #1732 defect, which is expected to fail until L04 lands; no native CI ran on branches without a PR.
- Whether the 3 untracked #1727 files contain sensitive content (not read on purpose).
- Whether `codex exec` loads a rules file placed in `~/.codex/rules` and applies it under `-s danger-full-access` (only `codex execpolicy check` was run).
- The exact line the hosted Swift Testing log prints for a passing `PairingAttemptTests` suite (L03 greps for `PairingAttemptTests.*passed`).
- `packages/native/AGENTS.md` says the hosted native job is "the only place the Mac `xcodebuild test` is known to run", but `native-app.yml` runs `swift test` and four `xcodebuild build` commands, no `xcodebuild test`; the `RemiMac` scheme's only testable is `RemiKitTests`, which `swift test` runs, so the tests run but not under Xcode's Mac test runner; filed as a doc fix in [issues-to-file.md](issues-to-file.md).
- `Remi.xcodeproj` sets `TARGETED_DEVICE_FAMILY = "1,2"` for RemiPhone (Debug and Release) while #1629 recorded "device family stays iPhone"; P01 resolves which is true for shipped builds.
