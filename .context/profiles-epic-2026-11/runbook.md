# Runbook: profiles-epic-2026-11

The manager follows this file literally, one tick at a time, with the `project:manager-loop` skill.
Paths below are absolute; `PACK` means `/Volumes/S1/worktrees/remi/profiles-epic-plan/.context/profiles-epic-2026-11`, `BOARD` means `PACK/board.md`, `MAIN` means `/Users/yahya/Documents/git/yooz/remi` (the main checkout, always on `develop`), `DOCSMAIN` means `/Users/yahya/Documents/git/yooz/yooz-docs` (the yooz-docs main checkout, on `main`), `EVID` means `/Volumes/S1/yooz/remi/artifacts/profiles-epic-2026-11/<step>/r<round>/`, and `MB` means `python3 /Users/yahya/.claude/plugins/cache/research-skills/project/0.12.0/skills/manager-loop/scripts/manager_board.py`.

## 1. Where the pack lives

- The pack and board are on branch `chore/profiles-epic-plan` in worktree `/Volumes/S1/worktrees/remi/profiles-epic-plan`.
  `MAIN` stays on `develop`; never switch its branch. `DOCSMAIN` stays on `main`.
- Board commits go to `chore/profiles-epic-plan` only (`docs: board, <what changed>`), locally every tick; push that branch only at checkpoints (`git -C /Volumes/S1/worktrees/remi/profiles-epic-plan push origin chore/profiles-epic-plan`); no CI job runs on a push of that branch.
- Evidence: `EVID` (one folder per dispatch); never in a repository.

## 2. Setup (once, after the owner approves the plan)

```bash
mkdir -p /Volumes/S1/yooz/remi/locks /Volumes/S1/yooz/remi/artifacts/profiles-epic-2026-11
cd /Volumes/S1/worktrees/remi/profiles-epic-plan && bun install
git -C /Users/yahya/Documents/git/yooz/remi fetch origin
git -C /Users/yahya/Documents/git/yooz/remi worktree add --detach /Volumes/S1/worktrees/remi/profiles-develop-verify origin/develop
cd /Volumes/S1/worktrees/remi/profiles-develop-verify && bun install --frozen-lockfile
```

Owner-run, optional (as land-branches Q14): `cp /Volumes/S1/worktrees/remi/profiles-epic-plan/.context/profiles-epic-2026-11/codex-profiles.rules ~/.codex/rules/profiles-epic-2026-11.rules`; when the loop ends, `rm ~/.codex/rules/profiles-epic-2026-11.rules`.
Whether `codex exec` loads that file, and applies it under `-s danger-full-access`, is unverified; the manager's checks after every run (section 5) stay in force either way.
**CP0 recording (before the first tick).** After the owner approves the plan and answers J1a to J18 (plan section 7), the lead or the owner records one line per answer and the approval, then closes CP0:

```bash
MB decide BOARD "CP0: J1a answered: ANSWER" --by owner      # one line per judgment call, J1a to J18
MB decide BOARD "CP0: plan approved with the answers above" --by owner
MB set BOARD Steps CP0 State=done
```

Then the `/loop` start prompt (plan 0.1).
Optional live view (port 8765 belongs to the remi daemon; use 8799): `nohup python3 /Users/yahya/.claude/plugins/cache/research-skills/project/0.12.0/skills/manager-loop/scripts/manager_board.py serve /Volumes/S1/worktrees/remi/profiles-epic-plan/.context/profiles-epic-2026-11/board.md --port 8799 > /tmp/profiles-board-serve.log 2>&1 & disown`.

## 3. What to read

- Every tick: `PACK/lead.md` first, then `MB status BOARD`, then only the events it points to.
- First tick of a session, once: this runbook, `PACK/queue.md`, `PACK/checkpoints.md`, `PACK/risks.md`, `PACK/owner-gates.md`, `PACK/cards/README.md`.
- Never: the whole `board-log.md`, whole evidence folders, or a whole diff larger than the card's scope.

## 4. Tools

| Need | How |
| --- | --- |
| Codex worker | section 5, run in the background (`run_in_background: true`) |
| Claude worker (on `claude-sonnet` or `claude-opus`) | Agent tool: `model: sonnet` (effort high) or `model: opus` (effort xhigh), `run_in_background: true`, `description: "impl P1A"`; prompt = preamble + card + live facts; the manager creates the worktree first; no `isolation` parameter |
| Reviewer, delta reviewer | Agent tool: `subagent_type: project:pr-review-toolkit`, `model: sonnet`, `effort: xhigh`, `run_in_background: true`, `description: "rv P1A privacy"` (step and lens) |
| Lead wake, advisor | Agent tool: `model: opus`, `effort: xhigh`, `run_in_background: true`, `description` naming the wake; brief per section 9 or `references/escalation.md` |
| Message a live Claude agent | SendMessage |
| Ask the owner | `MB ask` first, then AskUserQuestion (at most 4 questions per call) |
| Notify | PushNotification, at most one per event class per day |
| Wait | Monitor with a time limit; never an unbounded poll |
| Wake | ScheduleWakeup: 1800 s while workers run, 3600 s while waiting on people; `stop: true` when the board is `done` or `paused` |

Agent tool model values are only `sonnet`, `opus`, `haiku` and `fable`; there is no `name` parameter.
Reviewers, the advisor and lead wakes are extra to the worker slots (owner, 2026-11-13).

## 5. Worktrees and dispatch

### Worktrees (the manager creates them before dispatch)

| Case | Command | Steps |
| --- | --- | --- |
| New branch in remi | `git -C MAIN fetch origin && git -C MAIN worktree add -b BRANCH WT origin/develop`, then `cd WT && bun install` | every implementation step: branch and worktree are on its card (P1A `feature/issue-1748-profile-model` in `/Volumes/S1/worktrees/remi/profiles-p1a`, P1C `docs/issue-1748-codex-credentials` in `.../profiles-p1c`, P1B `feature/issue-1748-profile-launch` in `.../profiles-p1b`, and so on) |
| Docs branch in yooz-docs | no open profiles docs PR: `git -C DOCSMAIN fetch origin && git -C DOCSMAIN worktree add -b docs/remi-profiles /Volumes/S1/worktrees/yooz-docs-profiles origin/main`; an open one: reuse its worktree (check `git -C DOCSMAIN worktree list`); then `cd /Volumes/S1/worktrees/yooz-docs-profiles && bun install` | DOCS-P1 to DOCS-P4, REL-DOCS |
| Docs build of remi (detached) | first time `git -C MAIN worktree add --detach /Volumes/S1/worktrees/remi/profiles-docs-build DEV_SHA`; later `git -C /Volumes/S1/worktrees/remi/profiles-docs-build fetch origin && git -C /Volumes/S1/worktrees/remi/profiles-docs-build checkout --detach DEV_SHA` (or the release tag for REL-DOCS) | DOCS steps, REL-DOCS |
| Detached verify | created in setup; the DV card updates it | DV |
| Read-only | no worktree; reviewers read by hash with `git -C MAIN` (or `git -C DOCSMAIN`) | every reviewer |

A worktree is removed only after its step merged (owner authority, 2026-11-13): `git -C WT status --porcelain` empty, the branch merged, then `git -C MAIN worktree remove WT`, delete the local branch, and delete `/Volumes/S1/derived/remi-<worktree name>` if this plan created it; never `--force`, never another plan's worktree.

### Codex worker command

Model by tier: worker `gpt-6-luna` with `model_reasoning_effort=max`; worker-hard `gpt-6.1-terra` with `model_reasoning_effort=xhigh`.
`WT` is the card's worktree, `GITDIR` is `git -C WT rev-parse --git-dir`.

```bash
codex exec -m gpt-6-luna -c model_reasoning_effort=max \
  -s workspace-write \
  -c 'sandbox_workspace_write.writable_roots=["GITDIR","/Volumes/S1/derived","/Volumes/S1/yooz/remi/locks","/Volumes/S1/yooz/remi/artifacts/profiles-epic-2026-11"]' \
  -c sandbox_workspace_write.network_access=true \
  -C WT --json -o EVID/codex-last-message.md \
  --output-schema /Users/yahya/.claude/plugins/cache/research-skills/project/0.12.0/skills/manager-loop/assets/report.schema.json \
  "PROMPT" > EVID/codex-events.jsonl 2> EVID/codex-stderr.log
```

- `PROMPT` is `PACK/cards/README.md`, then the card verbatim, then the live facts (section 6).
- A docs step adds `/Volumes/S1/worktrees/remi/profiles-docs-build` and the yooz-docs worktree's git directory to `writable_roots` and runs with `-C /Volumes/S1/worktrees/yooz-docs-profiles`.
- Full access (owner answers Q10 and Q18 of land-branches-2026-11, carried over by plan J1): replace the `-s workspace-write` line and the two `sandbox_workspace_write` lines with `-s danger-full-access` for native cards (Needs `xcode`) and for any card whose previous run was blocked by a sandbox denial (an `EPERM` or "Operation not permitted" in its log), only when `git -C WT status --porcelain --untracked-files=no` prints nothing; otherwise do not dispatch, log it and ask the owner.
- Right after start: read the `thread.started` id from `EVID/codex-events.jsonl`; its rollout under `~/.codex/sessions/2026/MM/DD/rollout-*-THREAD.jsonl` must show `cwd` = WT and the expected model and effort; otherwise stop it and dispatch again.
- Write the thread id, model and effort on the Agents row (`MB set BOARD Agents AGENT --new ...`).
- Before each dispatch: `MB card PACK/cards/CARD.md` (must print "ready to dispatch"; reviewer and DV cards included).
- **Spend (every agent dispatch):** implementers, fix rounds, DV, reviewers, delta reviewers, lead wakes and advisor consults each run `MB spend BOARD "Agents today"` and their platform row (`"Codex Luna today"`, `"Codex Terra today"`, `"Claude Sonnet today"` or `"Claude Opus today"`); lead wakes and advisor consults also run `MB spend BOARD "Advisor consults"`.
  A refused `spend`: stop dispatching on that row and ask the owner (the skill's rule), unless `board-log.md` holds the owner's `decide` line recording J1b option 2; then repeat it with `--over` and `MB log BOARD "over: ITEM n/limit"`, until the ceiling (a row's Used reaches twice its Limit, or the third consecutive day with any row over), where the manager stops dispatching and asks. `Advisor consults` and `Fable consults` never take `--over`.
  A Codex usage limit: write the board and ask the parity question (section 12); never move a card to Claude on your own, unless the owner's standing rule of 2026-11-13 (both platforms' slots are used) already allows that card's tier on a free Claude slot, which `MB status` shows.

### After every worker run (Codex or Claude)

1. `develop` check: record `git ls-remote origin refs/heads/develop` at dispatch; after the run, every new commit on `develop` must be a merge the manager made or a version bump (`chore: bump version to`); `gh pr list --repo yooz-labs/remi --state merged --search "merged:>=DISPATCH_TIME"` lists only merges the manager made. Anything else stops all dispatching and goes to the owner at once.
2. Real-state check: record `stat -f '%N %m %z' ~/.remi/config.toml ~/.claude/settings.json ~/.codex/config.toml 2>&1` at dispatch (metadata only, never the contents) and compare after the run; a change goes to the owner as a question (the owner's own work may have caused it), and dispatching of profile steps pauses until the answer.
3. Issues: `gh issue list --repo yooz-labs/remi --state closed --search "closed:>=DISPATCH_TIME"` lists no issue this plan did not close on purpose.

## 6. Live facts added at dispatch

Copied from the board and from `git`/`gh` at dispatch time, never from an earlier prompt:

- `origin/develop` head (`git -C MAIN fetch origin && git -C MAIN rev-parse origin/develop`), and for docs steps `DEV_SHA` (the develop tip containing the phase's merge and its bump) or the release tag;
- the PR number and head commit, when the step has a PR; the open profiles docs PR and its branch, for docs steps;
- for a fix round: the round number, the decided findings with their outcomes, and the line "This card was started earlier. Continue from the worktree: run `git status` and `git log --oneline -10` first.";
- for a reviewer: repository, `Lens group`, `Base` (merge-base), `Head` (the reviewer reads those commits, never a moving worktree), and for delta reviews `Round1Head`;
- the owner answers the card names (J9 for P1B, J11 for P1A and P1B, J4 for docs cards).

## 7. First tick of a session

1. `date`, then `MB tick BOARD --manager mba-claude-sonnet --state running --next 30m`.
   Refused (another lease): schedule one wake at the printed expiry and stop.
2. Check `lead.md`: `test "$(wc -l < PACK/lead.md)" -le 40 && test "$(wc -c < PACK/lead.md)" -le 3000`.
   If it fails: `MB log BOARD "lead.md over cap"` and `MB propose BOARD "lead prunes lead.md" --why "over the 40-line or 3,000-character cap"`; the next lead wake's brief starts with "Prune lead.md to the cap first".
3. Reconcile: for each step in `active` or `review`, read its PR (`gh pr view N --repo REPO --json headRefOid,state,isDraft,mergeStateStatus`) and its worktree (`git -C WT status --short`, `git -C WT log --oneline -3`); the PR and worktree are right; correct the board and `MB log` it.
   A step with no live worker: dispatch again with the continuation line (section 6).
4. `test -d /Volumes/S1/yooz/remi/locks || mkdir -p /Volumes/S1/yooz/remi/locks`.
5. Ask the questions still `open` on the board in batches of at most four; never re-ask a `closed` one.

## 8. The tick

The skill's tick, with these project rules:

- **Order:** owner answers (section 11), worker reports, reviews, failing checks, conflicts, timeboxes, dates, checkpoints and owner gates, then fill free slots.
- **Not before approval:** a manager that finds CP0 in state `owner`, or no line starting `CP0: plan approved` in `board-log.md`'s Decisions, dispatches nothing, asks the owner for approval of the plan (one question, `MB ask BOARD Q-CP0 --question "Approve the profiles epic plan and answer J1a to J18?" --options "Approve with answers / Hold" --default none`), and stops that tick after writing the board.
- **Rule steps** (CP*, CPA*, OG-*, D51, REL-DOCS) are never dispatched by `status`; they start `blocked` with their trigger in Next:
  - a checkpoint whose Depends are all `done`: wake the lead (section 9) with the checkpoint's row in `PACK/checkpoints.md`; when `board-log.md` holds the lead's decision line for that checkpoint (for example `CP1:`) and the owner's go (recorded `--by owner`), set it `done`; the lead's completed cards turn their steps from `outline` to `todo` (the lead sets them with `MB set`).
  - an owner gate whose Depends are `done`: set it `owner`, notify the owner once with its section of `PACK/owner-gates.md`, and record the owner's result with `decide ... --by owner`; then `done` (passed) or ask the lead for a fix card (failed).
  - D51: stays `owner` until the owner approves PR #1785; then run the merge gate for a docs PR (section 10) and merge it; `done`.
  - REL-DOCS: when the owner says a release that ships a profile phase is published, dispatch [REL-DOCS](cards/REL-DOCS-release-recheck.md), then merge the docs PR (section 10, "Release docs").
- **Parked steps:** P5, P5B, P6 and A5 are `blocked` with Next starting "parked"; never dispatch them, and never write cards for them; CP5 decides whether a new plan starts.
- **Outline steps** are never dispatched; `MB card` refuses them.
- **Native lane:** at most one step with Needs `xcode` is `active` at a time, besides DV; a visible simulator run needs the owner's announced consent each time (plan J10) and a stop file (`/Volumes/S1/yooz/remi/gui-fixture/STOP` halts it).
- **Docs lane:** one docs step at a time; the profiles docs PR stays a draft until REL-DOCS.
  A DOCS-Pn step is `done` when merge gate items 1, 2 and 4 hold for its **draft** docs PR and its `docs` review is resolved; the PR stays a draft and is not merged; log `DOCS-Pn verified, PR N draft, merges at REL-DOCS`. The merge happens only in section 10, "Release docs". This is what CP1 to CP4 wait for, so no checkpoint waits on a release.
- **Phase completion:** when every step of a phase is `done` and its owner gate passed, hand the owner the close command for that phase's issue (or close it under the owner's authority of 2026-11-13 after the owner says so): `gh issue close N --repo yooz-labs/remi --comment "Done: PRs #A, #B; owner gate passed DATE."`; app issues likewise after their slice merges and any owner gate passed.
- **Steps waiting on a question** stay `owner` until the answer.

## 9. The intermittent lead and lead.md

The lead is Claude Opus, woken only for: a checkpoint (`PACK/checkpoints.md`), an advisor ruling that changes a card, two failed approaches on a step, a red `develop`, a dropped dependency, an owner answer that contradicts a card, or a failed owner gate.
It is not a standing slot (owner, 2026-11-13: lead and advisor are extra to the worker slots); it spends `"Agents today"`, `"Claude Opus today"` and `"Advisor consults"` (section 5, "Spend"; `Advisor consults` never takes `--over`).

Lead brief (one message):

```text
You are the lead of yooz-labs/remi profiles-epic-2026-11 (read-only for product code).
Read first: PACK/lead.md, then `MB status BOARD`, then only what this wake names.
Wake reason: CHECKPOINT OR EVENT, with links.
Decide, then: edit cards or the plan only where the decision requires it, in one commit on chore/profiles-epic-plan; re-verify every path and line a card you complete cites against the current origin/develop; run `MB card` on each completed card; record each decision with `MB decide BOARD "TEXT" --by lead`; rewrite lead.md (format below).
Do not dispatch, merge, or edit the board's Parity, Slots or Budget.
```

**lead.md format and cap (hard):** at most 40 lines and 3,000 characters.
Four sections only: `## Decisions in force`, `## Open risks`, `## Next intentions`, `## Pending owner questions`.
One line per item, starting with its date (`2026-11-14: ...`), newest first within a section.
At every update the lead overwrites or prunes: a resolved risk, a done intention or an answered question leaves the file; history goes to `board-log.md` (`MB log` or `MB decide`), never to lead.md.

## 10. Events

### A worker report arrives

Verify by observation, stop at the first failure (skill, "Verify by observation"):
1. `gh pr view N --repo REPO --json headRefOid,baseRefName` equals the report's head and base (`develop`, or `main` for yooz-docs).
2. `gh pr diff N --repo REPO --name-only` stays inside the card's Scope.
3. Re-run the card's cheapest non-native Acceptance command in its worktree, or read the quoted gate output in `EVID`.
4. Every fix has a revert check or a test that fails without it (the cards name the revert checks).
5. Deviations are listed and triaged (accept, send back, or ask the lead).
6. The checks of section 5, "After every worker run".
Then set the step `review` and dispatch its round-1 panel (plan section 3) while CI runs.

### A review returns

- Every dispatched reviewer is accounted for. A reviewer silent at 20 minutes is dispatched again once with the same card; silent again, one advisor consult performs that lens itself, read-only. Never proceed with a report missing.
- Every finding starts as `fix`; send the list to the implementer (same worktree; fix-round card = the step's card plus the decided findings).
- Fix-round tier: worker-hard when any accepted finding is Critical or touches credentials, privacy, authorization or data integrity; otherwise the step's own tier. A step keeps its platform for fixes unless the skill's handover conditions hold (`references/platforms.md`).
- Proposed rejects of a round: one advisor consult covering all of them; record the ruling with `MB decide` and a PR comment.
- A contested finding on a credential, privacy, authorization or data-integrity path: advisor before any fix.
- Round 1 substantial (`review-convergence.md` rules 1 to 5): one [RV-delta](cards/RV-delta.md) round; large fixes may go into a fix PR whose base is the step PR's head branch, merged there only, after the same gate; never a third round.

### Checks

- Usual durations: `Test` workers up to 15 minutes, `Build and Test (Native)` 12 to 14 minutes, `local-relay` 64 to 65 minutes when it runs the soak.
  Check at 30 minutes; the relay gate at 75 minutes; a job past twice its usual time is hung: cancel, rerun once, and hand the owner an issue command if `timeout-minutes` is missing.
- Failing because of the diff: two fix attempts, then the advisor with the failing log.
- Failing without the diff (fails on `develop` too, infrastructure, or a known #1634 flake): one `gh run rerun RUN_ID --failed`; then write the excerpt to `EVID/flake.md` and file it (`gh issue comment 1634 --repo yooz-labs/remi --body-file EVID/flake.md` for a #1634 match, else `gh issue create --repo yooz-labs/remi --title TITLE --body-file EVID/flake.md`); continue other steps. The same gate step flaky twice in seven days goes to the lead (diagnosis card).
- No checks on a head: the next push starts them; if none start in 5 minutes, check `gh pr view N --json mergeable` and the path filters; "no checks reported" never counts as passing.

### A merge conflict

The branch's worker merges `origin/develop` into the branch, resolves, regenerates fixtures if a protocol file conflicted, reruns its gates and pushes once; never a rebase, never a force-push.
A manual resolution after round 2 already ran: one advisor consult reads `git show --cc MERGE_SHA` and rules; no third review round.

### Timebox, silence, usage limit

- Implementer silent 45 minutes (no commit, no event lines): nudge once (Claude) or check the Codex process; then redispatch with an inventory of its files and commits.
- Past twice the timebox: advisor.
- A Codex usage limit: write the board and ask the parity question.

### An owner answer

Apply section 11, `MB decide BOARD "ANSWER" --by owner`, set the question `closed`.

### Merge gate (all must hold; plan 0.4)

1. Every review report dispatched for the step is in, every finding has an outcome, and every `fix` finding is verified on the final head by its named test or repro; the delta review (if one ran) is clean or its findings are resolved the same way.
2. No accepted Critical is open.
3. Fresh base: `git -C MAIN fetch origin && git -C MAIN log --format=%s HEAD_SHA..origin/develop` lists only `chore: bump version to ...` subjects; otherwise the worker merges `origin/develop` into the branch and the checks run again.
4. Checks on the final head: `gh pr checks N --repo yooz-labs/remi` lists `CI Scope`, `Lint`, `Type Check`, `Test`, `Spelling`, `Relay Scope` and `local-relay`, each passing or skipping, none pending or failing; a PR touching `packages/native/` also has `Build and Test (Native)` passing (not skipping); a PR touching `packages/daemon/`, `packages/shared/`, `packages/signaling/`, `tests/integration/` or `.github/` has `local-relay` passing after more than 55 minutes (the real soak). A yooz-docs PR: every check `gh pr checks N --repo yooz-labs/yooz-docs` lists passes.
5. Closing references: `git -C MAIN log --format=%B origin/develop..HEAD_SHA | bun -e 'import { extractClosingReferences } from "/Users/yahya/Documents/git/yooz/remi/packages/shared/src/issue-closing.ts"; console.log(JSON.stringify(extractClosingReferences(await Bun.stdin.text())))'` prints `[]`, and the PR title and body through the same command print `[]`; anything else goes to the owner before the merge (the card forbids closing words, so a hit is also a send-back finding).
6. Step extras: P4A needs the owner's latency measurement recorded in its PR (J7); D51 needs the owner's approval; a yooz-docs profiles PR is never merged by this gate: for a DOCS step, items 1, 2 and 4 on the draft PR make the step `done` (section 8, "Docs lane"); the merge is section 10, "Release docs".

Then: `gh pr ready N --repo REPO` if still draft, `gh pr merge N --repo REPO --merge --match-head-commit HEAD_SHA`, `MB set BOARD Steps ID State=done`, close the step's agents, `MB log`.
A merge the host refuses: never retry or work around it; set the step `owner` and ask.

### After a merge

1. Wait (Monitor, at most 10 minutes) until `gh run list --repo yooz-labs/remi --workflow auto-bump-dev.yml --branch develop --limit 1 --json status,headSha` shows a completed run for the merge and `origin/develop` has the bump commit; no other merge before that.
2. Dispatch [DV](cards/DV-develop-verify.md) on the new tip (worker tier, Needs `xcode`, full access in the detached worktree).
3. DV red: `develop` is red; stop all merges, one advisor consult, then ask the owner: fix forward (the lead writes a card) or revert ([RB](cards/RB-revert-merge.md), dispatched only on the owner's answer).
4. Remove the step's worktree as section 5 says, once DV is green.

### Release docs

When the owner says a remi release that ships one or more profile phases is published (the tag exists on `origin`): dispatch REL-DOCS; on its verified report, one `docs` reviewer on the recheck commit if it changed the pages; then the yooz-docs merge gate (items 1, 2 and 4 above, with `--repo yooz-labs/yooz-docs`) and `gh pr ready N --repo yooz-labs/yooz-docs`.
yooz-docs deploys to a public site on merge, so by default the manager does not merge it: notify the owner with the exact command `gh pr merge N --repo yooz-labs/yooz-docs --merge --match-head-commit HEAD_SHA`, set REL-DOCS `owner`, and set it `done` when `gh pr view N --repo yooz-labs/yooz-docs --json state` shows `MERGED` (plan J2, recommended no). Only if the owner answered J2 yes does the manager run that command itself.

## 11. Owner questions and what each answer does

At CP0 the owner answers J1 to J12 (plan section 7); the manager records each with `decide ... --by owner`.

| J | Answer | Board or card change |
| --- | --- | --- |
| J1a defaults | yes | none; the sandbox rule of section 5 applies |
| J1b budgets | option 1 | the owner edits the Budget limits; a refused `spend` stops that row and asks |
| | option 2 | the `decide` line enables `--over` within the ceiling (section 5, "Spend") |
| | changed | the owner edits Parity, Slots or Budget; the manager runs `MB check` and logs it |
| J2 yooz-docs merge | no (recommended) | REL-DOCS ends with the merge command handed to the owner (section 10, "Release docs") |
| | yes | the manager merges the docs PR after the REL-DOCS recheck and the yooz-docs merge gate |
| J3 release grouping | as recommended | the lead writes the grouping into `lead.md`; the manager tells the owner at each release which phases are complete |
| J4 docs paths | keep | none |
| | other paths | lead wake: change DOCS cards and the app slices' link targets before DOCS-P1 is dispatched |
| J5 #1785 | yes | D51 merges after the approval |
| | no | lead wake at CP1: phase 2 cards cite ADR 0051 on its branch |
| J6 phase 2 during OG-P1 | yes | CP1 does not wait for OG-P1 |
| | no | CP1 Depends gains OG-P1 (the lead sets it) |
| J7 P4A merge | wait | merge gate item 6 |
| | ship unregistered | lead wake at CP3: P4A's card changes |
| J8 phases 3 and 4 | serial | none |
| | parallel | lead wake at CP2: P4A's Depends becomes CP2 and the collision rule of queue.md applies |
| J9 resume protection | sidecar | none |
| | gate only | lead wake: P1B design item 4 changes before P1B is dispatched |
| J10 visual gate | as recommended | each app slice's visual capture is announced to the owner before it starts |
| J11 Codex store write | yes | lead wake after P1C reports "not separated": a small card for `remi profile add` |
| | no | none |
| J12 ADR note | yes | the CP1 lead adds it to the ADR 0049 amendment commit |

## 12. The parity question

Asked only on a mismatch: a refused model id, a Codex usage limit, a capability no slot has, or a sandbox denial that the full-access rule of section 5 does not cover.
Form: "Update the parity to ... (Recommended) / Move this card to Claude for today / Keep and wait for the reset".

## 13. Never

- Everything in the skill's "Never" list.
- Switch `MAIN`'s or `DOCSMAIN`'s branch, or touch a worktree other than the card's (creating and, after a merge, removing it as section 5 says are the exceptions).
- Dispatch before CP0, an outline step, a parked step, or a rule step.
- Touch the owner's real hub (ports 18765 to 18769), its session daemons, `/private/tmp/claude-501`, `~/.appstoreconnect`, or signal a process the manager did not start.
- Run a login, read a credential, or start a visible GUI run without the owner's announced consent.
- Merge into `main`; merge a yooz-docs PR (it publishes a public site; the owner merges, unless the owner answered J2 yes, and never before REL-DOCS); merge P4A before the owner's latency measurement; merge a fix PR anywhere but its step PR's head branch.
- Upload to TestFlight without the owner's go and a build number above the real current one (the owner gives the number).
- Deploy anything under `packages/signaling/` (the owner redeploys).
- Use the frontier tier unless the owner asks.
- Mark a test as skipped, or loosen a gate, to get a check green.
- Proceed with a review report missing, or start a third review round.
