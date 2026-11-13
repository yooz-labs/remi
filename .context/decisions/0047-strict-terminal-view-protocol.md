# ADR 0047: Strict normalized terminal-view frames

**Status:** accepted wire; host, authority, transport and caller integration pending
**Date:** 2026-10-22
**Owner:** Yahya

## Context

The owner approved a read-only view of the existing agent terminal under #1595.
ADR0046 selects a finite qualified screen primitive; a transcript or arbitrary
ANSI tail does not establish its current viewport.
The next app phase needs exact additive messages rather than invented fields.
This phase adds structural syntax only, under protocol version 1.

## Decision

Use eight exact `session_terminal_*` shapes, validated against original bounded
raw JSON before the permissive legacy decoder (ADR0012–0014).
Every frame has exactly `type`, `id`, `timestamp`, `sessionId` and the fields
below; every response also has `requestId`, echoing the initiating request ID.
No field is optional.

| Type suffix | Direction | Additional fields |
|---|---|---|
| `open` | Client to daemon | `binding` |
| `opened` | Daemon to client | `viewId`, `expiresAt` |
| `read` | Client to daemon | `viewId`, `afterRevision` |
| `snapshot` | Daemon to client | `viewId`, `revision`, `columns`, `rows`, `lines`, `cursor` |
| `unchanged` | Daemon to client | `viewId`, `revision` |
| `close` | Client to daemon | `viewId` |
| `closed` | Daemon to client | `viewId` |
| `refused` | Daemon to client | `operation`, `code` |

### Exact encodings and bounds

- `id`/`requestId`: lowercase canonical UUID v4. `sessionId`: the existing
  lowercase canonical UUID shape, identifying the actual attached session.
- `timestamp`/`expiresAt`: real UTC instant in exact 24-character
  `YYYY-MM-DDTHH:mm:ss.sssZ` spelling. A client's clock grants no authority.
- `binding`: exactly `{harness:"claude"|"codex", harnessSessionId:<text>}`;
  nonempty Unicode scalar text, at most 200 UTF-8 bytes, no C0/C1 controls.
  The harness ID is opaque and need not be a UUID.
- `viewId`: host-generated collision-checked 16 random bytes, canonical
  unpadded base64url (22 characters). Syntax grants no ownership or lease.
- `revision`: nonnegative safe integer. `afterRevision`: null for a first
  read, otherwise that same integer shape. Monotonicity/freshness is a host
  check, not proved by decoding a number.
- `columns`: integer 2–240; `rows`: integer 1–60. `lines`: exactly `rows`
  scalar strings, at most 32,768 aggregate UTF-8 bytes. Each row is at most
  `columns * 64` UTF-8 bytes, a storage ceiling derived from ADR0046's cell
  limit, not an assertion about Unicode or native font display width.
- Text contains no C0/C1/escape controls, row separators, bidi display controls
  or zero-width joiner. Basic wide/combining characters are preserved exactly.
  A producer screen outside this subset is unavailable, never truncated.
- `cursor`: null when hidden, otherwise exactly `{row, column}` with zero-based
  integers inside the advertised geometry.
- `operation`: exactly `session_terminal_open`, `session_terminal_read` or
  `session_terminal_close`. `code`: exactly `malformed`, `unavailable`, `busy`,
  `expired`, `binding_changed` or `unsupported_screen`. No diagnostic/path field.

The original received JSON/UTF-8 frame is at most 65,536 bytes, including
whitespace and escape expansion. Existing strict parsing rejects duplicate
members, malformed UTF-8 and escaped lone surrogates without normalizing them
through a last-member-wins legacy parse.
The dedicated runtime encoder rejects accessors, `toJSON`, cyclic/custom
objects and sparse/decorated arrays before JSON can coerce/discard values.
Its frozen dense arrays support the actual immutable screen snapshot.

### Runtime boundary

The reserved capability name is `terminal_view`; this phase adds it to no
capability registry or advertised set. The current server refuses these
requests as unavailable, and existing clients explicitly ignore the new
messages. Hub, child-proxy and web-relay guards refuse this new family until B4,
so registry recognition alone cannot enable forwarding. No component starts a
view, captures terminal output, writes input,
resizes a PTY or forwards a new relay operation in this phase.

B3 must admit launch-time capture and view leases using current original
grant/attachment/binding/runtime checks, per-home model/send reservations and
signed WSS. B4 must qualify the encrypted semantic child route and one real
caller before conditional capability advertisement. The new view exposes no input or resize operation; raw PTY remains refused.
The web relay rejects inbound legacy resize, which is a distinct client check. Device revocation, lease/rate limits, revision state, reconnect
uncertainty and no content in replay/log/push remain those runtime gates.

## Consequences and alternatives

Complete replacement snapshots allow bounded coalescing for slow viewers.
They require more bytes than deltas but avoid trusting a retained ANSI suffix
or replaying terminal operations. Raw PTY transport remains unselected.
Structural corpus tests are explicitly partial: they prove codec/registry
behavior, not authority, leases, transport or native cell/font parity.

## Receipts

[#1612](https://github.com/yooz-labs/remi/issues/1612), the owner-approved
[backend plan](../issue-1595-backend-plan.md), ADR0046, and
`packages/shared/tests/fixtures/terminal-view/vectors.json`.
The actual screen-to-codec test constructs `BoundedScreen` and uses the
shipping serializer/deserializer; it is not an end-to-end terminal caller.
