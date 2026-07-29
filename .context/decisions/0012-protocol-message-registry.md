# ADR 0012: Protocol message registry as the single source of truth

**Status:** accepted
**Date:** 2026-07-29
**Owner:** Yahya

## Context

Before this change, `packages/shared/src/protocol.ts` maintained the
`ProtocolMessage` discriminated union and the `validTypes` allowlist inside
`isValidMessage` as two independently hand-written 45-entry lists, with
nothing checking them against each other. Adding a message type meant
remembering to edit both. Forgetting the second one failed silently:
`deserialize` just returns `null` for that type, repo-wide, with no
exception and no log line pointing at the cause.

This is the type-system version of the pattern `AGENTS.md` → "Verify before
you describe" already names for prose: two descriptions of the same thing,
kept in sync by discipline, drift, and the drift is invisible until
something downstream breaks.

## Decision

**One registration point; everything else is derived from it.**

`ProtocolMessageMap` (`packages/shared/src/protocol.ts:73-119`) maps each
wire `type` discriminant to its message interface. `ProtocolMessage` is now
`ProtocolMessageMap[keyof ProtocolMessageMap]` (`protocol.ts:153`) instead
of a hand-written union, so a new registry entry joins it automatically.
`isValidMessage`'s runtime allowlist is `new Set(Object.keys(MESSAGE_DIRECTION))`
(`VALID_TYPES`, `protocol.ts:1137`) instead of a second hand-written array.
`MESSAGE_DIRECTION` (`protocol.ts:179-231`) tags every key `c2d` / `d2c` /
`both`, derived from observed dispatch sites (`connection.ts`'s inbound
switch, `App.tsx`'s and `attach-client.ts`'s handler maps), not invented —
its own doc comment states the rule and the `ack` exception (tagged `both`
because the daemon's router has a real accepting case for it even though
only the daemon currently constructs one).

A compile-time check, `_DiscriminantsMatch` (`protocol.ts:136-145`), proves
every entry's interface `type` literal matches the key it is registered
under. The obvious implementation maps a mismatch to `never` and indexes the
whole mapped type by `keyof ProtocolMessageMap`; that does **not** work,
because TypeScript drops `never` out of a union (`true | never` simplifies
to `true`), so one wrong entry among 44 correct ones is silently absorbed
and the check passes anyway — verified with `tsc --strict` against a
deliberately mismatched two-entry registry: zero diagnostics. The issue
text for C2 (#895) specified this broken `never` version; the implementer
caught it during the work and proved the failure mode before shipping the
fix. The working version maps a mismatch to `false` instead: `true | false`
is `boolean`, not assignable to a `const _discriminantsMatch: true`
annotation, so a mismatch is a real compile error (`protocol.ts:144`).

**The golden-equality guard is hand-transcribed, not derived, on purpose.**
`packages/shared/tests/protocol-registry.test.ts`'s `GOLDEN_TYPES`
(lines 21-67) is the exact pre-#895 `validTypes` array, copied by hand and
frozen. It is deliberately not imported from `MESSAGE_DIRECTION` or anything
else in the registry, because a list generated from the thing it guards
cannot catch that thing being wrong — if the derivation ever silently drops
a type, a list derived from the same derivation would drop right along with
it and the test would stay green. The same reasoning produced
`INBOUND_ROUTED` (`protocol-registry.test.ts:104-123`), a second
hand-transcribed list pinning which types `connection.ts`'s inbound switch
actually accepts, used by C6 (#899) to gate `ClientToDaemonType`. This
"pin a hand-written snapshot next to a derivation, never let the derivation
check itself" shape is the most reusable output of the epic — it applies
anywhere a mapped/derived type stands in for a list a human used to
maintain by hand.

## Consequences

Easier: adding a message type has one canonical edit point for its wire
definition (`ProtocolMessageMap`, plus a `MESSAGE_DIRECTION` entry).
`ProtocolMessage` and the runtime allowlist can no longer disagree with each
other, because there is only one list left to disagree with. A wrong
discriminant on a new entry is now a build error instead of a message that
silently fails to deserialize months later.

Harder: `GOLDEN_TYPES` and `INBOUND_ROUTED` are frozen snapshots that must
be updated by hand, deliberately, whenever the registry legitimately grows —
that edit is the point, not friction to engineer away. A reviewer who
doesn't understand why those two lists exist may look at them next to a
freshly "derived" system and propose deleting them as redundant; that
proposal reopens the exact hole this ADR closes.

New obligation: any future derived-from-a-single-source mechanism in this
codebase that replaces a hand-maintained list should get its own frozen,
hand-transcribed golden test, not reuse or extend `GOLDEN_TYPES`/
`INBOUND_ROUTED` by import.

## Alternatives considered

- **Status quo: keep the two hand-maintained 45-entry lists in sync by
  discipline.** This was the defect being fixed, not a real alternative —
  it is the exact shape that let `validTypes` silently drift from
  `ProtocolMessage` with no test catching it.
- **Codegen from an IDL** (e.g. generate `protocol.ts` from a schema file).
  Rejected: it replaces one hand-maintained description with two —
  the schema and the generated code — which is a second description that
  can drift, the documented failure mode this repo keeps producing (see
  ADR 0011 and the `AGENTS.md` table it codifies). A registry inside the
  same file the types already live in has no second artifact to fall out
  of sync.

## Receipts

- `packages/shared/src/protocol.ts:61-251` — `ProtocolMessageMap`,
  `_DiscriminantsMatch`, `ProtocolMessage`, `MESSAGE_DIRECTION`,
  `ClientToDaemonType`
- `packages/shared/src/protocol.ts:1129-1137` — `VALID_TYPES` derivation
- `packages/shared/tests/protocol-registry.test.ts` — `GOLDEN_TYPES`
  (lines 21-67), `INBOUND_ROUTED` (lines 104-123), both explicitly
  documented as not derived from the registry they guard
- #895 (C2), #896 (C3), PR #906 (implements both; the `never`-vs-`false`
  sentinel correction is documented in the PR body)
- #883 (epic), comment: "The `INBOUND_ROUTED`-style pinning is the pattern
  worth generalizing... Used twice now (`GOLDEN_TYPES` in C2,
  `INBOUND_ROUTED` in C6-prep) and it caught the `ack` trap."
- `AGENTS.md` → "Verify before you describe"
