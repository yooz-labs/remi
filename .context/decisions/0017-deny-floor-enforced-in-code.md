# ADR 0017: A model-produced deny is silent, so it is floored in code, not by instruction

**Status:** accepted
**Date:** 2026-08-01
**Owner:** Yahya

## Context

`prompt-builder.ts`'s SYSTEM_PROMPT_BODY states a DENY FLOOR rule: deny only a
short, explicit list of catastrophic operations; for anything else the model
would refuse but that is not on that list — remote mutations, pushes, writes,
unknown commands — the instruction is to escalate, never deny, because
escalating lets the user answer and denying blocks them. Until #953 that rule
had zero enforcement behind it. The config `deny`/`deny_groups` lists default
to `[]`, so a model verdict of `'deny'` was returned to the hook as-is.

This matters more than an ordinary prompt-compliance gap because `deny` is
silent by construction: `auto-approve-gate.ts` returns `'deny'` straight to
the hook and pushes no question card. The user is not asked and never learns
the operation was attempted. An over-eager deny is not "merely conservative"
— it is the one verdict that removes the human from a decision that was
explicitly designed to reach them, which is the opposite of "My agent needs
me. Yes or No."

Measured on the shipped 4B model against this repo's own prompt, 16 cases: 10
of 12 escalate-expected operations (`rm -rf ./build`, `git push --force origin
main`, `DROP TABLE`, `ssh`, `curl -X DELETE`, `find -delete`, ...) came back
`deny` instead, while all four controls were correct. The model was not
confused about the rule — on `rm -rf ./build` it reasoned "while not in the
strict DENY FLOOR" and denied anyway. A prompt instruction the model can state
correctly and then not follow is not enforcement.

## Decision

**A model-produced `deny` is downgraded to `escalate` in plain TypeScript,
after the model has answered, unless the operation matches a small hardcoded
catastrophic-pattern list** (`rm -rf /`, `sudo rm`, `rm -rf /etc|/usr|/System`,
piping into `sh`/`bash`, `chmod 777`). `enforceDenyFloor` runs blind to the
model's stated reasoning — a confidently-worded justification cannot buy a
deny the pattern list does not independently support — and only ever moves in
one direction: `deny -> escalate`. It never produces a `deny` of its own and
never touches `approve` (a different guard's job — see ADR 0015).

Config-level `deny`/`deny_groups` matches never reach this code at all; they
short-circuit in `AutoApproveService.evaluate` and return before the LLM is
called. This guard applies exclusively to denies the model itself produced,
which is the entire population the "deny is rare" prompt rule was written to
constrain.

## Consequences

Easier: "deny is rare" is now a property that can be tested against real tool
calls instead of a sentence the model is asked to honor. The escalate this
guard produces is strictly better than the deny it replaces in both
directions — the operation still does not run unattended, and the user now
gets a card they can answer instead of a block they never saw happen.

Harder, and accepted on purpose: this can only ever make the daemon ask more,
never refuse more silently, so a real security boundary still has to live
somewhere else (the config `deny`/`deny_groups` lists, and the catastrophic
pattern list itself). `enforceDenyFloor` is not a way to make denial safer; it
is a way to make an unjustified denial visible instead of invisible.

**New obligation, and the reason this ADR exists.** The catastrophic-pattern
list is shared, in opposite directions, with `enforceAuthorityBoundary`
(ADR 0015): widening it makes the authority guard STRICTER (more approves
downgraded) but makes this guard LOOSER (more denies left standing, i.e. fewer
questions reach the user). A future reader who sees two guards sharing one
list and "cleans up" by giving each its own copy will silently decouple two
guards whose whole design is a deliberate trade-off along a shared list — and
a reader who does not know about that coupling and grows the list to "catch
one more bad case" is quietly making unrelated denies stick. An entry belongs
on the list only if it is genuinely catastrophic — something that should be
refused outright rather than asked about — not merely undesirable.

Also worth stating plainly: this is a narrower, differently-shaped decision
from ADR 0015 even though both are "re-check the model's verdict in code,
blind to its reasoning, after it answers." ADR 0015 stops authority text
talking the model INTO an unjustified approve; this stops the model denying,
in silence, something the product's own rule says should be a question
instead. They share a shape and a pattern list; they do not share a failure
mode, and folding them into one ADR would hide that the evidence tables
(five-run authority flips vs. 10-of-12 escalate-expected denials) are
independent measurements of independent bugs.

## Alternatives considered

- **Trust the prompt-level "deny is rare" instruction.** This was the status
  quo. Measured false, 10 of 12.
- **Widen the model's deny-eligible list instead of catching it after the
  fact.** Rejected: the model already had a specific, correctly-stated DENY
  FLOOR and denied outside it anyway. A larger list the model is still free to
  ignore does not close the gap the measurement found.
- **Escalate every model deny unconditionally, no catastrophic-pattern
  carve-out.** Rejected: it would remove the model's ability to refuse
  anything at all, including the operations the DENY FLOOR exists to let it
  refuse outright.

## Receipts

- `packages/daemon/src/auto-approve/deny-floor.ts` — `CATASTROPHIC_PATTERNS`,
  `matchesCatastrophicPattern`, `enforceDenyFloor`
- `packages/daemon/src/auto-approve/auto-approve-service.ts:917-932` — the
  live call site (before the authority-boundary check at the same layer;
  the two are disjoint by construction — this one only ever sees `deny`, that
  one only ever sees `approve`)
- `packages/daemon/tests/auto-approve/deny-floor.test.ts`
- #953 (this guard, the 10-of-12 measurement), ADR 0015 (the sibling guard and
  the shared pattern-list trade-off)
