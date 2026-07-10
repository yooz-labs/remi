# ADR 0006: cc-ref is not ground truth for Claude Code behavior

**Status:** accepted
**Date:** 2026-07-06
**Owner:** Yahya

## Context

`~/Documents/git/yooz/cc-ref` was long treated as a Claude Code architecture
reference. Verified 2026-07-06: it is github.com/ultraworkers/claw-code, a
third-party Rust parity reimplementation covering 3 of 25+ hook events, with
no `permission_suggestions` modeling. Design work built on it (e.g. hook
schema assumptions) diverged from real Claude Code behavior.

## Decision

Never cite cc-ref as ground truth. Hook schemas and TUI behavior come from
the official docs (code.claude.com/docs/en/hooks, claude-code-guide agent)
and real captures (`~/.remi/hook-debug.log` via `REMI_HOOK_DEBUG`).

## Consequences

`.context/cc-architecture-reference.md` (derived from cc-ref) is deleted;
#742 tracks the remaining code comment in hook-types.ts that still cites it.
Behavioral claims (e.g. ExitPlanMode option order, #598) must be re-verified
against live Claude Code each release.

## Alternatives considered

- **Keep the reference doc with a warning banner:** a wrong reference that
  looks authoritative is worse than none; deleted instead.

## Receipts

Verification session 2026-07-06 (memory: Claude Code Reference); issues
#742, #598, #718 (structured permission_suggestions ground-truthing).
