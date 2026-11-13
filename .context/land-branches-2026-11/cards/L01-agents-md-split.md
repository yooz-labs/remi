# Card L01: AGENTS.md split (#1733)

Status: ready
Tier: worker
Timebox: S, 4 hours; escalate at 8 hours
Needs: none
Depends: none
Branch: chore/agents-md-split (PR #1733, head `b379ea64` on 2026-11-12)
Worktree: none for the check (it reads git objects from the main repository); for a fix only, `/Volumes/S1/worktrees/remi/agents-md-split`
Plan: plan.md section 2, L01

## Goal

PR #1733 is shown to move the five AGENTS.md sections verbatim into `docs/agent-reference/`, with only the per-section summaries new, so one docs reviewer can approve it.

## Context

- PR #1733 body: AGENTS.md went from 133k to 27k characters; five sections moved to `docs/agent-reference/` in the first commit; the second commit keeps each section's standing invariants plus a pointer.
- The PR is docs only (6 files), checks are green, no review is on record.
- Every later worker reads AGENTS.md, so this lands first.
- The branch is checked out in another session's scratch worktree; if `git worktree add` refuses the branch, stop and report the path it names (the owner removes that worktree).

## Scope

May change: `AGENTS.md` and `docs/agent-reference/*.md`, only to restore text the check below shows as lost.
Everything else is out of scope.

## Decided design

Settled: the split layout and file names stay as in the PR; no content is rewritten or reworded.
The implementer may choose: nothing beyond restoring lost text.

## Acceptance

Run from `/Users/yahya/Documents/git/yooz/remi` after `git fetch origin`, with `E=/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/L01/r1` and `mkdir -p $E`:

1. `git show origin/develop:AGENTS.md > $E/old.md`
2. `for f in AGENTS.md docs/agent-reference/harnesses-and-codex.md docs/agent-reference/hub-mode.md docs/agent-reference/protocol-and-workspaces.md docs/agent-reference/questions-and-notifications.md docs/agent-reference/transport-auth-pairing.md; do git show origin/chore/agents-md-split:$f; done | sort -u > $E/new-lines.txt`
3. `grep -Fxv -f $E/new-lines.txt $E/old.md | grep -v '^[[:space:]]*$' > $E/lost-lines.txt; wc -l < $E/lost-lines.txt`

Pass: every line in `lost-lines.txt` is classified in the report as either replaced by a named summary in AGENTS.md (give the section) or restored by a fix commit.

## Gates

`typos` on the branch's files reports nothing, and `git diff --check origin/develop...origin/chore/agents-md-split` prints nothing.

## Stop conditions

More than 30 lost lines that no summary covers; any change needed outside AGENTS.md or `docs/agent-reference/`.

## Report

The preamble's report (PR 1733, the head hash), plus the lost-line count and the classification of each line.
