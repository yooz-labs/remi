# ADR 0009: Transport encryption applies to the relay only, never to direct connections

**Status:** accepted
**Date:** 2026-07-28
**Owner:** Yahya

## Context

remi reaches a daemon over two structurally different transports. A **direct**
connection (LAN, Tailscale, VPN, SSH tunnel, loopback) is point to point with no
third party in the path. A **relay** connection routes every byte through a
Cloudflare Worker that remi does not control.

#543 established that the Worker was receiving `user_input`, answers and device
tokens as plain JSON, in a product whose first principle is that session data
never reaches a server. Fixing that raised the obvious follow-on question: does
the same encryption belong on direct connections too, for consistency?

## Decision

**Encryption is scoped to the transport that has an untrusted intermediary.**
Relay traffic is end-to-end encrypted; direct connections carry no relay
encryption and never have. Where the transport already provides privacy and
authentication (Tailscale, VPN, SSH tunnel, loopback), remi adds nothing on top.

Concretely: `relay-crypto.ts` is imported only by `remote/relay-adapter.ts`.
`grep -rn "relay-crypto|encryptRelayPayload|sessionKeys" packages/daemon/src/adapters/
packages/daemon/src/server/` returns nothing, and that emptiness is the invariant
this ADR protects.

## Consequences

Easier: direct connections stay simple and fast; no key exchange, no per-message
crypto, no failure mode where a LAN session breaks because a handshake did not
complete. Users on Tailscale pay nothing for a guarantee they already have.

Harder: the honest description of remi's security is now conditional, and
conditional claims are the ones that rot. Any statement of the form "remi is
encrypted" must name the transport. This is exactly the drift `AGENTS.md`
→ "Verify before you describe" exists to catch, and the relay claim has already
produced three successive wrong descriptions (#881).

New obligation: a future transport with an intermediary (a hosted broker, a
push proxy, a third-party tunnel) inherits the relay's requirement, not the
direct path's exemption. The test is "is there a party in the middle who is not
the user", not "is it remote".

## Alternatives considered

- **Encrypt everything uniformly.** Rejected. It buys nothing over Tailscale or
  an SSH tunnel, costs a handshake on every local connection, and adds a failure
  mode to the path that must be the most reliable. Uniformity would be for the
  sake of a simpler sentence in the README, not for the user.
- **Encrypt nothing and document the relay as untrusted.** Rejected as the
  #543 bug restated: the product claim is that session data does not reach a
  server, and a documentation caveat does not make that true.
- **Let the user choose per connection.** Rejected. The correct choice is fully
  determined by whether an intermediary exists, so exposing it as a setting adds
  a way to get it wrong with no compensating benefit.

## Receipts

- `packages/shared/src/relay-crypto.ts` — the signed-ephemeral exchange and its
  own "what it does not do" section
- `packages/daemon/src/remote/relay-adapter.ts` — sole consumer
- #543 (relay encryption), #881 (the three wrong descriptions of it, and the
  finding that the client half was never implemented)
- `AGENTS.md` → "Verify before you describe"
