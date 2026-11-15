# Card P3A: usage observations, the account fingerprint and the per-profile snapshot (issue #1750, slice 1 of 3) (OUTLINE)

Status: outline
Tier: worker-hard
Timebox: L, 2 days; escalate at 4 days or two failed approaches
Needs: none
Depends: CP2 (the lead completes this card there)
Branch: `feature/issue-1750-usage-observations` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/profiles-p3a`
Plan: plan.md section 2 (P3A); issue #1750 Scope (Claude status line, quota notifications, Codex reads, fingerprint, snapshot) and acceptance items 1 to 5 and 7; ADR 0049 D2, D3, D11; ADR 0051 A8

## Goal

remi records each profile's plan usage only from what each CLI already reports to its own clients (Claude's status-line `rate_limits` windows, Codex's `account/rateLimits/read` and `account/rateLimits/updated`), keyed by an HMAC fingerprint that never leaves the machine, into one snapshot per profile with source and age per window; no wire change yet (P3B).

## Context

Verified on `develop` `c9e13967`; the CP2 lead re-verifies after phase 2 merged.
- remi's status-line script reads only `context_window.used_percentage` and `model.display_name` (`packages/daemon/src/cli/statusline-installer.ts:57`); P2A makes it per profile.
- Registered hooks are `REMI_REGISTERED_HOOK_EVENTS` (`hooks/hook-types.ts:724-739`), including `Notification` and `StopFailure`; `rate_limit` is phrased in `notifications/turn-failed.ts`.
- The Codex app-server client lives under `harness/codex/` (allowlist in `tests/harness/harness-boundary.test.ts`); no code reads `account/*` or rate limits today (ADR 0049 V7).
- Facts: ADR 0049 V8, V9, V10, V12, V13, V31; gaps G1 to G5, G17 ("same account" stays unknown for Claude).
- ADR 0051 A8: usage is keyed by what the profile's harness reports, never by the harness name; a Claude Code profile without Claude credentials shows "Usage is not reported for this profile".

## Scope

Draft: the status-line script (record exactly the documented numeric windows into a remi-owned per-session file; offer to wrap a person's own `statusLine`), quota notification parsing, Codex reads and merges in the app-server client (`accountId`, email and workspace dropped on receipt after hashing), the fingerprint key file (owner-only, under the remi home), the snapshot store with merge-by-observation-time, tests with the stand-in app-server (`tests/helpers/fake-app-server.ts`, frames built from the installed CLI's schema and labeled synthetic), agent reference, PR body.

## Decided design

Draft for the CP2 lead: file layout of the per-session readings and the snapshot; the wrap mechanism for an existing `statusLine`; whether Claude and Codex halves split into two PRs.

## Acceptance

From #1750, to be made literal at CP2: the status-line script records exactly the documented numeric fields and still prints the same text; a Codex snapshot updates on `account/rateLimits/updated` and on the read after `turn/completed`, a sparse update never clears a value, an older observation never overwrites a newer one; `ordinaryUsageAllowed: false` is blocked whatever the percentages say and `null` is unknown; two Codex profiles on one account are the same account, and `account/updated` or a new fingerprint discards the snapshot; a never-observed profile is unknown; no email, account id, workspace name or credential appears in any file or log line (scan); the key file is owner-only; no code path maps the harness name `claude` to Anthropic windows.

## Gates

The preamble's gates; completed at CP2.

## Stop conditions

As P1B, plus: any reading would need a credential or a call to a vendor endpoint (ADR 0049 O6 is rejected).

## Report

The preamble's report.
