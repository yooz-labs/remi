# Card P2A: profile paths: transcripts, status line and download protection follow every profile (issue #1749, slice 1 of 4) (OUTLINE)

Status: outline
Tier: worker-hard
Timebox: L, 1.5 days; escalate at 3 days or two failed approaches
Needs: none
Depends: CP1 (the lead completes this card there), D51 (ADR 0051 on `develop`)
Branch: `feature/issue-1749-profile-paths` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/profiles-p2a`
Plan: plan.md section 2 (P2A); issue #1749 Scope paragraphs 1 to 3 and acceptance items 1, 2 and 7

## Goal

Transcript discovery, the status line and file-download protection follow each session's profile and cover every configured profile, so two sessions in two profiles both reach a client's chat view with their own transcripts, the status line works in each, and no configured profile's directory can be downloaded.

## Context

Verified on `develop` `c9e13967`; the CP1 lead re-verifies every line after phase 1 merged.
- `TranscriptDiscovery` defaults to `~/.claude/projects` (`packages/daemon/src/transcript/transcript-discovery.ts:29, 64`) and is used by `cli/handlers/transcript-events.ts`, `cli/handlers/resume-session-events.ts`, `cli/transcript-fallback.ts`, `cli/session-phases/hook-bridge-setup.ts`, `harness/claude-session.ts` and the module-level instance in `cli.ts:1171`; P1B points a profile session daemon's own instance at its profile.
- The status line is installed by `installStatusLine(remiDir, claudeSettingsPath = ~/.claude/settings.json, registerInClaudeSettings)` (`cli/statusline-installer.ts:79-90`), called at `cli.ts:3472` and `cli.ts:3755` with `!isRemiHomeOverridden()`; it registers only where no `statusLine` key exists.
- Download roots: `downloadProtectionRoots` (`tunnel/file-download-session-host.ts:22-51`) called at `cli.ts:1532-1540`; P1B passes the active profile's directories; ADR 0045 is the required-root policy.
- No `claude agents --json` or other status probe exists outside `profiles/` (grep at `c9e13967`), so #1157's "probes follow the profile" has nothing to move.

## Scope

Draft, completed at CP1: `transcript/` (a discovery that scans the built-in and every configured profile's `projects/`, each transcript tagged with its profile id), `cli/statusline-installer.ts` and its two call sites (install into each configured Claude profile's `settings.json` under the same "only when no `statusLine`" rule and the same `REMI_HOME` override rule), the download-roots call site (every configured profile's directories, adopted and inactive ones included, as required roots), tests, `docs/agent-reference/profiles.md`, the PR body.

## Decided design

Draft for the CP1 lead to settle: whether discovery is one multi-root instance or one instance per profile; how a transcript found under a profile's directory is tied to a session (by the session's profile snapshot, never by working directory alone); how the hub, which runs no session, lists transcripts of every profile until P2B adds visibility (default visible, today's behavior), and that P2A and P2B ship in the same release.

## Acceptance

From #1749, to be made literal at CP1: two sessions in two profiles both reach the chat view with their own transcripts (real discovery over synthetic transcripts in temporary profile directories); the status line works in each profile's sessions (the real installer against temporary settings files, and the generated script run on the documentation's example input); downloads refuse a file under any configured profile directory, active or not (`bun test packages/daemon/tests/profiles` plus the new tests named at CP1).

## Gates

The preamble's TypeScript gates and `bun test packages/daemon`, as in P1B; completed at CP1.

## Stop conditions

As P1B, plus: discovery would show a session under the wrong profile; a status line would be written into a settings file that already has a `statusLine`.

## Report

The preamble's report.
