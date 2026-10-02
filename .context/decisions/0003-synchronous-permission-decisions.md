# ADR 0003: Synchronous hook-response auto-approve decisions + permission groups

**Status:** accepted; amended by ADR 0030 (2026-10-01)
**Date:** 2026-06-09
**Owner:** Yahya

> **Amended 2026-10-01 by [ADR 0030](0030-defer-permission-judgment-to-the-harness.md).**
> remi no longer produces permission verdicts: the auto-approve LLM and the permission groups described below are deleted (#1125).
> What survives from this ADR is the mechanism, not the judgment: the gate still answers every `PermissionRequest` synchronously in the hook response, and since #1125 that answer is always `passthrough` (a binary prompt then pushes on its render, #1121; a multi-choice prompt pushes at once).
> The body below is kept as history.

## Context

Auto-approve verdicts were applied by injecting keystrokes into the PTY,
which raced the terminal renderer and could answer the wrong prompt. Config
was a flat allow/deny list that could not express families of related
permissions.

## Decision

The auto-approve gate resolves permissions synchronously in the
`PermissionRequest` hook response (`hookSpecificOutput.decision`); PTY
injection for verdicts is retired. Config gains built-in permission groups
(`approve_groups` / `deny_groups`) on top of per-tool lists.

## Consequences

Verdicts are atomic with the hook — no timing window. Escalations carry tool
context ("Allow Bash: …") into the question text. Open tails: the AGENTS.md
documentation for this model was never written (the one item keeping #497 and
epic #494 open), and the default allow-list still substring-matches Bash
(#536, P0). User's local eval models: qwen3.5:4b-mlx with
escalate_model=qwen3.6:35b-mlx.

## Alternatives considered

- **Keep PTY injection with better prompt matching:** inherently racy;
  rejected.
- **Domain permission packs / user-defined groups:** deferred as #552, on top
  of this foundation.

## Receipts

Epic #494 (0.6.5); PRs #498, #510, #520-#527. Detail formerly in
`.context/epic-494-sync-permissions.md`, `permission-packs-research.md`
(pruned 2026-07-10; packs research summarized in #552).
