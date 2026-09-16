# ADR 0028: Narrow remote reads and private session-precedent scope

**Status:** accepted
**Date:** 2026-09-16
**Owner:** Yahya

## Context

The existing read groups cover local/VCS/build inspection but did not cover
`gh api`, so a read-only GitHub REST request paid the local-model latency and
could still become an unnecessary human escalation. `gh api` is also a remote
operation whose method, request body, headers, host, and cache flags cannot be
inferred safely from the `gh api` prefix alone.

Session precedent already records only human answers in a per-session store,
but its public signature is intentionally command-only because it is visible on
the client. Without a second private scope, an identical command answered in
one Remi session's project/worktree root could authorize the same command in
another session. The prior default stayed off while that boundary was
unresolved.

## Decision

Add `gh-read` as a curated group in every level. It approves only one relative
REST endpoint with output/formatting flags and explicit GET forms. It rejects
mutation methods, body/input/header/cache/verbose flags, unknown options, extra
positionals, GraphQL, absolute URLs, and shell-control forms. Arbitrary
`curl`, `wget`, `ssh`, `WebFetch`, and `WebSearch` remain outside shipped
presets; they require an explicit policy choice.

Enable session precedent by default for new or otherwise-unconfigured configs,
while preserving explicit user values. A human answer is reusable only when
the exact command signature and the normalized private session working
directory match within the same in-memory session store. Production evaluation
uses the session's canonical directory even if Claude reports a changed hook
`cwd` during that session. Missing or blank context fails closed. The working
directory is never added to `Question`, the protocol, or the client-visible
signature. A different project/worktree should use a different Remi session
when the user wants a separate approval scope.

## Consequences

Safe GitHub API reads avoid an LLM round trip, and repeated human-approved
operations in the same project can stop generating duplicate cards. Mutation
and arbitrary-egress false positives remain escalations, so some legitimate
reads will still cost a model call or a card. A worktree or project boundary
change asks again; this is intentional. Existing explicit configuration is not
rewritten, so current installations must opt in if they explicitly disabled
session precedent or replaced the default group list.

## Alternatives considered

- **Approve all remote reads:** rejected because arbitrary destinations,
  payloads, headers, and tool semantics create an egress/exfiltration policy,
  not a read-only local convenience.
- **Trust the local model or prompt instructions for `gh api`:** rejected;
  historical local decisions show that context can turn a harmless read into a
  costly escalation, and prose is not an enforceable grant.
- **Put `cwd` in the client-visible signature:** rejected because it expands
  protocol/client data and still does not need to be visible to enforce the
  scope; the daemon can compare it privately.
- **Reuse precedent across projects or sessions:** rejected because it turns a
  session answer into a durable allow rule the user did not write.

## Receipts

- `.context/plan-readonly-session-approval.md` — hypotheses, phased plan, and
  acceptance results.
- `packages/daemon/src/auto-approve/permission-groups.ts` — fail-closed
  `gh-read` parser and adversarial veto tests.
- `packages/daemon/src/auto-approve/precedent.ts` — private normalized context
  in the store/reader boundary; `hook-event-bridge.ts`, `auto-approve-gate.ts`,
  and `input-events.ts` thread it without putting it on the wire.
- `gh help api` — verified that request-body flags can switch the default
  method to POST and that `--verbose` exposes the full HTTP exchange.
- Local QAT smoke on 2026-09-16 — safe `gh api ... --paginate` approved at 0 ms
  by `gh-read`; POST plus field payload reached the model and escalated.
