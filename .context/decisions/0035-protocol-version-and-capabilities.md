# ADR 0035: Protocol version and capabilities on hello_ack

**Status:** accepted (#1237, milestone "Protocol freeze")
**Date:** 2026-10-07
**Owner:** Yahya

## Context

A client cannot tell what a daemon supports except by trying.
`hello_ack.harnesses` (#1179) answers that for one question, which harness a hub can start, and it exists because an older hub silently ignored `create_session_request.harness` and started Claude.
The protocol freeze adds more request fields of that kind: a workspace on `create_session_request` (#1236) is one an older hub would ignore, starting the session in the plain directory without a word.
The native apps will talk to hubs of many versions at once, one per machine, so "try it and see" turns into a wrong session on someone's machine.

Two fields look like an answer and are not:

- **`serverVersion` is a constant.** The daemon's acks send the literal `'1.0.0'` (`cli/handlers/connection-events.ts`, `cli/handlers/resume-session-events.ts`), a bare `Connection` sends `'0.1.0'` (`server/connection.ts`), the value has never changed, and no client reads it for anything: the Mac app's `HubProtocol.swift` requires it to decode an ack and does nothing else with it.
- **`daemonVersion` (#539) is the remi release.** A client could compare it, but a development build (`0.7.17-dev.4`) or a test build (`0.7.16-p1204.1`) says nothing about what it supports, and comparing release strings ties every client to remi's release history.

## Decision

1. **`hello_ack.protocolVersion`** is an integer, `PROTOCOL_VERSION` in `@remi/shared`, now 1.
   It changes only on a breaking change: a field removed or renamed, a field whose meaning changes, a message removed, or a request an older client sends that a newer daemon would refuse.
   An additive change never changes it; the golden fixtures and `protocol-fixtures-additive.test.ts` hold every change to being additive.
2. **`hello_ack.capabilities`** lists names, one per additive feature a client cannot see in the messages themselves.
   A name is added by the change that ships its feature, with a golden fixture, to `PROTOCOL_CAPABILITIES` in `@remi/shared`, which says for each name what a daemon that lists it does.
   A field a client can see needs no capability (a machine object on the ack, #1234, is either there or not); a request field an older daemon would ignore does (a workspace, #1236).
3. **The list starts empty.**
   Everything a daemon did before this change is the baseline of version 1.
   An ack without `capabilities` comes from a daemon older than this change, so a capability for a feature that predates it would read as missing on exactly the daemons that have it.
4. **Every ack carries both.**
   `createHelloAck` stamps `protocolVersion` itself, so no path can omit it.
   The daemon passes `DAEMON_CAPABILITIES` (`cli/capabilities.ts`) on every ack it sends in production: the connection ack and the two resume acks.
   The two handler factories take the list as an optional dependency that defaults to it, so a unit test can give a list and see it reach each ack; while the list is empty, that is the only way a dropped path shows.
   The integration tests read both fields off the socket of a real session daemon and a real hub.
   A test holds every name in `DAEMON_CAPABILITIES` to the registry, so no capability ships undocumented.
5. **A client decides with `hubSupport(ack, needs)`** (`@remi/shared`), never by comparing `daemonVersion`:
   - an ack without `protocolVersion` is from an older remi: supported, unless the client needs a capability, which it then names with what it does and says to update remi on that machine;
   - another protocol version is not supported, and the message says which side to update;
   - a missing capability is named with what it does.

   A capability name the client does not know is ignored, so what a newer daemon adds cannot break an older client.
   The daemon's version, when the message names it, is escaped and cut, since the daemon chose it.
6. **`serverVersion` stays,** documented as the constant it is, because the Mac app's decoder requires it.
   It goes only with a protocol version change.

## Consequences

- No TypeScript client needs a capability today: the web client and the CLI call nothing new, and `hubSupport` has tests and no caller.
  The native apps are its first users; RemiKit mirrors `PROTOCOL_VERSION`, `hubSupport` and the registry, checked against the fixtures `hello_ack` (this daemon) and `hello_ack_legacy` (a daemon before this change).
- The first capability arrives with workspaces (#1236).
- Relay v2 frames carry their own version byte (ADR 0034, on the relay epic branch).
  That versions the encrypted channel; `protocolVersion` versions the messages inside it.
