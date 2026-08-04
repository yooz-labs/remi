# ADR 0013: Total dispatch — every consumer declares handle-or-ignore

**Status:** accepted
**Date:** 2026-07-29
**Owner:** Yahya

## Context

Before this change, every consumer of `ProtocolMessage` routed on
`message.type` with a `switch` that had a catch-all `default`, and every
`default` was silent: `App.tsx:1627-1630` logged `console.debug` and
dropped the message; `attach-client.ts:252-253` was `default: break;`;
`packages/web/src/lib/websocket-client.ts:369-371` returns from
`deserialize` with no `else` branch when the type is unrecognized. One
direction was already loud: `connection.ts` replies `UNKNOWN_MESSAGE` to
the client when its inbound switch has no case for a type
(`connection.ts:380-381` at the time of the epic's plan, now
`route-client-message.ts` + `connection.ts:312-315`).

The defect this exposes: **forgetting to handle a new message type and
deciding that a consumer should ignore it produce identical code** — both
are nothing. A reviewer reading a `switch` with no case for `question_snapshot`
cannot tell whether that was a decision or an oversight, and the type
checker cannot tell either, because a `switch` over a union does not require
covering every member unless something in the `default` branch forces it.

## Decision

**Every consumer of `ProtocolMessage` must declare, for every registry key,
either a real handler or the literal string `'ignore'`.** `MessageHandlers<TType, R>`
(`packages/shared/src/dispatch.ts:25-27`) is a mapped type requiring one
entry per key of `TType`; `dispatchMessage` (`dispatch.ts:33-39`) routes to
it, returning `undefined` when the entry is `'ignore'`. Adding a key to
`ProtocolMessageMap` breaks every `MessageHandlers<keyof ProtocolMessageMap>`
object's compile (`Property '<type>' is missing`) until each consumer
decides.

Two equivalent shapes exist in shipped code, both migrated as part of this
epic and both total by construction:

- **Object-literal total map + `dispatchMessage`**: `attach-client.ts:234-314`
  builds a `MessageHandlers<keyof ProtocolMessageMap, void>` with a real
  closure per handled type and `'ignore'` for the rest (`agent_output`,
  `hello`, `ack`, ... — lines 270-312), then calls `dispatchMessage(msg, handlers)`
  (line 314). `route-client-message.ts` wraps the same mechanism narrowed to
  `ClientToDaemonType` (`ClientMessageHandlers`) and is shared by
  `connection.ts:276-311` and the relay adapter, each building its own
  handler map over its own event bag (`ClientMessageHandlers` doc comment,
  `route-client-message.ts:12-21`).
- **Exhaustive `switch` + `assertNever`**: `App.tsx`'s `handleMessage`
  (around line 1580 through 1715) keeps a `switch` but every case is now
  explicit — including no-op groups with a comment explaining *why* they're
  no-ops (e.g. `case 'hello': case 'user_input': ... break;` at lines
  1648-1663, commented as "this client SENDS every one of these... should
  never actually observe one arriving here") — and the `default` branch
  calls `assertNever(message)` (`App.tsx:1713`, helper at `dispatch.ts:48-50`),
  which only type-checks if every member of the union was already narrowed
  away by an earlier `case`. A missing case is a `tsc` error, not a runtime
  no-op.

Both shapes satisfy the same property — "the compiler will not let a new
registry key go unmentioned" — via different syntax. `App.tsx`'s explicit
`break` groups are the `'ignore'` equivalent for a `switch`-based consumer;
they read differently but decide the same thing.

**The daemon's inbound `UNKNOWN_MESSAGE` default is deliberately kept, not
migrated away.** `connection.ts:312-315` still sends
`sendError('UNKNOWN_MESSAGE', ...)` when `routeClientMessage` returns
`false`; `relay-adapter.ts`'s equivalent path replies `UNSUPPORTED` naming
the type. This is correct because the daemon is a *server* answering a live
peer at runtime: an unrecognized inbound type might be a real client running
an older or newer protocol version, and the peer benefits from an explicit,
immediate reply it can act on (log it, warn the user, fall back). A
d2c-facing consumer like the web app has no equivalent peer to answer — the
"error" would have to become a user-visible bug report for what is, by
construction, a bug in shipped code (a registry key the app was never told
about), not a live protocol negotiation. Total dispatch moves that failure
from a silent runtime drop to a compile-time refusal to ship, which is the
correct fix for a build-time-knowable problem; a runtime loud default
remains the correct fix for the daemon's problem, because the daemon cannot
know at build time what a not-yet-built client will someday send it.

## Consequences

Easier: a reviewer can grep `'ignore'` (or an explicit no-op `case`/`break`
group) and see every deliberate no-delivery decision in one pass, with the
reasoning attached as a comment at the point of decision. Adding a message
type is now guaranteed to touch every consumer's source, even if the touch
is one line reading `'ignore'`.

Harder: the mechanical fallout of "every consumer mentions every type" is
verbose handler maps and switches — `attach-client.ts`'s handler map alone
is ~80 lines, most of it `'ignore'`. That verbosity is deliberate friction,
not an oversight to clean up.

**The real acceptance criterion, and that the original one was wrong.**
#883's stated criterion was "the file count drops" — measured as
`grep -rln "question_resolved" ... | wc -l`, which stood at 13 in the issue
body. It was re-measured after C1-C5 and C8 landed and **had not moved**:
still 13. The epic's own halfway-checkpoint comment records the
correction directly: *"The file count was a bad proxy and I should not have
written it as the criterion... exhaustiveness makes every consumer mention
it more explicitly, not less. A file that previously swallowed the message
in a silent `default` now names it. That is the improvement, and it looks
identical to the grep."* A wrong metric that survives into an ADR is worse
than no metric — it launders a discredited number into a document with
implied authority — so it is recorded here as wrong, not restated as fact.

The criterion that actually mattered was **edit sites**, measured directly
rather than inferred from a grep on an existing type: C7 (#900, PR #922)
added a real scratch inbound message type end-to-end twice — once on
pristine `develop` (10 files touched) and once on the post-C7 branch
(8 files) — then reverted both, with the drop attributed specifically to
`websocket-server.ts`, `websocket-adapter.ts`, and `connection-adapter.ts`
falling out of the edit set entirely once the event-interface duplication
they carried was collapsed. That is a measured result, not an assertion.

**A guard can be load-bearing and still never run on the change it guards.**
C8 (#901, PR #910) found that `.github/workflows/macos-app.yml` is
path-filtered to `packages/macos/**`, `packages/web/src/lib/native-host.ts`,
`scripts/stage-macos-web.sh`, and the workflow file itself — `protocol.ts`
is not in that list — and the workflow's own header comment states it is
"NOT a required gate (plan decision: promote once flake behavior on macos
runners is known)". A change to `packages/shared/src/protocol.ts` alone
never triggers the Swift-side conformance tests C8 added at all. The TS
mirror test (`packages/shared/tests/macos-fixture-conformance.test.ts`,
running under the ordinary `bun test` gate) is therefore the only guard an
ordinary protocol PR actually exercises; the Swift suite is real, correctly
written, and currently exercised by nothing an ordinary PR triggers. This is
a distinct failure mode from ADR 0011's "decorative-in-code" (a test that
does not construct the thing it is named for): here the test is correct and
would catch the break, but CI configuration keeps it from running on the
diff that needs it. Both are worth checking for separately.

## Alternatives considered

- **Keep silent defaults and rely on code review to catch missed cases.**
  This was the status quo; it already failed once in shipped code (see ADR
  0014's `useConnectionManager.ts` case) and offers no mechanical signal —
  a missed case and a reviewed-and-intended no-op are visually identical in
  a diff.
- **A runtime warning instead of a compile-time requirement** (e.g. log
  `console.warn` for any unhandled type at dispatch time). Rejected: this
  still ships the bug; it only makes the bug noisier after the fact instead
  of preventing it from shipping. The whole point is to move the failure to
  build time, when it is free to fix.
- **One shared dispatch shape for every consumer** (force `App.tsx` onto
  `MessageHandlers`/`dispatchMessage` instead of a `switch`+`assertNever`).
  Not pursued: `App.tsx`'s replay/recursion handling
  (`replay_batch` re-entering `handleMessage`, `inReplay` flag,
  `useCallback([])` plus refs) is easier to reason about as a switch in
  place than as an object of closures, and the compile-time guarantee is
  identical either way. Forcing a single shape would have been uniformity
  for its own sake, not for a functional reason — the same style of
  rejection ADR 0009 gives for uniform transport encryption.

## Receipts

- `packages/shared/src/dispatch.ts` — `MessageHandlers`, `dispatchMessage`,
  `assertNever`, all with doc comments explaining the `'ignore'` rationale
- `packages/daemon/src/cli/attach-client.ts:234-314` — object-literal total
  map over the full 45-key registry
- `packages/web/src/App.tsx` (`handleMessage`, ~lines 1580-1715) —
  exhaustive `switch` + `assertNever`, including the commented no-op groups
- `packages/daemon/src/server/route-client-message.ts` — `ClientMessageHandlers`,
  `routeClientMessage`, shared by `connection.ts:276-315` (loud
  `UNKNOWN_MESSAGE`) and `relay-adapter.ts` (loud `UNSUPPORTED`)
- `.github/workflows/macos-app.yml` — path filter and the "NOT a required
  gate" header comment C8 cites
- #883 (epic), halfway-checkpoint comment: the file-count criterion
  correction, quoted above
- #900 (C7), PR #922: the 10 → 8 measurement, and the three files
  (`websocket-server.ts`, `websocket-adapter.ts`, `connection-adapter.ts`)
  that dropped out of the edit set entirely
- #901 (C8), PR #910: the macOS CI-gate finding
- ADR 0011 — "Verify before you describe"; this ADR's CI-gate finding is a
  sibling failure mode, not a restatement of it
