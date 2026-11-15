# Card P3C: the web usage panel with Refresh and the warning switch (issue #1750, slice 3 of 3) (OUTLINE)

Status: outline
Tier: worker
Timebox: M, 1 day; escalate at 2 days or two failed approaches
Needs: none
Depends: P3B
Branch: `feature/issue-1750-web-usage` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/profiles-p3c`
Plan: plan.md section 2 (P3C); issue #1750 "Web client" and its Refresh addition; ADR 0051 A7, A8, A14

## Goal

The web client shows a usage panel per profile, every number with its source, age and reset time, a Refresh that shows each outcome in words, and the per-device `usage_warning` preference.

## Context

Verified on `develop` `c9e13967`; re-verify at CP2. The web Settings section from P2D (`packages/web/src/components/settings/`); the web secure-push preferences in `SettingsPanel.tsx`; the P3B fixtures.

## Scope

Draft: `packages/web/src/` components and decoders for the P3B messages, web tests, PR body.

## Decided design

Draft for the CP2 lead: placement in the P2D Profiles section; outcome wording from ADR 0051 A8.

## Acceptance

From #1750, to be made literal at CP2: every rendered number has source, age and reset time; each refresh outcome shows its words; a passed reset never shows 0%; a Claude Code profile without windows shows "Usage is not reported for this profile" and no Refresh; two-sided conformance with the real daemon handler.

## Gates

`bunx biome check .`, all four type checks, notices, `typos`, the web tests named at CP2.

## Stop conditions

A daemon change is needed (stop; it belongs to P3B).

## Report

The preamble's report.
