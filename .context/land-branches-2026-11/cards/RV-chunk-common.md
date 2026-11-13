# Card RV-chunk-common: rules every chunk reviewer of L07 and L08 follows

Status: ready
Tier: reviewer
Timebox: S, 1 hour per reviewer; the manager proceeds without a reviewer silent for 20 minutes
Needs: none
Depends: the step's PR is open and its implementer reported
Branch: none (read-only)
Worktree: none; read commits from `/Users/yahya/Documents/git/yooz/remi` by hash
Plan: plan.md section 3.1

## Goal

This card is sent after the chunk card, so every chunk reviewer reads the same commits, stays within the same budget and returns the same report shape.

## Context

- You are an independent, read-only reviewer using the `project:pr-review-toolkit` procedure (`review-procedure.md`, `review-rubrics.md`).
- Live facts give `Lens group`, `Base` (the merge-base with develop) and `Head` (the PR's head commit). Read only those commits: `git -C /Users/yahya/Documents/git/yooz/remi diff BASE...HEAD -- FILES` and `git -C /Users/yahya/Documents/git/yooz/remi show HEAD:PATH`; never a worktree, never `git fetch`, `checkout` or any write.
- Lens group `contract`: correctness, types, invariants, security (authentication, authorization, key and file-permission handling), concurrency and actor isolation, data integrity across restarts.
  Lens group `verification`: whether tests can fail (no mocks of business logic; real fixtures), negative paths, silent failures and fallbacks, comments and docs that claim more than the code does (the repository's "Verify before you describe" rule).
- Repository rules: `AGENTS.md`, `packages/native/AGENTS.md` at `HEAD`.
- Q9 (owner, 2026-11-12): chunk L08-R4 also gets a Codex Luna reviewer with lens group `contract`; every other chunk is reviewed by Sonnet only.

## Scope

Read: the chunk card's files at `HEAD`, their diff against `BASE`, and at most 800 lines of other code through targeted reads (`grep -n` for call sites, then `sed -n` ranges).
Change: nothing.

## Decided design

Settled: at most 5 findings, highest severity first, plus `omitted_findings` (how many further findings were dropped by the cap); severity is Critical, Important, Moderate or Minor; every finding names file, line, the failure it causes, and a concrete fix; drop anything below high confidence.
The reviewer may choose: which 5 findings matter most.

## Acceptance

The report is one JSON object in the shape of `review-panel-protocol.md` ("Report contract") with `reviewer_id` set to the chunk and lens (for example `L08-R4-contract`), and a `checks` list naming the commands run, for example `git diff BASE...HEAD --stat -- FILES`.

## Gates

`git -C /Users/yahya/Documents/git/yooz/remi cat-file -t HEAD` prints `commit` for the given Head before review starts; otherwise return `status: "unavailable"`.

## Stop conditions

The diff of the chunk exceeds about 2,000 changed lines plus the 800-line read budget: report what was covered and list the files not reviewed in `residual_risk`.

## Report

The JSON object only, including `omitted_findings`.
