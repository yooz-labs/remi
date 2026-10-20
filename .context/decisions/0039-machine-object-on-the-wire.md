# ADR 0039: Machine identity and display metadata on the wire

**Status:** accepted (#1234, backend phase; native aliases and transfer follow)
**Date:** 2026-10-09
**Owner:** Yahya

## Decision

Authenticated daemons include optional `machine` on `hello_ack` and
`session_list_response`. It contains `id`, `name`, `platform`, `remiVersion`,
`harnesses` and `capabilities`. Explicitly auth-disabled and older daemons
omit it; clients keep their endpoint fallback. Presence needs no new capability
or protocol version (ADR 0035).

The ID is the existing relay room ID: the first 16 bytes of SHA-256 of the
machine's raw Ed25519 public key, encoded as 32 lowercase hexadecimal characters.
`cli/machine.ts` calls `relayV2.ridOf`; it invents no second identity. `cli.ts`
derives it once from the identity already unlocked for authentication, including
on a direct-only daemon. A hub and its ordinary children share that home and
key. A separately generated home identity or key rotation changes the ID.
Copying the same identity key preserves its ID, even in another directory or
on another host; the ID identifies that key, not physical hardware.

The name is a display default, shared with `remi pair`: the short host name,
plain letters, numbers, spaces and `._'-`, at most 64 Unicode scalars, with
`remi` as the empty fallback. Clients escape display text from peers and accept
future platform strings. The version is for display; it is not feature detection.

Capabilities and offered harnesses describe the responding connection.
`createHelloAck` uses one machine snapshot for both the descriptor and the
existing `daemonVersion`, `harnesses` and `capabilities` fields. Equal IDs never
upgrade a different endpoint's capabilities.

`createSessionListResponse` stamps every entry with `machineId` matching its
enclosing descriptor, including discovered transcripts. It names the current
hosting machine, not a transcript's historical origin. Requested lists and
watcher broadcasts pass the same provider. The relay's verified-child aggregate
passes the hub descriptor and removes direct `wsPort`/`daemonHost` fields;
relay clients route by session ID through the hub. Direct lists retain their
existing discovery ports. The optional version-1 `daemonHost` field and its
old fixtures stay compatible; it is not a display-name source.

## Trust and native handoff

A machine ID and name grant no access. Clients bind the descriptor ID to the
authenticated full machine public key and preserve that key pin; they must not
merge trust solely from a claimed ID or display name. Direct transport's existing
encryption limits remain (ADR 0009).

The native follow-up in #1234 uses persisted local alias, then wire name, then
endpoint as display precedence. Rename and profile transfer preserve the full
public-key pin and stable ID. This backend phase implements no rename UI or
profile synchronization. The wire fixtures `hello_ack_machine` and
`session_list_response_machine` are the RemiKit adoption contract.

## Evidence and scope

Production callers are `connection-events.ts`, both session-daemon resume ack
branches, `session-events.ts`, the live-sessions watcher through `cli.ts`, and
`HubRelay.sessionList`. The bare `Connection` fallback remains descriptor-free;
production supplies its own hello handler.

Controls use the real shared factories, restricted identity stores and the
source hub/Worker/controlled child: direct/relay identity agreement, query and
attached hello, requested and broadcast lists, child entry IDs, no relay child
endpoints, auth-disabled omission, per-home persistence and key rotation.
Both resume branches have handler coverage. These are source controls, not
native adoption or physical-device acceptance.

During implementation, source inspection found that the old relay aggregate
omitted `daemonPorts` but retained per-entry endpoints. This change removes
those entry fields; the earlier claim that all child endpoints were already
stripped was incorrect (ADR 0011).
