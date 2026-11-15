# Card P3B: `profile_usage` with Refresh, `limitWait`, and the `usage_warning` push (issue #1750, slice 2 of 3) (OUTLINE)

Status: outline
Tier: worker-hard
Timebox: L, 2 days; escalate at 4 days or two failed approaches
Needs: none
Depends: P3A
Branch: `feature/issue-1750-profile-usage` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/profiles-p3b`
Plan: plan.md section 2 (P3B); issue #1750 "Protocol", "Additions (ADR 0051 A8 and A9)" and its acceptance items; ADR 0049 D3, Q3, Q8; ADR 0051 A7 to A9, A15 (phase 3 row), Q7, Q8, Q11; ADR 0019

## Goal

A daemon that lists `profile_usage` serves each visible profile's snapshot on request and on change, refreshes it on request within the rate limits (Codex through a running session's app-server, Claude Code by re-reading, API key not applicable), reports Claude Code's own limit wait on the session, and sends one `usage_warning` per profile, window and reset period, whose one text builder feeds the legacy and the secure senders unchanged.

## Context

Verified on `develop` `c9e13967`; re-verify at CP2.
- One text builder for both push paths already exists for `turn_failed`: `buildTurnFailedText` (`packages/daemon/src/notifications/turn-failed.ts:185`) used by the dispatcher (`notifications/notification-dispatcher.ts:822-866`); preferences in `notifications/push-preferences.ts`.
- Push kinds: `SecurePushKind` and `PUSH_KIND_BYTE` (`packages/shared/src/relay/push.ts:38-55`), `push-client.ts:103`; the Worker's legacy `/push` passes `kind` through unvalidated (`packages/signaling/src/index.ts:85-98`) and sees only `pushClass` on the sealed path, so no Worker change and no redeploy is expected; a step that needs one stops.
- The owner's Q7: the same text on the legacy plaintext path as on the sealed path, its plaintext exposure to the Worker and Apple stated until R7; `usage_warning` on by default; collapse key `usage-warning-<profile id>-<window id>`.
- Rate limits and outcomes are fixed by #1750's additions (30 seconds per profile for all clients, one in flight, 10-second Codex deadline, outcomes `refreshed`, `reread`, `too_soon`, `no_live_session`, `not_applicable`, `timeout`, `error`).

## Scope

Draft: shared protocol types and fixtures (`profile_usage_request|response`, `profile_usage_update`, `profile_usage_refresh_request`, session-list `limitWait`, `profile_settings_response.thresholds`), the daemon handlers and refresh scheduler, the push kind across `packages/shared/src/relay/push.ts`, `push-client.ts`, the dispatcher and preferences (`pushPrefs.usageWarning`), the ADR 0019 and ADR 0049 amendments, tests (local HTTP sink for the legacy body, the real secure sender input, a source guard for the one builder), agent reference, PR body.

## Decided design

Draft for the CP2 lead: threshold evaluation at turn ends against the largest window; where the refresh outcome is kept for `too_soon`; the update cadence of `profile_usage_update`.

## Acceptance

From #1750, to be made literal at CP2: each allowed Codex refresh sends exactly one `account/rateLimits/read` and two inside 30 seconds send one; no running Codex session answers `no_live_session` with no session or app-server started; a Claude Code refresh leaves the fake `claude`'s input log empty and answers `reread`; API key answers `not_applicable`; a read past 10 seconds answers `timeout` and keeps the numbers; the legacy body and the secure sender's input carry identical text and a source guard finds no other construction; planted markers in machine, session, directory and account identifiers appear in no warning; `usage_warning` once per profile, window and reset period at `warn_percent`, never for an unknown value, respecting the device preference; a Claude Code profile with no reported windows returns none and its refresh is `not_applicable`.

## Gates

The preamble's gates including fixtures; completed at CP2.

## Stop conditions

As P2B, plus: anything under `packages/signaling/` would change (owner redeploy).

## Report

The preamble's report.
