# Runbook: land-branches-2026-11

The manager follows this file literally, one tick at a time, with the `project:manager-loop` skill.
Paths below are absolute; `PACK` means `/Volumes/S1/worktrees/remi/land-branches-plan/.context/land-branches-2026-11`, `BOARD` means `PACK/board.md`, and `MB` means `python3 /Users/yahya/.claude/plugins/cache/research-skills/project/0.12.0/skills/manager-loop/scripts/manager_board.py`.

## 1. Where the pack lives

- The pack and board are on branch `chore/land-branches-plan` in worktree `/Volumes/S1/worktrees/remi/land-branches-plan`.
  The main checkout `/Users/yahya/Documents/git/yooz/remi` stays on `develop`; never switch its branch.
- Board commits go to `chore/land-branches-plan` only (`docs: board, <what changed>`), locally every tick; push that branch only at checkpoints (`git -C /Volumes/S1/worktrees/remi/land-branches-plan push origin chore/land-branches-plan`); no CI job runs on a push of that branch.
- Evidence: `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/<step>/r<round>/` (one folder per dispatch); never in the repository.

## 2. Setup (once, before the first tick)

The owner runs, after approving the plan:

```bash
git -C /Users/yahya/Documents/git/yooz/remi worktree remove /private/tmp/claude-501/-Users-yahya-Documents-git-yooz-remi/4a896ae1-b937-4436-9997-64e23e8a81fb/scratchpad/wt-plan
git -C /Users/yahya/Documents/git/yooz/remi worktree add /Volumes/S1/worktrees/remi/land-branches-plan chore/land-branches-plan
mkdir -p /Volumes/S1/yooz/remi/locks /Volumes/S1/yooz/remi/artifacts/land-branches-2026-11
```

Then the pack review (plan Appendix A), then the `/loop` start prompt (plan 0.1).
Optional live view: `nohup MB serve BOARD --port 8765 > /tmp/board-serve.log 2>&1 & disown`.

## 3. What to read

- Every tick: `PACK/lead.md` first, then `MB status BOARD`, then only the events it points to.
- First tick of a session, once: this runbook, `PACK/queue.md`, `PACK/checkpoints.md`, `PACK/risks.md`, `PACK/cards/README.md`.
- Never: the whole `board-log.md`, whole evidence folders, or a whole diff of L07 or L08.

## 4. Tools

| Need | How |
| --- | --- |
| Codex worker | the command in section 5, run in the background with `run_in_background: true` |
| Claude reviewer or synthesis | Agent tool, `subagent_type: project:pr-review-toolkit`, `model: sonnet`, `run_in_background: true`, name `rv-<step>-<chunk or lens>` |
| Lead wake, advisor | Agent tool, `model: opus`, `run_in_background: true`; brief per section 9 or `references/escalation.md` |
| A02 Fable advisor | Agent tool, `model: claude-fable-5-2`, `run_in_background: true` (owner-requested, A02 only) |
| Message a live Claude agent | SendMessage |
| Ask the owner | `MB ask` first, then AskUserQuestion (at most 4 questions per call) |
| Notify | PushNotification, at most one per event class per day |
| Wait | Monitor with a time limit; never an unbounded poll |
| Wake | ScheduleWakeup: 1800 s while workers run, 3600 s while waiting on people; `stop: true` when the board is `done` or `paused` |

## 5. Dispatching a Codex worker

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
- If Q10 says full access for native cards, replace the `-s workspace-write` line and the two `sandbox_workspace_write` lines with `-s danger-full-access` for steps whose Needs include `xcode`.
- Right after start: read the `thread.started` id from `EVID/codex-events.jsonl`; its rollout under `~/.codex/sessions/2026/11/<dd>/rollout-*-<thread id>.jsonl` must show `cwd` = WT, the expected model and effort; otherwise stop it and dispatch again.
- Write the thread id, model and effort on the Agents row (`MB set BOARD Agents <name> --new ...`).
- Before each dispatch: `MB card PACK/cards/<card>.md`, `MB spend BOARD "Agents today"`, and the platform row (`"Codex Luna today"` or `"Codex Terra today"`).
  A refused `spend` on a Codex row: do not dispatch on Claude instead; ask the parity question (section 12).

## 6. Live facts added at dispatch

Copied from the board and from `git`/`gh` at dispatch time, never from an earlier prompt:

- `origin/develop` head (`git -C /Users/yahya/Documents/git/yooz/remi fetch origin && git -C /Users/yahya/Documents/git/yooz/remi rev-parse origin/develop`);
- the PR number and head commit, when the step has a PR;
- for a fix round: the round number, the decided findings with their outcomes, and the line "This card was started earlier. Continue from the worktree: run `git status` and `git log --oneline -10` first.";
- for a reviewer: `Lens group: <name>`, `Base: <merge-base sha>`, `Head: <head sha>` (the reviewer reads those commits, never a moving worktree);
- the owner answers that the card names (Q2, Q10 for native cards; Q9 for reviews).

## 7. First tick of a session

1. `date`, then `MB tick BOARD --manager mba-claude-sonnet --state running --next 30m`.
   Refused (another lease): schedule one wake at the printed expiry and stop.
2. Check `lead.md`: `test "$(wc -l < PACK/lead.md)" -le 40 && test "$(wc -c < PACK/lead.md)" -le 3000`.
   If it fails: `MB log BOARD "lead.md over cap"` and `MB propose BOARD "lead prunes lead.md" --why "over the 40-line or 3,000-character cap"`; the next lead wake's brief starts with "Prune lead.md to the cap first"; keep reading the file meanwhile.
3. Reconcile: for each step in `active` or `review`, read its PR (`gh pr view N --json headRefOid,state,isDraft,mergeStateStatus`) and its worktree (`git -C WT status --short`, `git -C WT log --oneline -3`); the PR and worktree are right; correct the board and `MB log` the correction.
   A step with no live worker: dispatch again with the continuation line (section 6).
4. `test -d /Volumes/S1/yooz/remi/locks || mkdir -p /Volumes/S1/yooz/remi/locks`.
5. First session only: if the Questions table is empty, record Q1 to Q10 (section 11) and ask them in three batches.

## 8. The tick

The skill's tick, with these project rules:

- **Order inside one tick:** owner answers (apply the mapping in section 11), worker reports, reviews, failing checks, conflicts, timeboxes, dates, checkpoints, then fill free slots.
- **L99 rule:** when every step L01 to L12 (L10 included) is `done` or `dropped`, set L99 `done` (`MB set BOARD Steps L99 State=done`), set A01 to `todo`, set P01 to `todo` once the iPad issue exists (ask the owner to run its command in `PACK/issues-to-file.md`; its number is P01's live fact), and wake the lead for CP2 (section 9).
- **Steps waiting on a question** stay `owner` until the answer; never dispatch them earlier.
- **Reviewer concurrency:** before dispatching a reviewer or synthesis agent, count Agents rows with Slot `claude-sonnet` and State `running`; dispatch only when fewer than 2; otherwise leave it queued for the next tick.
  Reviewers spend `"Agents today"` and `"Claude Sonnet today"`.
- **Xcode lock:** native gates run as `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock <command>`; two native implementers may be active at once; they queue only on the lock.
  The manager runs no Xcode command itself, except P01's precondition check through the Xcode MCP server.

## 9. The intermittent lead and lead.md

The lead is Claude Opus, woken only for: a checkpoint (`PACK/checkpoints.md`), an advisor ruling that changes a card, two failed approaches on a step, a red `develop` after a merge, or an outline card to complete.
It is not a standing slot; it spends `"Agents today"` and `"Claude Opus today"`, and in the late phases it waits for a free Opus session (the `claude-opus` slot) unless `develop` is red.

Lead brief (one message):

```text
You are the lead of yooz-labs/remi land-branches-2026-11 (read-only for product code).
Read first: PACK/lead.md, then `MB status BOARD`, then only what this wake names.
Wake reason: <checkpoint or event>, with links.
Decide, then: edit cards or the plan only where the decision requires it, in one commit on chore/land-branches-plan; record each decision with `MB decide BOARD "<text>" --by lead`; rewrite lead.md (format below).
Do not dispatch, merge, or edit the board's Parity, Slots or Budget.
```

**lead.md format and cap (hard):** at most 40 lines and 3,000 characters.
Four sections only: `## Decisions in force`, `## Open risks`, `## Next intentions`, `## Pending owner questions`.
One line per item, starting with its date (`2026-11-14: ...`), newest first within a section.
At every update the lead overwrites or prunes: a resolved risk, a done intention or an answered question leaves the file; history goes to `board-log.md` (`MB log` or `MB decide`), never to lead.md.
The manager checks the cap at the first tick of every session and after every lead wake (the command in section 7, step 2); over the cap it flags as in section 7 and does not brief a new lead wake on anything else until the file is pruned.

## 10. Events

### A worker report arrives

Verify by observation, stop at the first failure (skill, "Verify by observation"):
1. `gh pr view N --json headRefOid,baseRefName` equals the report's head and `develop`.
2. `gh pr diff N --name-only` stays inside the card's Scope (for L07 and L08 also inside the file list of their chunk table, plus files the develop merge brought in).
3. Re-run the card's Acceptance command that is cheapest and not native, or read the quoted gate output in the evidence folder the card names.
4. Every fix has a revert check or a test that fails without it.
5. Deviations are listed and triaged (accept, send back, or ask the lead).
Then set the step `review` and dispatch round 1 (plan section 3) while CI runs.

### A review returns

- Record each reviewer's status; every dispatched reviewer is accounted for (a silent one at 20 minutes: proceed with the reports received and record the missing lens).
- For L07 and L08: when all 8 chunk reports are in, dispatch the synthesis card; outcomes start from its list.
- Every finding starts as `fix`; send the list to the implementer (same worktree, fix round card = the step's card plus the decided findings).
- Fix-round tier: worker-hard (`codex-terra`) when any accepted finding is Critical or touches authentication, authorization, encryption, data integrity or concurrency; otherwise the step's own tier.
  A step whose implementer was Codex keeps Codex for fixes unless the skill's handover conditions hold (`references/platforms.md`, "Handing a card from one platform to another").
- Proposed rejects of a round: one advisor consult covering all of them; record the ruling with `MB decide` and a PR comment.
- Round 1 substantial (`review-convergence.md` rules 1 to 5): round 2 with one Sonnet reviewer on the fix commits, brief from [RV-delta](cards/RV-delta.md).
  Rule 4 (authorization, encryption, data integrity, concurrency) applies to every accepted fix in L03, L06 and L08-R4.

### Checks

- Usual durations seen on these PRs: `Test` workers up to 14 minutes, `Build and Test (Native)` 12 to 14 minutes, `local-relay` (Relay R7 local gate) 64 to 65 minutes.
  Check at 30 minutes; the relay gate at 75 minutes; a job past twice its usual time is hung (cancel, rerun once, file an issue if `timeout-minutes` is missing).
- Failing because of the diff: two fix attempts (fix round), then the advisor with the failing log.
- Failing without the diff (fails on `develop` too, infrastructure, or a known flake such as #1634's signal 11 or `DirectConnectionDeadlineTests` timing): one `gh run rerun <id> --failed`, then file an issue with the log and continue other steps; the same gate step flaky twice in seven days goes to the lead (diagnosis card).
- No checks on a head (L02 today): push of the develop merge starts them; if none start in 5 minutes, check `gh pr view N --json mergeable` and the path filters, run the local gates, and ask the owner if a required check stays pending.

### A merge conflict

The branch's worker merges `origin/develop` into the branch (`git merge origin/develop`), resolves, reruns its gates and pushes once; never a rebase, never a force-push.
A manual resolution after round 2 already ran (L05 today): one advisor consult reads `git show --cc <merge sha>` and rules; no third review round.

### Timebox, silence, usage limit

- Implementer silent 45 minutes (no commit, no event lines): nudge once (Claude) or check the Codex process; then redispatch with an inventory of its files and commits.
- Past twice the timebox: advisor.
- A Codex usage limit or a refused `spend`: write the board, do not move the card to Claude, ask the parity question.

### An owner answer

Apply section 11, `MB decide BOARD "<answer>" --by owner`, set the question `closed`.

### Merge

When the merge gate passes (plan 0.4): `gh pr ready N` if still draft, `gh pr merge N --merge`, then `MB set BOARD Steps <id> State=done`, close the step's agents, and `MB log`.
After each merge: watch `develop`'s next push run (`gh run list --branch develop --limit 3`); a red `develop` stops all merges and goes to the advisor.

## 11. Owner questions and what each answer does

Ask at the first tick, in three batches: (Q2, Q10, Q9, Q3), (Q1, Q4, Q5, Q6), (Q7, Q8).
The question texts and options are on the board; the mapping:

| Q | Answer | Board change |
| --- | --- | --- |
| Q1 #1512 phone gate | keep | L09 `todo`; after its gates pass it goes `owner` until the owner reports the phone acceptance |
| | waive | L09 `todo`; the PR body records the waiver; the manager may merge |
| | defer | L09 `dropped`; branch kept |
| Q2 Mac test gate | bounded attempt, then hosted | native cards apply their Q2-A gate text |
| | require local | a native step whose Mac test stalls goes `owner` |
| Q2 and Q10 both answered | any answers | L03 and L04 `todo` (they wait on both; every later native step depends on L03) |
| Q3 #1731 fix | approve | L06 `todo` |
| | not now | L06 `dropped`; branch kept |
| Q4 image-availability | fold | nothing until L13 |
| | land first | `MB propose` "lead writes a card for image-availability before L08"; lead wake |
| Q5 #1711 | park | L11 `dropped`; branch kept |
| | land | L11 `todo` |
| | delete | L11 `dropped`; L13 adds the branch to the delete list |
| Q6 #1641 | fold | L12 `dropped`; branch kept |
| | land | L12 `todo` (after Q2 and Q10 are answered) |
| Q7 #1727 files | any answer | the owner acts; L10 `done` when the owner says so; a "push" answer adds a lead wake to decide whether a #1727 card follows |
| Q8 drop list | approve | L13 includes every listed branch |
| | keep some | L13 includes only the ones the answer names |
| Q9 Luna second reviewer | yes | add one Codex Luna reviewer (RV-panel, lens `contract`) to L03, L06 and L08-R4 |
| | no | Sonnet only |
| Q10 Codex sandbox | full access | section 5 variant for `xcode` steps |
| | workspace-write | keep; a sandbox denial in a native gate raises the parity question |

## 12. The parity question

Asked only on a mismatch: a refused model id, a Codex usage limit or refused Codex `spend`, a capability no slot has, or a sandbox denial.
Form: "Update the parity to ... (Recommended) / Move this card to Claude Opus for today / Keep and wait for the reset".

## 13. Never

- Everything in the skill's "Never" list.
- Switch the main checkout's branch, or touch another worktree than the card's.
- Commit, push or read the contents of the untracked files in `/Volumes/S1/worktrees/remi/store-callback-order`.
- Delete a branch or a worktree, close an issue, or file an issue: hand the exact commands to the owner (L13, issues-to-file.md).
- Merge into `main`, merge L09 against Q1, merge the P01 or A03 PRs before the owner approves.
- Use the frontier tier anywhere but A02.
- Mark a test as skipped, or loosen a gate, to get a check green.
