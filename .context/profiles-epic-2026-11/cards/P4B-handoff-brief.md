# Card P4B: the deterministic handoff brief (issue #1751, slice 2 of 2) (OUTLINE)

Status: outline
Tier: worker-hard
Timebox: M, 1 day; escalate at 2 days or two failed approaches
Needs: none
Depends: P4A
Branch: `feature/issue-1751-handoff-brief` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/profiles-p4b`
Plan: plan.md section 2 (P4B); issue #1751 "The handoff brief", acceptance item 5; ADR 0049 C2, Q4, Q5; ADR 0051 A10

## Goal

A daemon that lists `handoff_brief` returns, on request, a brief built without a model call from what remi already reads (directory, branch, a bounded `git status` count, the last user messages and the last final answer), bounded, escaped, the same for the same inputs, stating what it could not read, kept local until used.

## Context

Verified on `develop` `c9e13967`; re-verify at CP3. Transcript readers under `packages/daemon/src/transcript/`; Codex thread items through the harness chat (`HarnessChat.readHistory`, AGENTS.md "The harness seam"); the repository's redacted transcript corpus for tests.

## Scope

Draft: the brief builder, the request handler, shared protocol types and fixtures (`handoff_brief_request`, `handoff_brief_result`), `capabilities.ts`, tests (redacted corpus, temporary git repository), agent reference, PR body.

## Decided design

Draft for the CP3 lead: size bounds; the escaping function; git invoked with no shell, no prompt and a deadline, as the workspaces feature does (ADR 0036).

## Acceptance

From #1751, to be made literal at CP3: the same brief for the same inputs; bounded; states what it could not read; no model call; delivered only to the requesting authenticated client.

## Gates

The preamble's gates including fixtures; completed at CP3.

## Stop conditions

As P2B.

## Report

The preamble's report.
