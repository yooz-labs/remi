# Card P2C: `profile_status`: sign-in status, Check, read-only settings and guides (issue #1749, slice 3 of 4) (OUTLINE)

Status: outline
Tier: worker-hard
Timebox: L, 2 days; escalate at 4 days or two failed approaches
Needs: none
Depends: P2B
Branch: `feature/issue-1749-profile-status` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/profiles-p2c`
Plan: plan.md section 2 (P2C); issue #1749 "Protocol, part 2", `remi profile rename|remove`, the label rule, the A8 addition; ADR 0051 A1 to A4, A13, A15 (second row of phase 2), Q1, Q5, Q6

## Goal

A daemon that lists `profile_status` answers, for every remotely visible profile, its sign-in per harness, re-runs the effective-login check on request (rate-limited), shows the profile's settings read only, and returns the exact `remi profile` commands for add, sign-in, rename, remove and list; no client writes configuration, runs a command or sees a path, email or environment value.

## Context

Verified on `develop` `c9e13967`; re-verify at CP1.
- The check, warnings, revision and commands come from P1A and P1B (`packages/daemon/src/profiles/`); P2B adds visibility and selectability.
- Message shapes, enums and limits are fixed by #1749 "Protocol, part 2" (`login` one of `signed_in`, `signed_out`, `not_own_login`, `unknown`; `reason` one of `harness_missing`, `timeout`, `not_checked`, `error`; one check per profile at a time and one per profile every 15 seconds for all clients; settings read by key only: Claude `permissions.allow|ask|deny` texts and `hooks` counts per event, Codex `approval_policy`, `sandbox_mode`, `model_provider`; `rulesError` `missing` or `invalid`; guide `action` one of `add`, `login`, `rename`, `remove`, `list`).
- ADR 0051 A8 (owner requirement with Q11): a Claude Code profile is never assumed to be an Anthropic account; `expects` comes from the profile's own configuration; an unknown value decodes as unknown.

## Scope

Draft: shared protocol types and fixtures for `profile_status_request|response`, `profile_check_request`, `profile_settings_request|response`, `profile_guide_request|response` and their refusals; the daemon handlers; `remi profile rename` and `remi profile remove` (remove deletes the table only, never the directory, refused while a session runs in that profile); the command that lets devices select a profile (its name decided at CP1 from P2B's keys); `capabilities.ts`, `PROTOCOL_CAPABILITIES`; the ADR 0049 amendment for these shapes; tests; agent reference; PR body.

## Decided design

Draft for the CP1 lead: owner call J17 (answered by CP1): whether the permission rule texts in `profile_settings_response` get the same path replacement as `args` (a token starting with `/` or `~` replaced by the marker) and a planted rule-text path in the marker scan (recommended), or stay verbatim as #1749 words them; the in-place edit method for `rename` and `remove` in `config.toml` (P1A only appends); the exact guide steps per action; whether `remi profile add` gains flags for visibility and selectability or a separate command does it.

## Acceptance

From #1749, to be made literal at CP1: each `login` value produced by its case with fake executables (including `not_own_login` with `source: "apiKeyHelper"` and `unknown` with `reason: "harness_missing"`); two checks inside 15 seconds spawn one probe (the fake's invocation log); the settings response returns rule texts and hook counts, replaces a path-like argument, gives `env` and `folders` as counts and `rulesError: "invalid"` for an unparsable file; the add guide refuses an email-shaped label, a taken id and a malformed id with their own codes, and its commands, run in the test's shell against the same temporary `REMI_HOME`, make the profile appear in the next status response; a removal guide for a profile with a running session is refused and `remi profile remove` leaves the directory; a planted marker in a profile's path, `env`, `settings.json` (`env`, `apiKeyHelper`, a hook command) and the fakes' output appears in no frame; the A8 unknown-expectation test; the capability is listed only when every part works.

## Gates

The preamble's gates; completed at CP1.

## Stop conditions

As P2B, plus: any handler would read a key the issue does not list, or return a hook command.

## Report

The preamble's report.
