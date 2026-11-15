# Cards DOCS-P2, DOCS-P3, DOCS-P4: the profile guide updated for phases 2, 3 and 4 (OUTLINE)

Status: outline
Tier: worker
Timebox: M, 6 hours (DOCS-P2), 4 hours (DOCS-P3, DOCS-P4); escalate at twice that or two failed approaches
Needs: docs
Depends: DOCS-P2 on P2D; DOCS-P3 on P3C; DOCS-P4 on P4B (each also on its phase's version-bump commit)
Branch: `docs/remi-profiles` in `yooz-labs/yooz-docs` (the open profiles docs PR's branch, or a new one off `origin/main` if the earlier PR merged with a release)
Worktree: `/Volumes/S1/worktrees/yooz-docs-profiles` and `/Volumes/S1/worktrees/remi/profiles-docs-build` (detached at the live facts' `DEV_SHA`)
Plan: plan.md section 2; the documentation checkbox of #1749, #1750 and #1751; ADR 0051 A4

## Goal

The profile guide and command reference describe exactly what each phase ships, from runs of the built `develop` tip against a temporary `REMI_HOME`, in the profiles docs PR that merges with the release shipping that phase.

## Context

Each is completed at the checkpoint before it (DOCS-P2 at CP1, DOCS-P3 at CP2, DOCS-P4 at CP3) by copying DOCS-P1's card and changing its content list:
- DOCS-P2 (#1749): devices seeing and selecting a profile (the visibility and selectability keys and command), `remi profile rename` and `remove` (the directory stays), Check from a client, the read-only settings a client sees, and headings "Check a profile's sign-in" and "Let devices use a profile" (anchors the apps link to).
- DOCS-P3 (#1750): a "Usage" section: what each number is, its source, age and reset time; Refresh per harness (Codex reads through a running session, Claude Code re-reads its latest report, API key has nothing to refresh, a Claude Code profile without Claude credentials reports none); the thresholds; the exact `usage_warning` text; and that until the legacy push is retired that text is visible in plaintext to remi's push relay and Apple (owner's Q7).
- DOCS-P4 (#1751): a "Compact a session and read its handoff brief" section with each refusal and what it means.

## Scope

As DOCS-P1's card, for the same two pages.

## Decided design

As DOCS-P1's card (build, runs, code blocks, prose source, PR rules); headings above are fixed for app links.

## Acceptance

As DOCS-P1's card, made literal for the phase at its checkpoint (`bun run build` in the docs worktree; every output block found in `runs.txt`).

## Gates

As DOCS-P1's card.

## Stop conditions

As DOCS-P1's card.

## Report

The preamble's report.
