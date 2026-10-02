# ADR 0030: Defer permission judgment to the harness; remi only relays

**Status:** accepted
**Date:** 2026-10-01
**Owner:** Yahya

## Context

Since the 0.5.0-dev line (commit `6400871c`, #175), remi has acted as a second permission judge on top of Claude Code: a local large language model (LLM) evaluator (the "auto-approve" service, run on the Yooz engine or `llama-server` on port 19924) plus a deterministic rule layer (`allow`/`deny` lists, permission groups, strictness levels, read-only proofs, a deny floor, per-agent sections).
The measured return on that layer is low and its cost is high:

| Evidence | Source |
|---|---|
| On one machine's banded LLM-only decision lines, the LLM approves 87 of 275 operations it evaluates (31.6%); the overall approve rates, deterministic layers included, were 53.4% there and 72.2% on the second machine | `.context/approval-rate-baseline-2026-08.md` |
| Escalation latency p50 5.3 s, p95 25 s; MacBook Air approve p50 9.4 s and 498 engine-timeout errors | same |
| Deterministic coverage of real main-agent commands: 12.9% | #996 |
| `auto-approve/` is 22,920 of 65,007 daemon source lines; its tests 34,766 of 91,924 | `wc -l` at `3a5e8b27` |
| 116 of 154 non-release commits since 2026-08-01 touched it | `git log` |
| Security bugs caused by acting as a second judge: #536 (P0), #1060, #1063, #1001, #997, #1014 | issues |

Meanwhile the harnesses ship their own first-party approval: Claude Code's auto mode plus `permissions.allow`/`permissions.deny` (auto mode is the starting mode since 2.1.283 on supported models), and Codex's `approvals_reviewer = "auto_review"`.
The owner already relies on those.
On Claude, the residue of prompts that still reach a human is small; AskUserQuestion and plan approval become the main interactions.
Full analysis: `.context/strategy-2026-10.md`, sections 1 to 4 (owner decision D1).

## Decision

remi no longer decides permissions.
Both the local-LLM evaluation and the deterministic rule layer are deleted (#1125, epic #1123).
Whatever the harness still asks, remi relays to the phone and relays the answer back; nothing is auto-answered by remi.

What remains, and is what ships after #1125:

- **Relay.** `PermissionRequest` reaches `AutoApproveGate` (name kept until Phase 3, #1126), which escalates every main-agent prompt.
  A binary prompt is answered `passthrough` so Claude renders its native dialog in the terminal at once, and the card is pushed when that render pairs with the hook record (push on render, #1121).
  A multi-choice or design prompt (AskUserQuestion, ExitPlanMode) is answered `passthrough` and pushed immediately.
  A phone answer is typed into the rendered prompt using the screen's numbering, only when the chosen option's label exactly matches the screen's option at that number (#1134, PR #1136); otherwise it is refused, which means answer at the terminal, where Claude's dialog is still showing.
- **Subagent prompts.** An `agent_id`-tagged request is parked and answered `passthrough`; its card pushes only if its prompt renders on the main PTY (ADR 0004, minus the render-time evaluation).
- **Subagent alerts.** The informational `subagent_alert` push still fires for parked subagent requests matching the user's patterns, now configured under `[notifications] subagent_alert`.
- **External resolution.** A matching `PreToolUse`/`PostToolUse`/`PermissionDenied`, a matching `PostToolUseFailure` (subagent cards only), a lead `Stop`, `SubagentStop`, `SessionEnd` and `remi unstick` still resolve open cards; a card that was pushed is dismissed everywhere.

Nothing holds the hook in this phase: holding was only enabled when an auto-approve service existed.
ADR 0002's hold-the-hook model stays the documented transport; the next phase (#1126) answers prompts structurally through held hooks while Claude's own dialog stays visible.

## Consequences

- remi stops depending on yooz-engine: no engine or model download on first run, port 19924 is free, and the `remi model` command is gone (it prints a removal notice and exits 2).
  `~/.remi/engine` is left on disk; the boot warning says it can be deleted by hand.
- Users who relied on `[auto_approve] allow`/`deny` move those rules into Claude Code's own `permissions` block.
  `remi migrate-permissions` prints the translation as JSON for the user to paste; it never writes a file.
  The deny lists change meaning in transit: remi matched a deny entry as a substring anywhere in a command, while a Claude Code Bash rule matches from the start of each subcommand.
  So a migrated deny rule (`rm -rf /` becomes `Bash(rm -rf /*)`) is narrower than it was, every such rule is flagged on stderr, and a pattern that only ever sat mid-command (`push --force`, `DROP TABLE`) has no faithful form and is not carried over at all.
  A bare `Bash`, unknown tool names, entries with shell operators, groups, levels and per-agent sections have no faithful translation either and are listed as not carried over, each with its reason.
- An old `config.toml` with an `[auto_approve]` table still loads; the daemon warns once at boot naming the removed keys (the hub, not again in each session daemon it spawns).
  `--auto-approve` and the other `--auto-approve-*` flags are accepted and ignored with the same warning, so existing LaunchAgent plists and scripts keep starting.
- The daemon stops emitting the `evaluating`/`approved` agent statuses, the `autoApprove` status sub-field, the `auto_approved`/`auto_denied` resolution reasons and the `auto_denied` push kind.
  The shared protocol types keep them, marked deprecated, so older clients still parse; the web cleanup is a follow-up.
- Every prompt that reaches remi now interrupts a human, so the wedge becomes reliability of the relay (every prompt reaches the phone, every answer lands) rather than how many prompts remi can absorb.
- The client status-cue rows of ADR 0020 that described the evaluation cue (`onEvalStart`, `onHandled`, `onCancelled`, `onHeldCancelled`) describe deleted code.

This supersedes ADRs 0010, 0015, 0016, 0017, 0018, 0023, 0025, 0026, 0027, 0028 and 0029, and amends 0003 and 0004 where they describe LLM evaluation.
The superseded ADRs keep their bodies as history.

## Alternatives considered

- **Keep the deterministic layer, delete only the LLM.** Rejected: 12.9% coverage, and most of the security bugs above came from the rule layer (substring allow matching, shell-safety vetoes), not from the model.
  Claude Code's own `permissions` rules already express what remi's lists did, with the harness owning the parser.
- **Keep both behind a default-off flag.** Rejected: a third of the daemon and over a third of the tests would stay to maintain for a path nobody runs, and a flag that reads as coverage is the failure ADR 0011 describes.
- **Move judgment into a remote model.** Rejected: contradicts the local-first principle and would still be a second judge.

## Receipts

- Owner decision D1, `.context/strategy-2026-10.md` (2026-10-01), sections 2 to 4.
- Epic #1123; phase issue #1125; push on render #1121 (PR #1122), the path every binary main-agent escalation now takes (AskUserQuestion and ExitPlanMode push at once instead).
- `.context/approval-rate-baseline-2026-08.md` (approval rate and latency), #996 (deterministic coverage).
