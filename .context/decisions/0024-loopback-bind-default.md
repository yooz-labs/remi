# ADR 0024: The daemon binds loopback by default; reaching it off-machine is opt-in

**Status:** accepted
**Date:** 2026-08-11
**Owner:** Seyed Yahya Shirazi

> Numbered 0024, not 0023: 0023 (`artifact-deletion-is-proved-not-judged`) is
> claimed by an un-merged branch.

## Context

The shipped defaults combined into an unauthenticated remote-control surface,
and each half looked defensible alone:

- `DEFAULT_CONFIG.daemon.bind = '0.0.0.0'` — listen on every interface.
- `auth.enabled = 'auto'`, and `'auto'` resolves to `false` on **every** bind
  (`cli.ts`: `cliAuth ?? (configAuth === 'auto' ? false : configAuth)`). The
  name says "based on bind address"; the code never consults the bind. That
  mismatch is the second row of [ADR 0011](0011-verify-before-you-describe.md).
- With no authenticator, `Connection` never enters `authenticating` and a bare
  `hello` reaches `connected`, so `answer` and `user_input` route straight to
  the handler map.
- The Origin gate admits an absent Origin, which is exactly what a non-browser
  client sends. It stops pages, not native peers — deliberately.
- mDNS advertises the port by default.

Net: any host on the LAN could approve a pending permission prompt — arbitrary
tool execution on the developer's machine — or type into the live Claude
session. Verified against live daemons: `/auth-info` returned
`{"authRequired":false,"fingerprint":null}`. Filed as #880, P0.

This also made three shipped security features inert on a default install:
#869 (`require_local_auth`), #875 (sealed answer keys) and #543 (relay key
exchange) each hang off an authenticator that does not exist when auth is off.

## Decision

`daemon.bind` defaults to `127.0.0.1`. Off-machine access is an explicit opt-in
— set `bind`, and read the warning that comes with it.

`'auto'` is deliberately **left resolving to false**. This ADR does not fix it.

Consequently, every port bind-probe takes a required `bindHost` and there is no
default: a probe against a host other than the one about to be listened on
answers a different question, and on BSD a wildcard probe *succeeds* on a port
already held on loopback.

## Consequences

**Closed.** The unauthenticated LAN path. A stock daemon is unreachable
off-machine.

**Not closed, and this ADR claims nothing about them:**

- **The relay.** Default-on, dials outward, unaffected by any bind, and still
  plaintext through the Worker in rotating-code mode (#881). **Name the
  direction** — an earlier draft of this bullet said "the same `answer` /
  `user_input` power the LAN peer had", conflating the two halves, which is the
  exact error AGENTS.md records a previous draft of *its* #881 row making.
  Traced: outbound `sendRaw` REFUSES without `sessionKeys` (which rotating-code
  mode never derives); inbound falls through to `handleRelayMessage(rawPayload)`
  in plaintext. So whoever holds the current code gets inbound INJECTION, not
  the LAN peer's bidirectional control — the daemon cannot answer back.
- **Any local process.** While `require_local_auth` is false, a process on this
  machine is exempt from auth (#869).
- **Installs that materialized the old default.** `remi config init` writes the
  bind value into `config.toml`, and a value on disk beats a changed default.
  Those users keep the exposure, and nothing in their setup breaks to make them
  look. The boot warning is their only signal — which is why it now names the
  remedy, and why it goes through `console.error`. A first draft used `logError`
  "because console.warn is dropped in wrapper mode (#1043)"; the PR review
  showed that reasoning is backwards. In wrapper mode — the DEFAULT — `logError`
  routes to `writeToLog`, a no-op until `startLogFileSession`, which runs ~490
  lines later. The switch deleted the warning it claimed to save. The original
  live-smoke receipt below used `serve` (daemon mode), the one mode that could
  not have caught it; re-verified in wrapper mode after the fix.

**Broken on purpose.** LAN direct, Tailscale direct (100.x) and mDNS discovery
all stop until the user opts in. SSH tunnels and the relay are untouched.
Tailscale is the documented happy path, so this is a real cost, not a rounding
error. mDNS does not merely stop working — `cli.ts` skips the publisher on a
localhost bind, so the daemon *disappears* rather than refusing, which is the
confusing half of the migration.

**Do not recommend `tailscale serve` as the workaround.** It is a same-host
reverse proxy, so every tailnet peer arrives as `127.0.0.1` and inherits the
loopback auth exemption (`peer-helpers.ts`, #869). It reinstates the hole behind
a safer-looking front. Recommend an SSH tunnel, or an explicit `bind` plus
`--auth`.

## Alternatives considered

- **Make `'auto'` bind-aware** — what #880's title literally asks for, and
  rejected as insufficient *on its own*. `cli.ts` constructs the Authenticator
  with `tofuMode: 'auto-accept'` unless `--no-tofu` is passed, so an
  authenticator on a network bind is first-comer-wins: an unknown key is
  accepted on sight **and persisted** as authorized. (Note the `Authenticator`
  class itself defaults to `'reject'` — checking only `authenticator.ts` would
  say this claim is wrong. The call site decides.) Auth-on-network without a
  real pairing flow *reads* as handled while admitting anyone once, which is the
  ADR 0011 failure in live form. The `'auto'` semantics and TOFU belong in one
  tested change together with the phone pairing flow.

- **Couple the bind to the auth state** ("bind wide only when auth is
  configured") — strictly worse. It makes the listening surface an emergent
  property of a different config key, and the state it would widen the bind
  *for* is precisely the still-vulnerable one above.

- **Leave the default and document the hazard** — the status quo since the
  daemon existed. A `curl` that took five seconds would have caught this at any
  point in the preceding months and nobody ran it, because the docs read as
  though it was handled.

## Receipts

- #880 (P0), #869, #875, #543, #881, #1043
- `packages/daemon/src/config/config.ts` — the default and its scope comment
- `packages/daemon/src/session/port-utils.ts` — why `bindHost` is required
- `packages/daemon/tests/config.test.ts` — `#880 the shipped defaults...`;
  mutation-verified (flipping the default back turns four tests red)
- Live smoke, isolated `$HOME`: default → `127.0.0.1:19420` only;
  `--bind 0.0.0.0` → `*:19450` plus both warning lines
- Probe semantics measured on darwin 25.6: `held=127.0.0.1 probe=0.0.0.0`
  reports **free** while a loopback bind fails
- [ADR 0011](0011-verify-before-you-describe.md) — the `'auto'` row is this bug
- [ADR 0009](0009-transport-encryption-scope.md) — direct connections carry no
  encryption, which is why "direct" must mean loopback or a user's deliberate choice
