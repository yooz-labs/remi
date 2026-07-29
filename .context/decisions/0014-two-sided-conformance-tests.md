# ADR 0014: Contract tests must construct the shipping implementation of both endpoints

**Status:** accepted
**Date:** 2026-07-29
**Owner:** Yahya

## Context

Two protocol bugs shipped, live, in the same file this epic set out to
unify — and neither was found by review, by the existing test suite, or by
real use. Both are worth reading before the principle, because the
principle alone undersells how ordinary each failure looked from inside its
own PR.

**Case 1 — the relay key exchange (#543, #881).** #543 shipped the
daemon-side half of a signed ephemeral-key exchange for relay traffic.
`createAuthResponse` (`packages/shared/src/protocol.ts:1753-1770`) takes an
optional fourth argument, `relayKex`, carrying the client's signed ephemeral
public key. The only production call site,
`packages/web/src/hooks/useConnectionManager.ts:213`
(`return createAuthResponse(identity.publicKeyRaw, signature, identity.fingerprint);`),
never passes it. **The client half of the exchange was never written.** The
daemon therefore rejects every real client's key exchange as
`RELAY_KEX_FAILED`.

`packages/daemon/tests/remote/relay-encryption.test.ts` stayed green
throughout. Its `completeHandshake` helper (lines 118-171) is a test-local
stand-in for "the way a current web client would" answer a challenge (its
own doc comment, line 115) — and unlike the real client, it *does* build a
`relayKex` object and pass it as the fourth argument to `createAuthResponse`
(lines 138-149, 161-166). The test asserts the daemon's handshake logic is
correct. It cannot, by construction, notice that nothing shipping calls
that logic with the arguments the test supplies.

**Case 2 — the relay answer handler (#915).** `connection.ts`'s
`handleAnswer` (`connection.ts:455-475`) has forwarded structured
AskUserQuestion `selections`/`cancel` fields since #627 — the daemon uses
them to drive a TUI's multi-select or to escape it. `relay-adapter.ts`'s
parallel `answer` case, a second hand-rolled implementation of the same
routing, forwarded only `questionId`/`answer`/`claudeSessionId` — **it
silently dropped `selections` and `cancel` for every answer that arrived
over the relay.** Answering a multi-select question from a relay-connected
client (the primary use case for the relay: a phone, off the LAN) silently
lost the user's selection. This was found only when C6 (#899, PR #915) put
the two switches next to each other in order to merge them into
`route-client-message.ts`; the fix is now shared code
(`connection.ts:455-475` and `relay-adapter.ts:563-579` compute the same
`extra` shape), and `relay-adapter.ts:564-566`'s comment names the bug
explicitly: "previously dropped over relay (found while unifying this
dispatch)".

## Decision

**A contract test must construct the shipping implementation of both
endpoints of the contract it claims to cover.** A synthetic counterparty —
a test-local stand-in that plays "the way a real client would" without
being the real client — silently converts a two-sided test into a one-sided
one. The test still exercises real logic and can still fail; what it cannot
do is notice that the *other*, real side never matches the behavior it
assumed.

The general lesson, stated plainly because it is worth more than either
case alone: **a duplicated protocol implementation does not stay
duplicated. It drifts, and the drift is invisible because each copy is
individually plausible and individually tested.** Both cases above were
live in shipped code for real users. Neither was caught by code review,
by the pre-existing test suite, or by anyone using the feature — only by
directly unifying the two implementations and finding they disagreed.

**Honest test labelling is part of the same discipline.** C6's relay
conformance suite,
`packages/daemon/tests/relay-client-to-daemon-conformance.test.ts`, drives
the real, shipping `RelayAdapter` through its `createTransport` seam (a
fake transport standing in for the signaling Worker connection) rather than
a real remote client, because #881 means no real client can complete a
relay handshake — building one just for this test would itself be the
synthetic-counterparty problem this ADR describes. Rather than let the test
imply more coverage than it has, its module doc says so directly ("This is
NOT an end-to-end relay test — said plainly, per AGENTS.md 'Verify before
you describe'") and its `describe` title repeats it verbatim:
`describe('daemon inbound dispatch: RelayAdapter transport-seam conformance (#899, NOT end-to-end)', ...)`
(`relay-client-to-daemon-conformance.test.ts:138`). Mislabelling this test
as end-to-end would have been the same failure this ADR exists to prevent,
just moved one level up — a test whose name overclaims what it covers, the
same shape as `relay-adapter-auth.test.ts` below.

**`relay-adapter-auth.test.ts` remains the canonical example of the
shape**, with one correction to how it has been described. The file has
**8** tests (`bun test packages/daemon/tests/relay-adapter-auth.test.ts` →
`8 pass, 0 fail`), not the 29 previously recorded for it — see "Correction"
below. What holds regardless of count: it names `RelayAdapter` in its
header comment ("Tests for RelayAdapter authentication and code rotation")
and in a `describe` title ("RelayAdapter auth flow",
`relay-adapter-auth.test.ts:53`), and never imports or constructs one — it
tests `Authenticator` and `SignalingClient` directly. A reader who trusts
the file name or the `describe` title over the imports would believe this
covers `RelayAdapter`; it does not construct the thing it is named for.

### Correction to prior art

ADR 0011's table (`.context/decisions/0011-verify-before-you-describe.md`)
and this epic's own issue text (#883, #902) both state
`relay-adapter-auth.test.ts` has "29 tests that could not fail." Verified
against the file while writing this ADR: it has 8 (`grep -c "^\s*test("
packages/daemon/tests/relay-adapter-auth.test.ts` → 8;
`git log -p --follow` shows only 8 `test(` lines were ever added across the
file's history — it did not shrink during this epic). The core claim — the
file is named for `RelayAdapter` and never constructs one — holds regardless
of count and is the one that matters; the number was wrong and is corrected
in the same change here and in ADR 0011, per `AGENTS.md` rule 3 ("when code
and comment disagree, fix the comment in the same change, even when the
behavior fix belongs to someone else"). This correction is itself a small
instance of the pattern this ADR is about: an unverified number about test
coverage, repeated across two documents, neither of which had run the
suite.

## Consequences

Easier: a future reader can trust "N tests" and "this covers X" claims about
a test file enough to build on them, and a reviewer has a concrete question
to ask of any new contract test — "does this construct both real
endpoints, or does one side pretend?" — instead of relying on the test's
name or its green checkmark.

Harder: two-sided conformance tests cost more to write than a synthetic
counterparty, because they require the real implementation of both sides to
be constructible in a test process at all (a real `WebSocketAdapter` and a
real `WebSocketClient` over one real `Bun.serve` socket, in
`client-to-daemon-conformance.test.ts` and its predecessor
`message-dispatch-conformance.test.ts`, is the pattern this repo already
had available before the epic — `websocket-client.test.ts` proved the seam
years earlier). When a real second side does not exist yet — the relay's
web client, per #881 — the honest choice is a labelled transport-seam test,
not a synthetic client dressed up as one.

New obligation: any new wire contract between two components in this repo
gets a test that constructs both shipping sides, or an explicitly labelled
partial test stating which side is faked and why (module doc plus
`describe` title, matching `relay-client-to-daemon-conformance.test.ts`'s
shape). "It has tests" is not sufficient evidence a contract is covered;
what constructed the other end is the question that matters.

## Alternatives considered

- **Trust test names and `describe` titles as documentation of coverage.**
  This was the status quo and is what let both cases above ship
  undetected — `relay-adapter-auth.test.ts` has looked like `RelayAdapter`
  coverage since it was written (#22).
- **Require 100% two-sided coverage before allowing any transport-seam
  test.** Rejected as impractical here: #881 means a real relay client does
  not exist yet, so a strict rule would have blocked C6 (#899) entirely
  rather than let it ship the daemon-side unification with an honestly
  labelled gap. The labelling requirement gets the same transparency
  without blocking work that is genuinely one-sided today for a real,
  external reason.
- **Fix the two found bugs and move on without a policy.** Rejected: the
  epic's own comments call this out directly — both bugs were found by
  coincidence, during unification work aimed at something else, using a
  suite that had been green the whole time. Without naming the pattern,
  the next duplicated implementation drifts the same way and gets found the
  same way: by luck, or not at all.

## Receipts

- `packages/web/src/hooks/useConnectionManager.ts:213` — the missing fourth
  argument
- `packages/shared/src/protocol.ts:1753-1770` — `createAuthResponse`'s
  optional `relayKex` parameter
- `packages/daemon/tests/remote/relay-encryption.test.ts:114-171` — the
  test-local `completeHandshake` client that offers `relayKex` when no
  shipping client does
- `packages/daemon/src/server/connection.ts:455-475` — `handleAnswer`,
  forwarding `selections`/`cancel` since #627
- `packages/daemon/src/remote/relay-adapter.ts:563-579` — the fixed relay
  `answer` handler, comment naming the bug found during C6
- `packages/daemon/tests/relay-client-to-daemon-conformance.test.ts:1-40,138`
  — the module doc and `describe` title stating "NOT end-to-end"
- `packages/daemon/tests/relay-adapter-auth.test.ts` — 8 tests (verified by
  running the file), `RelayAdapter` named in comment and `describe` title,
  never imported
- #543 (relay encryption shipped), #881 (the client half never
  implemented, found while writing an unrelated README fix)
- #899 (C6), PR #915 — "A real bug found while unifying, now fixed"
- #883 (epic), third comment ("The finding that actually justifies this
  epic") — states both cases and the general lesson this ADR restates
- `.context/decisions/0011-verify-before-you-describe.md` — corrected in
  this change (test count)
- `AGENTS.md` → "Verify before you describe"
