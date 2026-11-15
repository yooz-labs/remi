# Card P4A: compaction on request (issue #1751, slice 1 of 2) (OUTLINE)

Status: outline
Tier: worker-hard
Timebox: L, 1.5 days; escalate at 3 days or two failed approaches
Needs: none
Depends: CP3 (the lead completes this card there)
Branch: `feature/issue-1751-compaction` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/profiles-p4a`
Plan: plan.md section 2 (P4A); issue #1751 Scope (compaction parts), acceptance items 1 to 4 and 6; ADR 0049 D4, V15, V16, Q7; ADR 0051 A10, A15 (phase 4 row)

## Goal

From the terminal or a client of a daemon that lists `session_compaction`, a person compacts a session on its current account: refused with a reason while a turn runs, a prompt is up, a Codex approval is live or the session is in a usage-limit wait; Claude through `/compact` typed by the guarded write path with completion from a newly registered `PostCompact` hook; Codex through `thread/compact/start` with completion from the `contextCompaction` item; "not confirmed" at the deadline.

## Context

Verified on `develop` `c9e13967`; re-verify at CP3.
- `PostCompact` and `PreCompact` are typed (`packages/daemon/src/hooks/hook-types.ts:378-398`) and neither is registered (`REMI_REGISTERED_HOOK_EVENTS`, lines 724-739), so a slow or dead remi never gates compaction (#203, `hooks/hook-config-manager.ts:140-146, 293`).
- The guarded write path and the one `promptUp` signal chat and Stop read: `docs/agent-reference/questions-and-notifications.md` ("Chat text and Stop's `/exit` are refused while a prompt is up").
- The latency gate: a stopped remi must not delay compaction with `PostCompact` registered, measured before the merge (plan J7). Owner, 2026-11-14: the manager or a worker may make the measurement on a test hub under a temporary `REMI_HOME`, never the real hub on 18765 or live sessions; a part that needs a real Claude or Codex account stays the owner's OG-P4. The CP3 lead writes into this card what can be measured without an account and how.

## Scope

Draft: hook registration (`PostCompact` only, never `PreCompact`), the compaction request handler, Claude and Codex paths, shared protocol types and fixtures (`compact_request`, `compact_result`), `capabilities.ts`, tests (real hook server with documented payloads, real PTY with a fake `claude` recording input, the stand-in app-server emitting the item lifecycle), agent reference, PR body.

## Decided design

Draft for the CP3 lead: the deadline value; how the usage-limit wait is detected before #1752 (P3B's `limitWait`); summary routing only to the requesting authenticated client.

## Acceptance

From #1751, to be made literal at CP3: refusals type nothing; Claude completion from `PostCompact` with the summary reaching only the requester; Codex completion from the right thread's item and an item on another thread ignored; the deadline reports "not confirmed" untouched; registration still excludes `PreCompact`; the owner's latency measurement recorded in the PR before the merge.

## Gates

The preamble's gates including fixtures; completed at CP3.

## Stop conditions

As P2B, plus: anything would register `PreCompact` or type into a session with a prompt up.

## Report

The preamble's report.
