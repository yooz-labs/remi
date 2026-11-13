# Runbook: land-branches-2026-11

The manager follows this file literally, one tick at a time, with the `project:manager-loop` skill.
Paths below are absolute; `PACK` means `/Volumes/S1/worktrees/remi/land-branches-plan/.context/land-branches-2026-11`, `BOARD` means `PACK/board.md`, `MAIN` means `/Users/yahya/Documents/git/yooz/remi` (the main checkout, always on `develop`), and `MB` means `python3 /Users/yahya/.claude/plugins/cache/research-skills/project/0.12.0/skills/manager-loop/scripts/manager_board.py`.

## 1. Where the pack lives

- The pack and board are on branch `chore/land-branches-plan` in worktree `/Volumes/S1/worktrees/remi/land-branches-plan`.
  `MAIN` stays on `develop`; never switch its branch.
- Board commits go to `chore/land-branches-plan` only (`docs: board, <what changed>`), locally every tick; push that branch only at checkpoints (`git -C /Volumes/S1/worktrees/remi/land-branches-plan push origin chore/land-branches-plan`); no CI job runs on a push of that branch.
- Evidence: `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/<step>/r<round>/` (one folder per dispatch); never in the repository.

## 2. Setup (once, before the first tick)

The owner runs, after approving the plan:

```bash
git -C /private/tmp/claude-501/-Users-yahya-Documents-git-yooz-remi/4a896ae1-b937-4436-9997-64e23e8a81fb/scratchpad/wt-plan status --short   # expect only node_modules, pnpm-lock.yaml, pnpm-workspace.yaml (generated, untracked)
git -C /Users/yahya/Documents/git/yooz/remi worktree remove --force /private/tmp/claude-501/-Users-yahya-Documents-git-yooz-remi/4a896ae1-b937-4436-9997-64e23e8a81fb/scratchpad/wt-plan
git -C /private/tmp/claude-501/-Users-yahya-Documents-git-yooz-remi/4a896ae1-b937-4436-9997-64e23e8a81fb/scratchpad/wt-agents status --short   # expect the same generated files only; it holds chore/agents-md-split
git -C /Users/yahya/Documents/git/yooz/remi worktree remove --force /private/tmp/claude-501/-Users-yahya-Documents-git-yooz-remi/4a896ae1-b937-4436-9997-64e23e8a81fb/scratchpad/wt-agents
git -C /Users/yahya/Documents/git/yooz/remi worktree add /Volumes/S1/worktrees/remi/land-branches-plan chore/land-branches-plan
mkdir -p /Volumes/S1/yooz/remi/locks /Volumes/S1/yooz/remi/artifacts/land-branches-2026-11
cd /Volumes/S1/worktrees/remi/land-branches-plan && bun install
```

Both branches' commits are safe in the shared refs; `--force` only discards each scratch worktree's generated untracked files.
If Q14 says install: `cp PACK/codex-landing.rules ~/.codex/rules/land-branches-2026-11.rules` (the owner runs it, and removes it when the loop ends).
Then the `/loop` start prompt (plan 0.1).
Optional live view (port 8765 belongs to the remi daemon; use 8799): `nohup python3 /Users/yahya/.claude/plugins/cache/research-skills/project/0.12.0/skills/manager-loop/scripts/manager_board.py serve /Volumes/S1/worktrees/remi/land-branches-plan/.context/land-branches-2026-11/board.md --port 8799 > /tmp/board-serve.log 2>&1 & disown`.

## 3. What to read

- Every tick: `PACK/lead.md` first, then `MB status BOARD`, then only the events it points to.
- First tick of a session, once: this runbook, `PACK/queue.md`, `PACK/checkpoints.md`, `PACK/risks.md`, `PACK/cards/README.md`.
- Never: the whole `board-log.md`, whole evidence folders, or a whole diff of L07 or L08.

## 4. Tools

| Need | How |
| --- | --- |
| Codex worker | section 5, run in the background (`run_in_background: true`) |
| Codex Luna reviewer (Q9) | section 5, reviewer variant |
| Claude reviewer, synthesis, cross-chunk, delta | Agent tool: `subagent_type: project:pr-review-toolkit`, `model: sonnet`, `effort: xhigh` (the review-panel protocol asks for Sonnet at xhigh), `run_in_background: true`, `description: "rv L03 contract"` (step and lens) |
| Lead wake, advisor, lead-tier step (P01, A01, A03) | Agent tool: `model: opus`, `effort: xhigh` (owner rule for lead work), `run_in_background: true`, `description` naming the step; brief per section 9, `references/escalation.md`, or preamble + card + live facts; no `isolation` parameter (the manager creates the worktree first, section 5) |
| A02 Fable advisor | Agent tool: `model: fable` (the model id is `claude-fable-5-2`), `run_in_background: true`, `description: "A02 Fable review"`; owner-requested, A02 only |
| Message a live Claude agent | SendMessage |
| Ask the owner | `MB ask` first, then AskUserQuestion (at most 4 questions per call) |
| Notify | PushNotification, at most one per event class per day |
| Wait | Monitor with a time limit; never an unbounded poll |
| Wake | ScheduleWakeup: 1800 s while workers run, 3600 s while waiting on people; `stop: true` when the board is `done` or `paused` |

Agent tool model values are only `sonnet`, `opus`, `haiku` and `fable`; there is no `name` parameter.

## 5. Worktrees and dispatch

### Worktrees (the manager creates them before dispatch)

| Case | Command | Steps |
| --- | --- | --- |
| Existing worktree | check `git -C MAIN worktree list` lists it and `git -C WT status --porcelain --untracked-files=no` is empty | L02 to L08, L14 (paths on the cards) |
| Existing branch, no worktree | `git -C MAIN worktree add WT BRANCH`, then `cd WT && bun install` | L09 (`/Volumes/S1/worktrees/remi/bun142-pins`, `chore/issue-1273-bun142-pins`); an L01 fix (`/Volumes/S1/worktrees/remi/agents-md-split`, `chore/agents-md-split`) |
| New branch | `git -C MAIN fetch origin && git -C MAIN worktree add -b BRANCH WT origin/develop`, then `cd WT && bun install` | P01 (`feature/issue-ISSUE-ipad-board`), A01 (`feature/issue-1157-account-switching-design`; A03 reuses it), RB (`patch/revert-MERGE8`) |
| Detached, once | `git -C MAIN worktree add --detach /Volumes/S1/worktrees/remi/develop-verify origin/develop`, then `bun install` | DV |
| Read-only | no worktree; Claude reviewers read by hash with `git -C MAIN`; Codex reviewers run with `-C MAIN -s read-only` | L01 check, every reviewer |

The manager never removes a worktree; L13 hands the owner the commands.

### Codex worker command

Model by tier: worker `gpt-6-luna` with `model_reasoning_effort=max`; worker-hard `gpt-6.1-terra` with `model_reasoning_effort=xhigh`.
`WT` is the card's worktree, `GITDIR` is `git -C WT rev-parse --git-dir`, `EVID` the evidence folder.

```bash
codex exec -m gpt-6-luna -c model_reasoning_effort=max \
  -s workspace-write \
  -c 'sandbox_workspace_write.writable_roots=["GITDIR","/Volumes/S1/derived","/Volumes/S1/yooz/remi/locks","/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11"]' \
  -c sandbox_workspace_write.network_access=true \
  -C WT --json -o EVID/codex-last-message.md \
  --output-schema /Users/yahya/.claude/plugins/cache/research-skills/project/0.12.0/skills/manager-loop/assets/report.schema.json \
  "PROMPT" > EVID/codex-events.jsonl 2> EVID/codex-stderr.log
```

- `PROMPT` is `PACK/cards/README.md`, then the card verbatim, then the live facts (section 6).
- Native Swift cards (Needs include `xcode`; Q10, 2026-11-12): replace the `-s workspace-write` line and the two `sandbox_workspace_write` lines with `-s danger-full-access`, only when `git -C WT status --porcelain --untracked-files=no` prints nothing; otherwise do not dispatch, log it and ask the owner.
  Every other Codex card stays `workspace-write`.
- Cards with no PR (L13, DV): the report schema's `pr` is 0 (L13) or the merged PR's number (DV); `head_sha` is the commit the card names.
- Right after start: read the `thread.started` id from `EVID/codex-events.jsonl`; its rollout under `~/.codex/sessions/2026/11/DD/rollout-*-THREAD.jsonl` must show `cwd` = WT and the expected model and effort; otherwise stop it and dispatch again.
- Write the thread id, model and effort on the Agents row (`MB set BOARD Agents AGENT --new ...`).
- Before each dispatch: `MB card PACK/cards/CARD.md`, `MB spend BOARD "Agents today"`, and the platform row (`"Codex Luna today"` or `"Codex Terra today"`).
  A refused `spend` on a Codex row: never dispatch on Claude instead; ask the parity question (section 12).

### Codex reviewer variant (Q9 Luna second reviewer)

```bash
codex exec -m gpt-6-luna -c model_reasoning_effort=max -s read-only \
  -C /Users/yahya/Documents/git/yooz/remi --json -o EVID/codex-last-message.md \
  "PROMPT" > EVID/codex-events.jsonl 2> EVID/codex-stderr.log
```

No `--output-schema` (the reviewer returns the review JSON of its card).
A Luna reviewer counts against Codex Luna capacity: dispatch it only when the steps `active` on `codex-luna` plus running Luna reviewers number fewer than 2; it spends `"Agents today"` and `"Codex Luna today"`.

### After every full-access run

Record `git ls-remote origin refs/heads/develop` at dispatch.
After the run: if `develop` moved, every new commit must be a merge the manager made (on the board) or a version bump (`chore: bump version to`); anything else stops all dispatching and goes to the owner at once.
Also `gh pr list --state merged --search "merged:>=DISPATCH_TIME"` lists only merges the manager made.

## 6. Live facts added at dispatch

Copied from the board and from `git`/`gh` at dispatch time, never from an earlier prompt:

- `origin/develop` head (`git -C MAIN fetch origin && git -C MAIN rev-parse origin/develop`);
- the PR number and head commit, when the step has a PR;
- for a fix round: the round number, the decided findings with their outcomes, and the line "This card was started earlier. Continue from the worktree: run `git status` and `git log --oneline -10` first.";
- for a reviewer: `Lens group`, `Base` (merge-base), `Head` (the reviewer reads those commits, never a moving worktree), and for delta reviews `Round1Head`;
- the owner answers the card names (Q2 for native cards; while Q2 is open a stall is a stop condition; Q11 and Q12 for L07, L08, L14).

## 7. First tick of a session

1. `date`, then `MB tick BOARD --manager mba-claude-sonnet --state running --next 30m`.
   Refused (another lease): schedule one wake at the printed expiry and stop.
2. Check `lead.md`: `test "$(wc -l < PACK/lead.md)" -le 40 && test "$(wc -c < PACK/lead.md)" -le 3000`.
   If it fails: `MB log BOARD "lead.md over cap"` and `MB propose BOARD "lead prunes lead.md" --why "over the 40-line or 3,000-character cap"`; the next lead wake's brief starts with "Prune lead.md to the cap first".
3. Reconcile: for each step in `active` or `review`, read its PR (`gh pr view N --json headRefOid,state,isDraft,mergeStateStatus`) and its worktree (`git -C WT status --short`, `git -C WT log --oneline -3`); the PR and worktree are right; correct the board and `MB log` it.
   A step with no live worker: dispatch again with the continuation line (section 6).
4. `test -d /Volumes/S1/yooz/remi/locks || mkdir -p /Volumes/S1/yooz/remi/locks`.
5. Ask the questions still `open` on the board in batches of at most four (on 2026-11-12: Q2, Q3, Q7, Q11 to Q15); never re-ask a `closed` one.

## 8. The tick

The skill's tick, with these project rules:

- **Order:** owner answers (section 11), worker reports, reviews, failing checks, conflicts, timeboxes, dates, checkpoints, then fill free slots.
- **CP1 rule:** when L01 to L06 are each `done` or `dropped`, wake the lead for CP1 (go or adjust for L07, L08, L14); when `board-log.md` has the lead's `CP1:` decision, set CP1 `done`.
- **L99 rule:** when L01 to L12, L14 and CP1 are each `done` or `dropped`, set L99 `done`, set A01 to `todo`, set P01 to `todo` once the iPad issue exists (ask the owner to run its command in `PACK/issues-to-file.md`; its number is P01's live fact), and wake the lead for CP2.
- **Dropped dependency:** when a step becomes `dropped`, list every step whose Depends names it; at the next lead wake the lead decides for each (drop it too, or remove the dependency with `MB set ... Depends=...` and a `decide` line); the manager never edits Depends on its own.
- **L09 rule:** dispatch L09 only while no step with Needs `xcode` is in `review`; merge it only while no other step is `active` or `review`.
- **Steps waiting on a question** stay `owner` until the answer.
- **Reviewer concurrency:** before dispatching a Claude reviewer, count Agents rows with Slot `claude-sonnet` and State `running`; dispatch only when fewer than 2.
  Claude reviewers spend `"Agents today"` and `"Claude Sonnet today"`.
- **Big reviews one at a time:** do not start the L07 and L08 round-1 reviews in the same day (risk R5).
- **Xcode lock:** native gates run as `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock COMMAND`; the manager runs no Xcode command itself, except P01's precondition check through the Xcode MCP server.

## 9. The intermittent lead and lead.md

The lead is Claude Opus, woken only for: a checkpoint (`PACK/checkpoints.md`), an advisor ruling that changes a card, two failed approaches on a step, a red `develop`, a dropped dependency, or an outline card to complete.
It is not a standing slot; it spends `"Agents today"` and `"Claude Opus today"`, and while a lead-tier step holds `claude-opus` it waits, unless `develop` is red.

Lead brief (one message):

```text
You are the lead of yooz-labs/remi land-branches-2026-11 (read-only for product code).
Read first: PACK/lead.md, then `MB status BOARD`, then only what this wake names.
Wake reason: CHECKPOINT OR EVENT, with links.
Decide, then: edit cards or the plan only where the decision requires it, in one commit on chore/land-branches-plan; record each decision with `MB decide BOARD "TEXT" --by lead`; rewrite lead.md (format below).
Do not dispatch, merge, or edit the board's Parity, Slots or Budget.
```

**lead.md format and cap (hard):** at most 40 lines and 3,000 characters.
Four sections only: `## Decisions in force`, `## Open risks`, `## Next intentions`, `## Pending owner questions`.
One line per item, starting with its date (`2026-11-14: ...`), newest first within a section.
At every update the lead overwrites or prunes: a resolved risk, a done intention or an answered question leaves the file; history goes to `board-log.md` (`MB log` or `MB decide`), never to lead.md.
The manager checks the cap at the first tick of every session and after every lead wake (section 7, step 2); over the cap it flags as there and briefs no other lead wake until the file is pruned.

## 10. Events

### A worker report arrives

Verify by observation, stop at the first failure (skill, "Verify by observation"):
1. `gh pr view N --json headRefOid,baseRefName` equals the report's head and `develop`.
2. `gh pr diff N --name-only` stays inside the card's Scope (for L07 and L08 also inside their chunk tables, plus files the develop merge brought in).
3. Re-run the card's cheapest non-native Acceptance command, or read the quoted gate output in the evidence folder the card names.
4. Every fix has a revert check or a test that fails without it.
5. Deviations are listed and triaged (accept, send back, or ask the lead).
6. After a full-access run, the `develop` check in section 5.
Then set the step `review` and dispatch its review (plan section 3; for L02, L03 and L09 the form Q13 chose) while CI runs.
If Q13 is still open when L02, L03 or L09 reaches this point, set the step `owner` with Next "waits on Q13" instead.

### A review returns

- Every dispatched reviewer is accounted for. A reviewer silent at 20 minutes is dispatched again once with the same card; silent again, one advisor consult performs that lens itself, read-only. Never proceed with a report missing.
- L07 and L08: the synthesis card starts only when every `contract` chunk report, the cross-chunk report and (L08) both L08-R4 reports are in.
- Every finding starts as `fix`; send the list to the implementer (same worktree; fix-round card = the step's card plus the decided findings).
- Fix-round tier: worker-hard (`codex-terra`) when any accepted finding is Critical or touches authentication, authorization, encryption, data integrity or concurrency; otherwise the step's own tier.
  A step whose implementer was Codex keeps Codex for fixes unless the skill's handover conditions hold (`references/platforms.md`, "Handing a card from one platform to another").
- Proposed rejects of a round: one advisor consult covering all of them; record the ruling with `MB decide` and a PR comment.
- Round 1 substantial (`review-convergence.md` rules 1 to 5): round 2 per [RV-delta](cards/RV-delta.md); for L07 and L08 one delta reviewer per touched chunk.
  Large fixes (rules 2, 3 or 5) go into a fix PR whose base is the step PR's head branch; merging that fix PR needs Q15; a fix PR into a `patch/*` branch gets no native CI (`native-app.yml` runs on PRs into `main`, `develop` and `feature/**`), so its local native gates are the evidence and the step PR's CI reruns after it merges.
  Rule 4 applies to every accepted fix in L03, L06, L08-R4 and L14.

### Checks

- Usual durations: `Test` workers up to 14 minutes, `Build and Test (Native)` 12 to 14 minutes, `local-relay` 64 to 65 minutes when it runs the soak.
  Check at 30 minutes; the relay gate at 75 minutes; a job past twice its usual time is hung: cancel, rerun once, and hand the owner an issue command if `timeout-minutes` is missing.
- Failing because of the diff: two fix attempts, then the advisor with the failing log.
- Failing without the diff (fails on `develop` too, infrastructure, or a known #1634 flake: signal 11 in the test helper, `DirectConnectionDeadlineTests` timing): one `gh run rerun RUN_ID --failed`; then write the log excerpt to `EVID/flake.md` and hand the owner `gh issue comment 1634 --repo yooz-labs/remi --body-file EVID/flake.md` (a #1634 match) or `gh issue create --repo yooz-labs/remi --title TITLE --body-file EVID/flake.md` (anything else); continue other steps.
  The same gate step flaky twice in seven days goes to the lead (diagnosis card).
- No checks on a head: the next push starts them; if none start in 5 minutes, check `gh pr view N --json mergeable` and the path filters; "no checks reported" never counts as passing.

### A merge conflict

The branch's worker merges `origin/develop` into the branch, resolves, reruns its gates and pushes once; never a rebase, never a force-push.
A manual resolution after round 2 already ran (L05 today): one advisor consult reads `git show --cc MERGE_SHA` and rules; no third review round.

### Timebox, silence, usage limit

- Implementer silent 45 minutes (no commit, no event lines): nudge once (Claude) or check the Codex process; then redispatch with an inventory of its files and commits.
- Past twice the timebox: advisor.
- A Codex usage limit or a refused `spend`: write the board, do not move the card to Claude, ask the parity question.

### An owner answer

Apply section 11, `MB decide BOARD "ANSWER" --by owner`, set the question `closed`.

### Merge gate (all must hold; plan 0.4)

1. Every review report dispatched for the step is in (none missing), every finding has an outcome, and every `fix` finding is verified on the final head by its named test or repro (run it, or read the implementer's quoted output for that exact head).
2. No accepted Critical is open.
3. Fresh base: `git -C MAIN fetch origin && git -C MAIN log --format=%s HEAD_SHA..origin/develop` lists only `chore: bump version to ...` subjects; otherwise the worker merges `origin/develop` into the branch and the checks run again.
4. Checks on the final head: `gh pr checks N` lists `CI Scope`, `Lint`, `Type Check`, `Test`, `Spelling`, `Relay Scope` and `local-relay`, each passing or skipping, none pending or failing; a PR that touches `packages/native/` also has `Build and Test (Native)` passing (not skipping); a PR that touches `packages/daemon/`, `packages/shared/`, `packages/signaling/`, `tests/integration/` or `.github/` has `local-relay` passing after more than 55 minutes (the real soak).
5. Closing references: `git -C MAIN log --format=%B origin/develop..HEAD_SHA | bun -e 'import { extractClosingReferences } from "/Users/yahya/Documents/git/yooz/remi/packages/shared/src/issue-closing.ts"; console.log(JSON.stringify(extractClosingReferences(await Bun.stdin.text())))'`, plus the PR title through the same command; for each issue listed that the step does not close on purpose, notify the owner before merging and, after the merge, hand the owner `gh issue reopen N --repo yooz-labs/remi --comment "Reopened: closed by a commit message in PR #PR, not finished."` (known: #1313 from native-images' `40fb479f`).
6. Step extras: L09 needs the owner's phone check (Q1) and the L09 rule; P01 and A03 need the owner's approval; L08 under Q11 option b needs the owner's written sign-off.

Then: `gh pr ready N` if still draft, `gh pr merge N --merge`, `MB set BOARD Steps ID State=done`, close the step's agents, `MB log`.

### After a merge

1. Wait (Monitor, at most 10 minutes) until `gh run list --workflow auto-bump-dev.yml --branch develop --limit 1 --json status,headSha` shows a completed run for the merge and `origin/develop` has the bump commit; no other merge before that.
2. Dispatch [DV](cards/DV-develop-verify.md) on the new tip (worker tier, Needs `xcode`, full access in the detached worktree).
3. DV red: `develop` is red; stop all merges, one advisor consult, then ask the owner: fix forward (the lead writes a card) or revert ([RB](cards/RB-revert-merge.md), dispatched only on the owner's answer).

## 11. Owner questions and what each answer does

Answered on 2026-11-12 and applied: Q1 keep, Q4 fold (suspended by Q11), Q5 park, Q6 fold, Q8 approve (commands only), Q9 yes (L03, L06, L08-R4), Q10 full access for native cards in a clean worktree; defaults approved.
Open: Q2, Q3, Q7, Q11, Q12, Q13, Q14, Q15.

| Q | Answer | Board change |
| --- | --- | --- |
| Q2 Mac test gate | bounded attempt, then hosted | native cards: a timeout or a stall before a test bundle loads is recorded with its log path and the card continues on hosted `swift test` plus local `swift test` |
| | require local | a native step whose Mac test stalls goes `owner` |
| | either answer | L03 and L04 `todo` |
| Q3 #1731 fix | approve | L06 `todo` |
| | not now | L06 `dropped`, branch kept; L08 does not depend on L06 |
| Q7 #1727 files | any answer | the owner acts; L10 `done` when the owner says so; a "push" answer adds a lead wake to decide whether a #1727 card follows |
| Q11 #1313 | a: image-availability alone | L14 `todo`; L08 `dropped` (native-images parked, branch kept, not deleted) |
| | b: native-images dormant | L08 `todo`; L14 `dropped` (folded; branch deleted at L13) |
| Q12 #1720 | park | L07 `dropped` (branch kept); L13 lists it under Kept |
| | land review-only | L07 `todo` |
| Q13 review rounds | a: recorded rounds plus one delta | L02, L03, L09 get one RV-delta review from their recorded head (#1657 `26fbf947`, #1728 `5c1f9380`, #1512 `3a654273`) to the final head; an empty diff needs no review |
| | b: fresh round 1 | plan section 3 panels |
| | c: waive | no review for those three; merge gate items 2 to 6 still apply |
| Q14 Codex rules | install | the owner copies the rules (section 2); the manager confirms with `codex execpolicy check --rules ~/.codex/rules/land-branches-2026-11.rules gh pr merge 1` printing `forbidden` |
| | do not install | rely on the preamble and the section 5 `develop` check |
| Q15 fix-PR merges | yes | the manager may merge a review-fix PR into its step PR's head branch after its delta review and local gates |
| | no | the owner merges fix PRs; the step waits `owner` |

## 12. The parity question

Asked only on a mismatch: a refused model id, a Codex usage limit or refused Codex `spend`, a capability no slot has, or a sandbox denial.
Form: "Update the parity to ... (Recommended) / Move this card to Claude Opus for today / Keep and wait for the reset".

## 13. Never

- Everything in the skill's "Never" list.
- Switch `MAIN`'s branch, or touch a worktree other than the card's (creating it in section 5 is the exception).
- Commit, push or read the contents of the untracked files in `/Volumes/S1/worktrees/remi/store-callback-order`.
- Delete a branch or a worktree, close, reopen, comment on or file an issue: hand the exact commands to the owner.
- Merge into `main`; merge L09 against Q1; merge P01, A03, or L08 under Q11 option b before the owner approves; merge a fix PR without Q15.
- Use the frontier tier anywhere but A02.
- Mark a test as skipped, or loosen a gate, to get a check green.
- Proceed with a review report missing.
