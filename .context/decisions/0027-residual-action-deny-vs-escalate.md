# ADR 0027: `residual_action` — deny-with-reason vs. escalate-to-human for a residual permission

**Status:** accepted
**Date:** 2026-08-16
**Owner:** Yahya

## Context

When auto-approve cannot decide a main-agent BINARY `PermissionRequest` — no
evaluation service, an eval error, or a primary verdict of `escalate` —
`AutoApproveGate.escalateMain` has always done one thing: hold the hook (or
passthrough) and push a card to the human. That is correct as a default, but
it means every residual case pings the user, even on a well-tuned gate where
most of those pings would have been approved if the human had just answered
"yes" on autopilot.

The wire only allows one alternative, and it is worth stating precisely
because it rules out a design that looks obvious. `HookServer`'s
`PermissionDecision` (`packages/daemon/src/hooks/hook-server.ts:102-132`) has
exactly three shapes for a `PermissionRequest` response: `'allow'`,
`'deny'`/`{behavior:'deny', message?, interrupt?}`, and `'passthrough'` (bare
`{}`). Per the official hooks reference's PermissionRequest decision-control
table, `message` is documented as "For `deny` only: tells Claude why the
permission was denied." There is no equivalent field on `passthrough` or
`allow` — an escalate-to-human decision is a bare `{}` on the wire, so it
structurally cannot carry a reason for the agent to read. `deny` is the only
shape that can. This was independently confirmed against the code, not
assumed from the docs.

Two already-shipped pieces make a real alternative to escalate available now:
`buildDenyMessage` (#976) puts a capped, actionable reason into a deny's
`message`, and `onAutoDenied` (#1015) gives every deny — including one this
gate itself decides to produce, not just a config/model one — an
unconditional audit log line, with push kept separate from logging.

## Decision

Add `auto_approve.residual_action: "escalate" | "deny"`, default `"escalate"`.
`AutoApproveGate.escalateMain` — and *only* that method's BINARY branch —
consults it:

- `"escalate"` (default): unchanged. Hold/push as before, byte-for-byte.
- `"deny"`: refuse with `{behavior:'deny', message: buildDenyMessage(reasoning)}`
  instead of asking. The agent gets a reason it can act on (retry differently,
  or ask the user directly) and the human is not pinged for something
  auto-approve merely could not decide on its own.

`reasoning` is threaded into `escalateMain` from each of its three call sites
(`auto-approve-gate.ts`): a generic literal at the no-service edge, the
formatted `errorToString(err)` at the eval-error path, and `result.reasoning`
at the primary escalate verdict.

**Scope is deliberately narrow: main-agent BINARY escalates only.**
`escalateMain` is the entry point for ALL main-context escalates reaching
those three call sites, including non-binary ones (a design/plan-mode tool
like `ExitPlanMode` can arrive at any of them, e.g. the no-service edge before
`isBinaryEscalation` has been checked) — it internally branches on
`isBinaryEscalation(input)` to decide hold-vs-passthrough. The deny conversion
sits *inside* that binary branch, never in the passthrough one, so a
multichoice/design/plan-mode escalate stays a passthrough under `"deny"` mode
exactly as it does under `"escalate"` — those are structural questions the
binary allow/deny/passthrough response cannot express an answer for, "deny"
included. A subagent's parked-render residue (ADR 0004) is a separate
mechanism entirely (`arbitrateParkedRender` → `escalateRenderedParked`, never
`escalateMain`) and is unaffected by this setting; folding it in is a
documented follow-up, not this phase.

**A converted deny is tagged `DenySource.kind: 'residual'`** (a third value
alongside `'config'` and `'model-floor'`) and reported through the same
`reportDeny`/`onAutoDenied` sink every other deny uses. `cli.ts`'s
`onAutoDenied` already gated its push on `source.kind !== 'model-floor'`, so
`'residual'` falls into that same no-push branch with no code change beyond
the type addition — it logs unconditionally (the #1015 audit principle) but
never pushes, because the whole point of choosing `"deny"` is fewer pings, not
a differently-labeled ping.

### The owner's caveat

`"deny"` is only a net improvement once the auto-approve gate's approval rate
is genuinely high (~95%+). Below that, it converts every wrongful escalation
— a case the human actually needed to see — into a wrongful deny the agent
just quietly hits a wall on, which is a worse failure than the extra ping
`"escalate"` would have cost: nobody is asking, and nobody notices until the
agent gives up or does something worse to route around the refusal.
Ship-now, soak-and-correct-later: `"escalate"` is the default for exactly
this reason. Flip it only once your own measured approval rate earns it.

## Consequences

Easier: a user who has tuned their gate well can turn off residual pings
entirely, and the agent still gets enough information (via `message`) to
self-correct instead of stalling silently. The mechanism reuses two features
that already existed for a different reason (`buildDenyMessage`, `onAutoDenied`)
rather than inventing a new reason-carrying channel — because none is possible
on the wire for a passthrough response.

Harder, and worth stating plainly: `"deny"` mode has no card to catch a wrong
call. Under `"escalate"`, a bad auto-approve verdict still lands in front of a
human who can correct it. Under `"deny"`, it is silent to the human by design
— logged, not surfaced — so the entire safety margin for this class of
mistake shifts from "the user sees it" to "the user reads their logs." This
is the trade the config knob exists to make explicit, not to hide.

**New obligation.** Any future phase that wants to fold the subagent
parked-render path into this setting (currently explicitly out of scope) must
re-derive whether `escalateRenderedParked`'s callers can supply a comparable
`reasoning` string, and must not silently start denying subagent residue that
today always escalates to a human via the PTY-arbiter policy (ADR 0004).

## Alternatives considered

- **Put a reason on the escalate/passthrough response too.** Rejected: not
  possible. `PermissionDecision`'s `'passthrough'` case is a bare `{}}` on the
  wire; there is no field for it, documented or otherwise. Any future
  attempt to "just add a reason to escalate" will hit this same wall — this
  ADR exists partly so nobody re-discovers that the hard way.
- **Apply `residual_action` to every escalate site, including
  multichoice/design and the subagent parked-render path.** Rejected for this
  phase. Multichoice/design escalates are structural questions (which option?)
  that a binary allow/deny/passthrough answer cannot express regardless of
  which of `"escalate"`/`"deny"` is configured — denying one would not "answer
  it," it would just refuse a question that was never a yes/no in the first
  place. The subagent parked-render path has its own render-time arbitration
  policy (ADR 0004) and its own callers; conflating the two would require
  re-verifying invariants that ADR earns separately. Narrower scope now,
  documented extension path later.
- **A separate boolean (`deny_residual: bool`) instead of an enum.** Rejected:
  the two values are mutually exclusive and the field reads better as "what
  happens" (`escalate` / `deny`) than as a double-negative toggle, and a
  three-way future extension (e.g. a per-agent override, mirroring ADR 0025)
  is more natural on a string enum than on a bool.

## Receipts

- `packages/daemon/src/auto-approve/types.ts` — `ResidualAction`,
  `DenySource.kind: 'residual'`, `AutoApproveConfig.residual_action`
- `packages/daemon/src/auto-approve/auto-approve-gate.ts` — `escalateMain`
  (the single chokepoint), its three call sites
- `packages/daemon/src/auto-approve/deny-floor.ts` — `buildDenyMessage` (#976,
  reused verbatim, not reimplemented)
- `packages/daemon/src/cli.ts` — `onAutoDenied` (#1015, reused verbatim: the
  `!== 'model-floor'` push gate already excludes `'residual'` with zero
  changes)
- `packages/daemon/src/hooks/hook-server.ts:87-132` — `PermissionDecision`,
  the wire-level proof that `passthrough` cannot carry a reason and `deny`
  is the only shape that can
- `packages/daemon/src/config/config.ts` — `applyResidualAction` (warn +
  fall back, deliberately unlike `level`/`engine`/`multichoice`, which all
  throw on an invalid enum value — see that function's own doc for why this
  field is the exception)
- #1045, #1015 (the audit-trail principle this reuses), ADR 0004 (the
  subagent path this explicitly does not touch)
