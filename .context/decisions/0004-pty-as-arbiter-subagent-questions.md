# ADR 0004: PTY-as-arbiter for subagent question routing

**Status:** accepted
**Date:** 2026-07-09
**Owner:** Yahya

## Context

Agent-team sessions fire permission hooks from subagent contexts. Blindly
holding-and-pushing those escalations produced both failure modes at once:
phantom phone questions the lead agent was about to answer anyway, and real
prompts that never surfaced. Teammate prompts also fire no hooks at all
(CC#23983), arriving only as orphan PTY renders.

## Decision

Claude's own PTY render is the arbiter. Subagent-tagged escalations are
parked (hook passed through, no push) and the push fires only if the prompt
actually renders. Parked records are scoped to their owning agent (#763);
the eval-in-flight buffer window opens only for main-context evals, counted
so concurrent evals cannot close each other's window (#767).

## Consequences

Background-agent noise is gone and rendered prompts always route. New
obligations: park/buffer/expiry decisions must stay observable (debug logs),
and silently-handled subagent decisions need an audit surface plus a
`subagent_policy` config — the open design in #756. Known dormant hazard:
status-churn can wipe a main-eval buffered prompt (#769).

## Alternatives considered

- **Push every subagent escalation:** the pre-#751 behavior; phantom
  questions at scale.
- **Suppress all subagent escalations:** silent denials; violates "my agent
  needs me. Yes or No."

## Receipts

Issues #751, #763, #767, #756; PRs #762, #764, #768 (0.6.19). Detail
formerly in `.context/subagent-aa-routing.md` (pruned 2026-07-10; the live
proposal is on #756).
