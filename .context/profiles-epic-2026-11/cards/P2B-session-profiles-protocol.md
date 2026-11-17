# Card P2B: `session_profiles`: remote visibility, remote choice and the profile on every session (issue #1749, slice 2 of 4) (OUTLINE)

Status: outline
Tier: worker-hard
Timebox: L, 2 days; escalate at 4 days or two failed approaches
Needs: none
Depends: P2A, D51 (ADR 0051 on `develop`; moved here from P2A, pack review D23)
Branch: `feature/issue-1749-session-profiles` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/profiles-p2b`
Plan: plan.md section 2 (P2B); issue #1749 "Remote visibility", "Protocol, part 1", the limits, the ADR 0049 amendment; ADR 0051 A5, A15 (first row of phase 2), Q3, Q6

## Goal

A daemon that lists `session_profiles` lets an authenticated client ask which profiles it may start a session in (with the default the hub resolves for a directory and its reason), start a session in one of them, and see each session's profile; a profile that is not remotely visible shows nowhere remote.

## Context

Verified on `develop` `c9e13967`; re-verify at CP1.
- Capabilities: `DAEMON_CAPABILITIES = ['workspaces']` (`packages/daemon/src/cli/capabilities.ts:18`), documented in `PROTOCOL_CAPABILITIES` (`packages/shared/src/protocol-version.ts:41-56`), decided by clients with `hubSupport`; ADR 0035.
- The hub's create path: `checkHarnessRequest` before a port is probed (`cli/handlers/create-session-events.ts:146-189`), `startSession` (`:276-350`), `spawnDaemon(port, dir, extraArgs)`; children inherit the hub's environment (`cli/daemon-manager.ts:619-633`).
- Fixtures: `packages/shared/tests/fixtures/protocol/` generated from `builders.ts` by `generate.ts` (113 files), `create_session_request*.json`, `hello_ack*.json`, `create_session_response*.json`.
- Shapes, limits and refusals are fixed by #1749 "Protocol, part 1" and the backend plan (32 profiles, id `[a-z0-9][a-z0-9-]{0,31}`, label 1 to 64 safe code points and not email-shaped, 64 KiB frames); the native side will decode the same fixtures (#1788).

## Scope

Draft: lift P1B's refusal of `--remi-profile` on `--host` launches (P1B design item 2): the CLI sends `create_session_request.profile` when the hub lists `session_profiles` and keeps refusing otherwise; clients that build a request send `harness` explicitly, because an omitted wire `harness` still means Claude (P1B design item 6); the profiles module (`remote_visible`, default true, and remote selectability, default false for configured profiles, `default` keeps today's remote behavior), the shared protocol types and fixtures for `session_profiles_request` and response, `create_session_request.profile`, `profile: {id, label, state?}` on session-list entries, `hello_ack` and the create result; the daemon handler; the hub create path (refuse before a port is probed; pass the chosen profile to the child as `--remi-profile`); filtering of remote session and transcript lists; `capabilities.ts` and `PROTOCOL_CAPABILITIES`; the ADR 0049 amendment for these shapes; tests; agent reference; PR body.

## Decided design

Draft for the CP1 lead: the configuration keys for visibility and selectability (names are owner-facing: the guides of P2C print them); how `profile.state` (`current`, `changed`, `removed`) is computed from P1B's snapshot revision; that `remi profile` gains no remote write.

## Acceptance

From #1749, to be made literal at CP1: a remote `create_session_request.profile` naming a profile that is not remotely selectable is refused before a port is probed or anything is spawned, and a selectable one starts the child in it; a profile with `remote_visible = false` has none of its sessions or transcripts in any remote list and appears in no `session_profiles_response`; no frame carries a local path, email or environment value (planted-marker scan over a full sequence); a client that does not see `session_profiles` sends none of its requests (`hubSupport` tests), and a daemon without a handler answers `UNKNOWN_MESSAGE`; golden fixtures for every message and refusal (`bun test packages/shared`); the ADR amendment records the decision and the default.

## Gates

The preamble's gates, including all four type checks (the web compiles shared code) and fixture regeneration; completed at CP1.

## Stop conditions

As P1B, plus: a shape would differ from #1749 or ADR 0051 A15; anything would need `PROTOCOL_VERSION` to change.

## Report

The preamble's report.
