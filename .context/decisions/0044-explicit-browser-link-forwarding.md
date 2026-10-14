# ADR 0044: Explicit browser-link forwarding

Status: proposed for owner review; no wire registration, capability or handler.
Date: 2026-10-14 UTC.
Issue: #1170, T2 in docs/FILE-TUNNEL.md.

## User flow

Ordinary transcript links already open explicitly in the web client.
This proposal adds the missing producer: programs that honor the session's BROWSER setting can offer a link to the device the person selects.
It does not intercept every macOS open or Linux xdg-open invocation.

In an attached Claude session, the person selects **Receive browser links here**.
Only one concrete client connection receives that session's future candidates; another explicit selection replaces it.
Each candidate displays its destination and an **Open** action.
Selection permits candidate delivery, never automatic opening or a standing grant to launch websites.
The host never fetches the URL or opens a browser for this operation.

Initial delivery is signed direct and Claude only.
Codex commands run in its shared app-server, so changing its TUI environment alone would not establish tool-process forwarding.
Relay and native callers adopt this capability only after their own actual route/conformance controls.
There is no port forwarding or localhost rewriting: the stated URL opens on the receiving device, where localhost names that device.

## Reuse and source evidence

- ChatMessage.tsx already renders explicit transcript anchors with noopener/noreferrer; keep that behavior.
- docs/FILE-TUNNEL.md already requires a session-local producer capability, a selected authenticated recipient, HTTP(S) only and a visible open choice.
- pty-session-setup.ts builds the Claude child environment; child-env.ts removes Remi's secret environment variables.
- The protocol registry, capability support check, identity/attachment/binding stores and original-grant locking provide the existing boundaries.
- No BROWSER producer, browser-link messages or receiver selection were found in current daemon/shared/web source.
- Structured chat sequencing in proposed ADR 0043 is a pattern to reuse, not a generic link implementation: its current codec and digest are specific to Codex text.

## Proposed wire

All four messages have exactly type, id and timestamp plus the fields below.
IDs are canonical lowercase version4 UUIDs; timestamps are canonical millisecond UTC, for display/correlation rather than clock-based authorization.
sessionId is the exact Remi session UUID.
binding has exactly harness: claude and the current canonical harnessSessionId UUID.
Unknown/duplicate members, wrong types and invalid original UTF-8 are refused before generic ACK/deduplication.
The additive capability name is browser_links, advertised only with an actual producer, recipient handler and production caller.

| Message | Direction | Additional fields |
|---|---|---|
| browser_link_receiver_request | Client to host | sessionId, binding, seq, action: select or release |
| browser_link_receiver_result | Host to requester | sessionId, seq, requestId and outcome; selected carries leaseId, released carries no extra field, refused carries code |
| browser_link_receiver_ended | Host to prior receiver | sessionId, leaseId, reason: released, replaced, session_changed or disconnected |
| browser_link_candidate | Host to selected receiver | sessionId, binding, leaseId, url, lifetimeMs: 120000 |

Result refusal codes are unavailable, unsupported, binding_changed, capacity, sequence, conflict and stale_receiver.
Lease IDs are host-generated canonical version4 UUIDs; shape or possession alone grants no authority.
A release affects only a lease owned by that concrete connection, never another client's selection.
Ended notifications are best effort only while delivery is still authorized; the client independently clears selection on connection, attachment, binding or identity loss.
No open acknowledgement or browser-history telemetry is sent to the host.

## Selection and duplicate handling

seq starts at one for each concrete connection/session pair and increases through 4294967295, independently of structured-chat sequence numbers.
Retain at most 64 pairs and 32 recent request/result receipts per pair; refuse new pairs at capacity, without evicting consumed watermarks.
An identical recent request returns its receipt only while its original selection and authority remain current.
A changed variant conflicts; an old selection that ended returns stale_receiver and cannot acquire a new lease.
Skipped, older evicted or exhausted sequences never change selection.
The next sequence is consumed on refusal too; binding changes or detach/reattach do not reset it.
A fresh connection starts a fresh sequence, with no automatic reselection or request replay.

Selecting captures the original device/grant incarnation, actual connection/attachment, live session/PTY, current Claude binding and runtime.
Recheck that same context at selection changes, candidate delivery and cached-result delivery under the existing original-grant lock.
Revoke/regrant, replacement, detach, session exit, rebind or runtime loss ends the lease; restoring authority does not revive it.
Last valid explicit selection wins when authorized clients deliberately select concurrently.

## URL and resource bounds

The producer accepts one URL argument, without shell interpolation.
Reject leading/trailing whitespace, backslashes, literal control characters, invalid Unicode, credentials, malformed URLs and schemes other than HTTP or HTTPS.
Normalize a valid URL with WHATWG URL serialization, including an ASCII hostname; bound both input UTF-8 and serialized ASCII URL to 4096 bytes.
The strict wire carries only that canonical ASCII serialization; client vectors must agree before native adoption.
Show the complete escaped destination without active markup and open exactly the validated destination after a user action.
Encoded path/query bytes do not become shell commands or host fetch requests.

Allow at most 10 producer candidates in any rolling 60 seconds per live session and retain no host candidate queue or URL history.
The client keeps at most eight candidates, dropping the oldest, with a 120-second monotonic lifetime from receipt.
Candidate expiry is a display/retention bound, not a claim to recall a URL already delivered or copied.
Disconnect, lease loss and session/binding changes clear in-memory candidates; they do not enter persistent transcript caches, logs or push.
No URL, query, fragment or local producer capability belongs in telemetry or error text.

## Local producer

Use an OS-local per-session capability, distinct from the daemon-wide capability and absent from client messages and logs.
Bind it to the live session runtime; no client can mint, replace or learn it.
The executable shim forwards an argument to a bounded local endpoint and never invokes a browser or network fetch itself.
Its short failure text excludes URL bytes.
Before choosing exit behavior, prove the relevant real BROWSER launchers do not fall back to opening a host browser when no receiver exists; document any launcher that ignores the setting.
Do not alter Claude permission judgment, rewrite arbitrary tool commands or widen Codex per-turn environment/policy overrides.

## Implementation order and fixed gates

1. Prove the actual producer/environment/argument path with an inert owned process, exact generated URL bytes and real launcher behavior; no paid model turn is needed for that process control.
2. After owner acceptance, add strict shapes, vectors and capability metadata; no availability from a dormant codec.
3. Add current-grant selection and producer delivery, then one real web receive/open caller.
4. Verify actual signed client/host delivery, bounded resource behavior and phone/tablet/desktop rendering. Observe zero browser launches before a click and one exact launch afterward, with no host fetch.
5. Remove each new guard and require its original malformed/other-session/stale-authority/replay control to fail. Retain all initial failures.
6. Independently review with at most two rounds, pass fresh relevant hosted checks, then give native the accepted fields and vectors. Relay/Codex producer support and file downloads remain separate gates.

Owner approval is required before contract freeze or runtime implementation.
Open decisions for that review are exclusive explicit selection, the proposed fields/names, 4096-byte URL limit, 10/minute producer rate, eight retained candidates, two-minute lifetime and the initial Claude/direct scope.
One implementation lead and one independent reviewer are sufficient; no new cloud resources, account/model calls or phone access are required for the proposal.
