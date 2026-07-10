# ADR 0001: transcript_path is the single source of truth for session binding

**Status:** accepted
**Date:** 2026-06-08
**Owner:** Yahya

## Context

Four recurring complaint families (zombie sessions, sibling daemons stealing
hooks, rotation misses, wrong-session routing) all traced to one root: the
daemon had no authoritative link between a Claude Code session and its
transcript. Hook events, PTY heuristics, and file watchers each guessed
independently.

## Decision

Every Claude Code hook event carries `transcript_path` stamped by Claude
itself; `TranscriptBinder` binds a daemon to exactly one session via that
path and is the only admission gate. The old hook-binding paths were deleted
outright (no shims).

## Consequences

Session identity is now source-based, never inferred: "Active = has daemon
port". Foreign or unclaimed sessions are explicitly escalated instead of
silently dropped (#672). The binder gained consistency checks
(`transcriptConsistentWithBinding`, port-drift fallback). Remaining follow-up
is cosmetic: formalizing a HookRouter abstraction (#470).

## Alternatives considered

- **SessionEpoch generation counters:** designed, then descoped as YAGNI once
  the binder covered the real cases (epic #435).
- **Keeping the legacy binding path behind a flag:** rejected; carried for one
  soak then deleted (-1062 lines, PR #669) per the no-backward-compat rule.

## Receipts

Epics #499, #453, #435; PRs #504-#510, #669, #697, #698. Detail formerly in
`.context/refactor-453-*.md` (pruned 2026-07-10).
