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
- **The WebView Mac app's `HubProtocol.protocolVersion`** (`packages/macos/Remi/HubProtocol.swift`) is a string constant, `"1.0.0"`, that nothing reads; despite the name it is not this field.
- **`daemonVersion` (#539) is the remi release.** A client could compare it, but a development build (`0.7.17-dev.4`) or a test build (`0.7.16-p1204.1`) says nothing about what it supports, and comparing release strings ties every client to remi's release history.

## Decision

1. **`hello_ack.protocolVersion`** is an integer, `PROTOCOL_VERSION` in `@remi/shared`, now 1.
   It changes only on a breaking change: a field removed or renamed, a field whose meaning changes, a message removed, or a request an older client sends that a newer daemon would refuse.
   An additive change never changes it.
   Only part of that is automatic: `protocol-fixtures-additive.test.ts` pins five messages (`hello_ack`, `question`, `session_list_response`, `create_session_request`, `create_session_response`) to their earlier fields; for every other message, keeping a change additive is a review rule, and a change that is not must raise `PROTOCOL_VERSION` by hand.
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
   - an ack without `protocolVersion` is from an older remi and is compared as version 1: a version 1 client accepts it unless it needs a capability, which such a daemon cannot list;
   - another protocol version is not supported, in either direction, and the message says which side to update;
   - a missing capability is named with what it does.

   A message that sends the person to the machine says to update remi there and restart it: a daemon keeps its binary until it restarts (#539), so an update alone changes nothing.

   A capability name the client does not know is ignored, so what a newer daemon adds cannot break an older client.
   The daemon's version, when the message names it, is escaped and cut, since the daemon chose it.
6. **`serverVersion` stays,** documented as the constant it is, because the Mac app's decoder requires it.
   It goes only with a protocol version change.

## Consequences

- No TypeScript client needs a capability today: the web client and the CLI call nothing new, and `hubSupport` has tests and no caller.
  The native apps are its first users; RemiKit will mirror `PROTOCOL_VERSION`, `hubSupport` and the registry, checked against the fixtures `hello_ack` (this daemon) and `hello_ack_legacy` (a daemon before this change).
- **The versions must match.** A client and a daemon on different protocol versions refuse each other; nothing says "I also speak version N-1", and the `hello` carries no client version for a daemon to adapt to. That is the point of a freeze, and it makes version 2 a flag day: the change that introduces it decides how adjacent versions talk (an additive field, such as a lowest supported version on `hello_ack`, can be added then).
- **A future ack path that forgets the capabilities would claim none,** and `hubSupport` would tell a person with a current remi to update. `hello-ack-sources.test.ts` reads the daemon's source and fails a `createHelloAck` call whose options do not name `capabilities`; the bare `Connection`'s ack, which production never sends, is the one exception and lists none.
- The first capability arrives with workspaces (#1236).
- Relay v2 carries its own version, `v`, in its handshake (ADR 0034, on the relay epic branch).
  That versions the encrypted channel; `protocolVersion` versions the messages inside it.
