# Card REL-DOCS: recheck the profiles docs against the release build

Status: ready
Tier: worker
Timebox: S, 2 hours
Needs: docs
Depends: the owner said a remi release that ships one or more profile phases is published; its tag `vX.Y.Z` exists on `origin` (live facts: the tag, the docs PR number)
Branch: the open profiles docs PR's branch in `yooz-labs/yooz-docs` (normally `docs/remi-profiles`)
Worktree: `/Volumes/S1/worktrees/yooz-docs-profiles` and `/Volumes/S1/worktrees/remi/profiles-docs-build` (detached at the release tag)
Plan: plan.md section 0.4 (yooz-docs merges) and runbook section 10, "Release docs"

## Goal

Every command and output on the profiles docs pages is shown to match the release build exactly, or the pages are corrected in one commit to match it, so the docs PR can be marked ready and merged by the owner for that release (plan J2).

## Context

- The docs PR was written from `develop` builds (DOCS-P1 to DOCS-P4), with every run recorded in its body; the release build can differ (later merges, the version string).
- The docs PR merges for the release that ships its feature and not before; the pages must describe nothing the release does not ship.

## Scope

May change in `yooz-docs`: the two profile pages and the PR body (extend it, never replace it).
May change in remi: nothing (`git -C /Volumes/S1/worktrees/remi/profiles-docs-build fetch origin --tags && git -C /Volumes/S1/worktrees/remi/profiles-docs-build checkout --detach vX.Y.Z`, then `bun install --frozen-lockfile` and `bun run build:binary`).
Evidence: `/Volumes/S1/yooz/remi/artifacts/profiles-epic-2026-11/REL-DOCS/vX.Y.Z/`.

## Decided design

Settled: copy `check-output-blocks.ts` from the latest DOCS step's evidence folder (`/Volumes/S1/yooz/remi/artifacts/profiles-epic-2026-11/DOCS-P<n>/r<round>/`, the newest one) into this card's evidence folder; rerun every command listed in the docs PR body's recorded-commands section, exactly as DOCS-P1's card prescribes (same `env -i` form, same fake or real harness choice per command) with the release build; compare each output block with the new run; a difference that is only the version string or a timestamp is updated in place; a difference in behavior, or a page section describing a phase the release does not ship, is removed or corrected to the release's behavior and listed in the report.
The worker may choose: nothing else.

## Acceptance

`runs-release.txt` in the evidence folder holds every command, exit code and output; the copied `check-output-blocks.ts` prints "all output blocks found" against `runs-release.txt`; the email regex of DOCS-P1's acceptance item 5 finds nothing in `runs-release.txt` or the extended PR body; `bun run build` in the docs worktree passes; the PR body gains a "Rechecked against vX.Y.Z" section listing what changed.

## Gates

`bun run build` in the docs worktree; `typos` on the two pages; `git -C /Volumes/S1/worktrees/yooz-docs-profiles diff --check origin/main...HEAD` prints nothing.

## Stop conditions

The release does not contain a phase the pages describe and removing it would leave a page empty or misleading (report; the lead decides); the tag is missing.

## Report

The preamble's report, with `pr` set to the docs PR number and `head_sha` to the docs branch head.
