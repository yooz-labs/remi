# ADR 0016: Strictness is level-gated group membership, never prose to the model

**Status:** accepted
**Date:** 2026-08-01
**Owner:** Yahya

## Context

Before #956/#963/#966, the only way to make auto-approve more permissive than
its curated `read-only`/`vcs-read`/`build-test` groups was the free-text
`instructions` field, threaded into the LLM prompt and labeled MANDATORY,
repeated at the end of the prompt for recency, each repetition added because a
prior instance of this same problem had already been found once.

It still did not hold. Measured on one machine over 796 evaluations: the 244
deterministic group approvals were honored exactly, every time, at 0ms. Of the
226 escalations, 35 explicitly cited the user's own `instructions` and
escalated anyway (`"While the user guidance mentions approving writes...
requires user judgment"`), and 57 were plain writes against a config whose
prose already told the model to approve them. Restating the rule more
forcefully was not available as a fix; the prompt already did that.

## Decision

**The permissive half of a policy is expressed as named levels
(`strict`/`balanced`/`trusted`) over the same deterministic permission groups
the deny/allow path already uses, not as adjectives asked of the model.**
`strict` is exactly today's shipped `approve_groups` default
(`read-only`, `vcs-read`, `build-test`) so upgrading changes nothing until a
user opts up; `balanced` adds `fs-write`; `trusted` adds `vcs-write` (local git
mutation only, never `git push`). Each level is a strict superset of the one
before it, asserted by test, so "raise the level" means unambiguously "approve
more."

`instructions` keeps its prompt placement but is demoted from policy to the
exception layer: project-specific carve-outs the groups cannot encode
("escalate anything touching packages/signaling"), which is what prose is
actually good at, rather than the base grant/deny surface.

`trusted` is not the shipped default despite being the most convenient one.
Phase 2 (#959) needed four adversarial review rounds to close eleven bypasses
in the write groups, three of which were found in code written to fix the
previous round (see ADR 0018). Shipping `trusted` by default in the same
change that introduced the switch would have bundled "does the mechanism
work" together with "is this policy right." Flipping the default is
deliberately left as its own one-line PR, after the mechanism has run on a
real machine.

## Consequences

Easier: the permissive half of the policy is now checkable the same way the
deny/allow lists always were — `groupsForLevel`/`resolveApproveGroups` are
pure functions, testable without a model or a daemon. A user's effective
policy is always exactly one of three known group sets, logged with its
source (`level` vs `explicit`), never an inference about what a 4B model did
with a paragraph.

Harder: any policy shape the three levels cannot express (a group with a
narrower footprint than `fs-write`, for instance) has no home except
`instructions`, which is exactly the exception layer this ADR just said not to
lean on for anything load-bearing. That tension is intentional, not an
oversight — a fourth mechanism was rejected (see below), so a genuinely new
policy shape means a new group, not a workaround in prose.

**New obligation, and the reason this ADR exists.** A future reader who has
not seen the 796-evaluation table will look at three fixed presets next to a
free-text `instructions` field and see redundancy: "why not just let
`instructions` say `level = trusted` in prose and skip the enum?" That
recommendation reopens the exact failure this measured: prose is not obeyed at
the rate an enforced group membership is, even when the model is told the
prose is mandatory and reads it twice. `instructions` is for what the three
levels cannot encode, not an alternate spelling of a level.

An explicit `approve_groups` OVERRIDES the level rather than merging with it,
which will also look like an inconsistency worth "fixing" to a union.
Deliberate: a union can only widen, so a user who narrowed their list below a
level's defaults would have it silently widened back by a level they never
asked to combine with; and a user who wrote an explicit list meant that exact
list.

## Alternatives considered

- **Sharpen the prompt further.** This was the status quo across #893's Q9
  work; the 35/226 and 57/226 cohorts above are what "sharpen" produced before
  levels existed. Diminishing, then negative, returns on a 4B model.
- **A continuous trust score instead of three discrete levels.** Rejected: a
  score still has to bottom out in "which groups are on," and a continuous
  input is harder to test and harder for a user to reason about than three
  named presets they can read the group list for.
- **Ship `trusted` as the default.** Rejected for this change specifically —
  see Decision. Tracked as a deliberate follow-up, not a rejected idea.

## Receipts

- `packages/daemon/src/auto-approve/levels.ts` — `AUTO_APPROVE_LEVELS`,
  `DEFAULT_AUTO_APPROVE_LEVEL`, `LEVEL_GROUPS`, `resolveApproveGroups`
- `packages/daemon/src/config/config.ts:318,323,478-551` —
  `approve_groups: ['read-only', 'vcs-read', 'build-test']` default,
  `applyLevel` (explicit-vs-preset resolution, decided from the raw parsed
  table so a defaulted value can never look explicit)
- `packages/daemon/tests/auto-approve/levels.test.ts` — `strict`'s groups
  equal the shipped default (test, not comment); each level is a superset of
  the one below
- #956 (levels epic), #959/#960 (write groups, four review rounds, eleven
  bypasses — see ADR 0018), #963 (level presets), #966 (level-aware prompt
  defaults), #893 (the `instructions`-cited-and-escalated-anyway measurement)
