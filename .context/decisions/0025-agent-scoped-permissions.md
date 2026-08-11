# ADR 0025: Permissions may be scoped per agent type; network egress is never a default

**Status:** accepted
**Date:** 2026-08-11
**Owner:** Seyed Yahya Shirazi

## Context

A live 0.7.6 session on the owner's machine escalated a burst of subagent
permissions without the LLM ever running. Traced from `~/.remi/daemon.log`, the
mechanism was not the one the daemon's own docs would suggest:

- The #1024 hook-time deterministic path worked exactly as designed
  (`approve-matched group: "read-only:grep"`, `ls`, `cat`, `sed -n`).
- `WebFetch` and `WebSearch` matched **nothing**. No group lists them —
  `read-only` is `['Read','Glob','Grep','NotebookRead']` plus shell commands.
- So every web call from every subagent parked, rendered, and entered the
  **serial** eval queue.
- Under a fan-out of five concurrent `general-purpose` agents the queue
  saturated, and waiters escalated on `queue_timeout` (default 240s) — the
  `eval queue wait exceeded` branch, which returns before any LLM call.

So the most common operation a research subagent performs took the most
expensive path available, and under load degraded to "escalate everything"
while looking like the LLM was broken.

The available workaround was `allow = ["WebFetch", "WebSearch"]` — a bare
tool-name entry, which ADR 0010 and #1032 both record as the blunt instrument:
it carries no destination veto at all.

Two things are wrong here, and they are separable.

## Decision

### 1. A `net-read` group exists, and is in no level preset

`net-read` covers `WebFetch` and `WebSearch` as a real group, so users stop
reaching for a bare tool-name `allow` to get them.

It is **not** in `strict`, `balanced`, or `trusted`, and not in
`DEFAULT_CONFIG.approve_groups`. No shipped preset grants **arbitrary-URL
egress** — stated that way because "the presets are entirely local" would be
false: `vcs-read` carries fifteen `gh` subcommands that call api.github.com and
`build-test` has `uv run pytest`, which resolves from PyPI. The line `net-read`
crosses is not network-vs-local, it is *whose choice the destination is*.

Adding it to `trusted` was considered and rejected. `trusted` is selected for
git mutation and proved-derived deletion; someone who chose it for those reasons
would silently acquire arbitrary outbound network egress on upgrade. That is
precisely the failure ADR 0023 fixed in `matchGroups` — a group union quietly
widening an axis nobody opted into — and repeating it in the level presets a
release later would be indefensible.

The asymmetry is deliberate and worth stating plainly: **a wrongly-escalated
web fetch is a nuisance; a wrongly-approved one is an exfiltration channel.**
`WebFetch` takes an arbitrary URL, subagents are exactly the context no human is
watching, and a prompt-injected subagent needs only a URL with a query string.
Opting in is one line; opting out of a default you never noticed is not.

### 2. Permissions may be scoped by `agent_type`

```toml
[auto_approve.agents.Explore]
approve_groups = ["read-only", "vcs-read", "net-read"]

[auto_approve.agents.pr-review]
approve_groups = ["read-only", "vcs-read"]
allow = ["gh pr view", "gh pr diff"]
```

`agent_type` is already on the `PermissionRequest` hook input, already logged at
the decision points, and already used by `precedent.ts` for operation identity.
Nothing new is trusted: it is Claude Code's own value, the same provenance as
`agent_id`, which the subagent policy has keyed on since #756.

**Merge semantics, chosen so the safe direction is the monotone one:**

| key | agent section present |
|---|---|
| `deny` | **union** with base |
| `deny_groups` | **union** with base |
| `allow` | **replaces** base |
| `approve_groups` | **replaces** base |

Deny unions because a per-agent rule must never be able to *weaken* a
machine-wide prohibition — an agent section is a place to say "this role is
narrower", and a reader must be able to trust that adding one cannot remove a
deny. Allow and approve_groups replace because the entire point is per-role
scoping: if they merged additively, an agent section could only ever widen, and
"give the pr-review agent LESS than the base" would be inexpressible — which is
the case that motivated the feature.

Replacement can widen, when the user writes a wider list. That is their choice,
made explicitly, and it is visible in one table in one file.

## Consequences

**A per-agent section is the only way to grant `net-read` to just the agents
that need it.** That is the intended shape: `Explore` and research agents get
network reads, a `pr-review` agent does not, and the machine-wide default grants
it to nobody.

**Not closed by this ADR:**

- The serial eval queue itself. Moving web calls to the deterministic layer
  relieves the measured saturation but does not bound it; a large enough
  fan-out of genuinely-unmatched operations still queues and still escalates on
  timeout. The queue is serial to protect the GPU and that trade-off is
  unchanged here.
- `deny` remains substring-matched and `approve_groups` whole-command-matched
  (ADR 0010); per-agent scoping inherits both behaviours unchanged.
- Agent *names* are not validated against anything, and **a typo in a section
  name is currently undetectable**. There is no registry of agent types to
  check against, so `[auto_approve.agents.Explor]` silently never matches and
  NOTHING reports it — not at load, not at evaluation. An earlier draft of this
  ADR claimed "the daemon logs the agent types it has actually seen resolve a
  policy"; it does not, and shipping that sentence would have been the ADR 0011
  failure inside the ADR itself. Group names inside a section ARE validated
  (they have a registry), which is the half that was closeable.

## Verification obligation

Per ADR 0011, the claim "a per-agent section cannot weaken a deny" is a security
claim and must be pinned by a test that fails when the union is changed to a
replacement — not merely by this document asserting it.
