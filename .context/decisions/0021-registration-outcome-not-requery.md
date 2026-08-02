# ADR 0021: Question registration outcome flows from the call, not a later re-query

**Status:** accepted
**Date:** 2026-08-01
**Owner:** Yahya

## Context

`MessageAPI.handleQuestion` used to return `void`. Callers that needed to
know whether the question they just pushed actually became live — as
opposed to being silently absorbed by `QuestionDedup`'s content-identity
window, or (before #888) simply not checked at all — had no way to find out
except re-querying `SessionRegistry` afterward. Two independent silent-drop
defects (#925, #926) traced to exactly that gap.

A `boolean` return looked like the obvious fix and was rejected during #888
for a specific reason: `true` would have to mean both "registered" (the
ordinary case) and "held" (the #573 load-bearing escalation that
*deliberately bypasses* `QuestionDedup` because its card is what makes a
held hook answerable at all). Collapsing those into one truthy value invites
exactly the boolean-blindness bug this change exists to prevent — a caller
that only checks truthiness cannot tell "this is a normal push" from "this
is the one push in the codebase that must never be treated as ordinary."

`QuestionPresenceTracker.pairAndPush` is the sharpest case this fed into,
because it had already shipped a version (V1) that got the re-query approach
wrong in a way review caught rather than production: an id-comparison-only
check could resolve a question that never actually left the screen, for two
independent reasons — the PTY parser mints a fresh id on every parse even
when a prompt merely redraws with unchanged text (#486), and a genuinely new
render can be silently eaten by `QuestionDedup`'s 5s same-fingerprint window
before it ever reaches `SessionRegistry.addQuestion`. V1 resolved the old id
on the strength of the new render having merely been *parsed*, not
*delivered*. The measured cost of the underlying hookless-question leak this
mechanism was built to close: 12 of 29 source-less questions captured over
one working day never got removed by any existing path, one still pending
2h51m later.

## Decision

**A caller that needs to know whether a question registration actually took
effect consumes the outcome returned directly by the call that performed the
registration — never a store re-query taken afterward, and never a bare
boolean.** `QuestionRegistrationOutcome` (`message-api.ts`) is a
discriminated union — `{status: 'registered'}` / `{status: 'deduped'}` /
`{status: 'held'}` — so a `switch` on `.status` gets TypeScript exhaustiveness
checking; a fourth outcome added later breaks every such switch at compile
time instead of silently falling through one of them.

Both hand-rolled consumers that used to re-query the store now consume this
return value directly:

- `QuestionPresenceTracker.pairAndPush` treats `outcome?.status === 'registered'`
  as its confirmed-delivery gate before resolving the previously-tracked
  hookless question as gone (`noteHooklessGone`). The push call chain is
  synchronous end to end (push → `MessageAPI.handleQuestion` →
  `QuestionDedup` → `SessionRegistry.addQuestion`), so the returned outcome
  is exactly as current as a post-hoc store query would have been, without
  the two id-comparison failure modes V1 had.
- `hook-bridge-setup.ts`'s `rememberElicitation` uses the same outcome to
  refuse letting an id that was never actually registered displace a
  tracking entry that points at a still-live card (the #889 review finding:
  a re-fired `Elicitation` for the same `elicitation_id` is a dedup case, not
  a richer replacement, and overwriting blindly stranded the live card).

## Consequences

Easier: both consumers reason about "did this registration take effect" as a
value they already have, not a question they have to go ask something else —
removing an entire class of TOCTOU-shaped bug where the store's state could
have moved between the push call and the follow-up query.

Harder, and the reason this ADR exists: **the discriminated union is easy to
misread as over-engineering for something a `boolean` would cover, especially
by a reader who has not seen the V1 failure chain or the `held` collapse
this specifically prevents.** The wrong "cleanup" this ADR heads off is
narrowing `QuestionRegistrationOutcome` back to `boolean`, or replacing a
consumer's outcome check with a re-query of `SessionRegistry` for
"simplicity" — both reopen exactly the bug class #888/#925/#889 closed. A
push whose outcome is not `'registered'` (deduped, or a sink that reports no
outcome at all) must change nothing in the caller's tracked state — the same
"when ambiguous, resolve toward showing the user rather than hiding a live
question" bias this codebase applies elsewhere — even though that means an
unconfirmed push occasionally loses one resolution trigger; the alternative
is resolving a question that is still live on the real screen, which is the
disqualifying failure this mechanism exists to avoid.

## Alternatives considered

- **`boolean` return.** Rejected: collapses `'registered'` and `'held'` into
  the same `true`, and those two outcomes are handled differently by design
  (`held` bypasses dedup on purpose; `registered` does not).
- **Keep `void` and let callers re-query `SessionRegistry` after every
  push (the pre-#888 pattern, and `pairAndPush`'s own V1).** Rejected on
  measured evidence: V1's id-comparison-only version of this re-query could
  and did resolve a question that had not actually left the screen, via
  either the fresh-id-on-redraw hazard or a dedup-swallowed replacement.
- **A separate `isQuestionLive` dependency queried after the push, instead
  of consuming the push call's own return value.** This was the design
  `pairAndPush` deleted moving to the current mechanism; rejected because it
  reintroduces the same post-hoc-query timing gap the direct-return design
  removes, for no benefit over reading the value the call already produced.

## Receipts

- `packages/daemon/src/api/message-api.ts:14-43` — `QuestionRegistrationOutcome`,
  its doc citing #925/#926 as the two silent-drop defects and the
  boolean-blindness reasoning for rejecting a `boolean`
- `packages/daemon/src/api/question-presence-tracker.ts:588-652` —
  `pairAndPush`'s confirmed-delivery gate and its documented V1 failure
  chain (fresh-id-on-redraw, dedup-swallowed replacement); the module doc
  at the top of the file for the "12 of 29... one still pending 2h51m"
  measurement that motivated closing the leak
- `packages/daemon/src/cli/session-phases/hook-bridge-setup.ts:435-484` —
  `rememberElicitation`'s use of the same outcome type (the #889 review
  finding, "same defect class as #925")
- #888 (Q3, "finish the QuestionStore contract — registration outcome,
  classification assertions, replay + soak"), PR #925 (extracted
  `QuestionStore`, resolved hook-less questions on render-gone), #920
  (stale-PTY-card issue this closes the resolution gap for), #486 (PTY
  parser mints a fresh id on every parse), #573 (held escalation bypasses
  dedup)
