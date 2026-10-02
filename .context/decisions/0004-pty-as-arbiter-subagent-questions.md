# ADR 0004: PTY-as-arbiter for subagent question routing

**Status:** accepted; amended by ADR 0030 (2026-10-01) and ADR 0031 (2026-10-02)
**Date:** 2026-07-09
**Owner:** Yahya

> **Amended 2026-10-02 by [ADR 0031](0031-held-hook-answers-with-native-dialog-visible.md).**
> A background subagent's dialog does not render while its hook is held (verified live), so the route depends on the session.
> With a local terminal (wrapper mode) the request is still answered `passthrough` and parked, but its render pushes an informational "answer at the terminal" notice, never an answerable card: nothing is typed into a hook-backed prompt.
> With no local terminal (daemon or hub mode) nobody could answer a rendered dialog, so the request is held and pushed as an answerable card, exactly like a main-agent prompt.

> **Amended 2026-10-01 by [ADR 0030](0030-defer-permission-judgment-to-the-harness.md).**
> The PTY is still the arbiter of whether a parked subagent prompt reaches the phone: a subagent-tagged request is parked and answered `passthrough`, and its card pushes only when its prompt renders on the main PTY.
> What is gone is every evaluation around that: the render-time LLM arbitration (`arbitrateParkedRender`, #814), the main-eval buffer window (#484, #767) and the 2026-08-08 amendment's hook-time deterministic approve (#1024) were all deleted in #1125.
> No subagent request is answered by remi any more; each one either renders and is pushed, or is handled by Claude Code's own permission flow without a card.
> The body below is kept as history.

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

## Amended 2026-08-08: a deterministic config approve answers at hook time; the LLM still never runs there

**Status of this amendment:** accepted. It NARROWS the original rule rather
than reversing it — the LLM is still never consulted at hook time for a
subagent-tagged request, on any authorization. What changes is which
subagent requests reach the park path at all.

### Why the original rule could not stand unchanged

A live transit session (2026-08-08, `c77ba8f8`) fired 69 subagent
PermissionRequests: ~40 Bash calls from one review agent (`review-479`) in
12 minutes, plus 11 WebFetch calls from research agents in 4 minutes. Every
one of those parked, exactly per the pre-amendment rule, and every parked
render WAS evaluated once it rendered — no "not evaluated" pushes. But the
verdicts routinely lost the race against prompt churn: the log fills with
`Parked render <id> is no longer the prompt on screen; NOT typing "1"` — the
LLM approved, the inject was refused because a DIFFERENT prompt had already
taken the screen, and the outcome degraded into a user escalation (and
sometimes a dropped push). With several agents running in parallel, the main
PTY prompt turns over faster than a GPU-backed eval round-trip can complete.
The GPU is also serialized (one model, one queue): a burst of parked
renders queues its evals behind each other, which is what pushed several
main-context evals past `push_hold_timeout` and produced "escalated
directly to user" symptoms that had nothing to do with the main agent's own
work.

None of this was an LLM-accuracy problem. The review agent's ~40 Bash calls
were `read-only`-group reads; the WebFetch calls were plain user `allow`
tool-name matches. The config had already decided every one of them before
the park-unconditionally rule ever asked the model anything — the cost was
purely the render-time race, paid on traffic the daemon could have settled
at 0ms and never rendered at all.

### What licensed the change

The original ADR's own rationale was **GPU cost per background call and
unknowable render state** — "Claude blocks on this hook response, so at
decision time we cannot know whether the prompt will ever render on the
main PTY... evaluating them all meant one GPU-backed LLM call per background
tool call." Both halves of that rationale are properties of the LLM
specifically: a 0ms, config-authorized match has no GPU cost and needs no
render-state knowledge, because it does not depend on what the user would
have decided — the user already decided it, in `config.toml`, when they
wrote the `allow` list or picked a `level`. ADR 0015's amendment already
established that config-sourced authorization (a human's own `config.toml`)
is a non-text channel that may decide outright, unlike text-derived
authority; ADR 0016 established that the permissive half of policy is
level-gated group membership, checkable without a model. Both apply
directly to `approve_groups`/`allow` matches on a subagent request — nothing
about being subagent-tagged changes what those matches already mean for a
main-context request evaluated by the identical code path.

### The amended rule

At hook time, for a subagent-tagged (`agent_id`-present) PermissionRequest,
run ONLY `AutoApproveService.evaluateDeterministic` — the exact deny/allow/
approve_groups matcher calls, in the exact order, `evaluate()` itself runs
before ever considering the LLM (extracted so the two share one
implementation and cannot drift, per ADR 0015/0017's shared-list caution):

- **Deterministic approve** (no deny match, and `allow` or `approve_groups`
  covers the call): the gate answers the hook `{behavior: 'allow'}`
  directly. No park, no PTY render, no LLM call, no queue wait. The
  `onSubagentPassthrough` observation cue still fires — unchanged from the
  park path — so `subagent_alert` visibility does not depend on how the hook
  was answered. (Historical: this layer was removed by #1125, and the
  `onSubagentPassthrough` cue itself by #1155, which feeds `subagent_alert`
  from the tool hooks instead, since a call the allow rules permit fires no
  `PermissionRequest`; see ADR 0031's #1155 amendment.)
- **Deny-covered, or no deterministic verdict**: parks + passes through
  exactly as the pre-amendment rule did. A hook-time deny is still not
  produced for a subagent match: unlike a main-context deny (which can carry
  `buildDenyMessage` back to Claude), a subagent's config-level deny has no
  human-visible channel until a render happens, so it stays on the
  render-time PTY-arbiter path this ADR already governs.

**The LLM is still never invoked at hook time for a subagent request, on
any path.** That was the original decision's core claim and it is
untouched: only a 0ms, config-authorized match — the same match a
main-context request already gets for free — can decide here. Everything
the original ADR said about the LLM (GPU cost, unknowable render state,
phantom-question risk) still governs every subagent request the config does
not deterministically approve.

### What this does NOT change

- Parked records, the eval-in-flight buffer window, and `arbitrateParkedRender`
  (#814) are untouched for every request that still parks.
- A model-produced verdict, for a subagent or otherwise, still only ever
  happens at render time (`arbitrateParkedRender`) or in the main-context
  synchronous path — never at subagent hook time.
- The gate does not call `markHandled()` for a deterministic hook-time
  approve. Every existing `markHandled(true)` call site pairs with its own
  prior `onEvalStart({isSubagent:true})` (see `arbitrateParkedRender`),
  which is what keeps the shared per-session `inFlight` eval counter
  (#560/#576) balanced; this path never opens that counter, so firing only
  the "end" half risked decrementing a genuinely in-flight MAIN eval's count
  — the class of miscounted cue [ADR 0020](0020-client-status-cue-totality.md)
  exists to catch. Both effects `markHandled` would otherwise produce are
  already no-ops for a subagent permission (`onAutoApproveHandled` returns
  early on `isSubagent`; the client broadcast is skipped the same way), so
  omitting the call costs nothing.
- **A bare tool-name `allow` entry (`allow = ["Write"]`, `["Edit"]`) now
  grants a subagent silent, hook-time, unrendered approval to sensitive
  destinations a curated group would veto.** `matchAllowPattern` applies no
  destination check by design (ADR 0010: "a user allow entry may legitimately
  be a write"), unlike `approve_groups`, whose write groups carry
  `vetoSensitiveToolPath`. This was already true for main-context requests;
  #1024 is the first time it applies to subagent traffic with zero chance of
  a human ever seeing the prompt. Not a defect in this change — it faithfully
  extends existing allow semantics, and the config validator already warns on
  tool-name-shaped allow entries — but the blast radius of a loose config is
  now wider and quieter. Tracked as #1032.

## Receipts

Issues #751, #763, #767, #756; PRs #762, #764, #768 (0.6.19). Detail
formerly in `.context/subagent-aa-routing.md` (pruned 2026-07-10; the live
proposal is on #756).

**2026-08-08 amendment:** issue #1024 (evidence: transit session `c77ba8f8`,
69 subagent PermissionRequests, ~40 Bash/12min from `review-479`, 11
WebFetch/4min, all parked renders evaluated but routinely losing the
prompt-lifetime race). `packages/daemon/src/auto-approve/auto-approve-service.ts`
— `evaluateDeterministic`. `packages/daemon/src/auto-approve/auto-approve-gate.ts`
— `resolvePermission`'s subagent branch. ADR 0015 (config as a non-text
authorization channel), ADR 0016 (groups as checkable policy), ADR 0020
(the `markHandled` omission reasoning above).
