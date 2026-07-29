# ADR 0011: Security descriptions must be verified against code before they are written

**Status:** accepted
**Date:** 2026-07-28
**Owner:** Yahya

## Context

Over one working session, five separate places in this repo were found to
describe security behavior the code did not have. These were not typos; each one
hid a real defect, and two of them hid it for months.

| Claim | Reality | Issue |
|---|---|---|
| "peer-to-peer, TURN relays encrypted blobs" (`AGENTS.md`) | no WebRTC exists; the Worker was the plaintext data path | #543 |
| "auto = based on bind address" (`AuthConfig.enabled`) | resolves to `false` on every bind including `0.0.0.0` | #880 |
| allow patterns match tool names (`config.ts`) | substring match; `Read` covered `cat x \| sh` | #536 (P0) |
| `relay-adapter-auth.test.ts` "tests the relay adapter" | never constructs one; 29 tests that could not fail | — |
| "the relay is end-to-end encrypted now" | the client half was never implemented | #881 |

The mechanism is consistent: **a wrong security description reads as "this is
handled", so nobody looks again.** Docs that overstate protection are more
dangerous than docs that are missing, because missing docs prompt a reader to
check.

Two of the wrong claims were written *during the pass that was correcting the
others*, which is the finding that motivated recording this as a decision rather
than a style note.

## Decision

**A claim about security behavior must be verified against the code before it is
written, and the verification is part of the change.**

Codified in `AGENTS.md` → "## Verify before you describe" as five rules:

1. Before citing a doc or comment as evidence something is safe, check the code.
   One `grep`, one `curl`, one `git log -S`. Every case above was settled by a
   single command.
2. A claim about a live data path needs a caller trace. Grep for callers before
   asserting impact, and before filing the issue.
3. When code and comment disagree, fix the comment in the same change, even when
   the behavior fix belongs to someone else. Leave the issue number in the comment.
4. Say what ships, not what was intended. Aspirations belong in issues.
5. A test named for a component must construct it.

## Consequences

Easier: claims in this repo become checkable, and a reader can trust a security
comment enough to build on it.

Harder: writing security documentation is slower, and correcting documentation
is slower still — the correction pass is where confidence is highest and the
check is most likely to be skipped. Both errors in this session were made there.

New obligations: reviewers of documentation changes must verify claims rather
than assess prose, since a well-written wrong claim is the failure mode. The
`AGENTS.md` table is append-only; new instances get added rather than the
section being tidied, because the list of past failures is the argument.

## Alternatives considered

- **Treat it as a review checklist item.** Rejected as insufficient: two of the
  five were introduced *by* a careful review pass. The discipline has to sit with
  the author at the moment of writing.
- **Automate it (lint for security claims).** Attractive and not yet tractable —
  there is no reliable way to detect "this sentence asserts a security
  property". Revisit if a pattern emerges. Partial automation is possible for
  the narrower rule 5 (a test file naming a class that it never imports).
- **Write fewer security comments.** Rejected. The comments are load-bearing;
  `relay-crypto.ts`'s "what it does not do" section is exactly what a future
  reader needs. The problem is unverified comments, not comments.

## Receipts

- `AGENTS.md` → "## Verify before you describe"
- PR #882 (the corrections, and the review that caught two fresh errors in them)
- #881 — filed three times with three different severities, each earlier version
  wrong in a way one grep would have prevented. The filing history is kept in
  the issue body deliberately.
