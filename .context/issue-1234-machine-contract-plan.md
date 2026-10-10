# Machine contract, backend phase (#1234)

Status: approved for implementation and verification, 2026-10-09.
Owner continuation: "xcode developer moved forward, you should too".
Integration: develop. Branch: feature/issue-1234-machine-contract.
The existing relay contract worktree is reused for this phase.

## Existing code and verified constraints

- `relay/primitives.ts:48` already defines the room identity as the first
  16 bytes of SHA-256 of the machine public key. Worker paths use its
  32-character lowercase hexadecimal form. Reuse that exact derivation.
- `cli.ts` unlocks the per-home identity once for authentication and passes
  that same identity to `HubRelay`. Hubs and their ordinary children share
  the home; a separate home or a changed machine key is a separate identity.
- Production hello paths are in `connection-events.ts` and the two
  session-daemon resume branches in `resume-session-events.ts`.
- `buildSessionList` is shared by requested lists and watcher broadcasts.
  `HubRelay` separately aggregates child lists and strips child endpoints.
- `daemonHost` occurs in the existing golden fixtures and additive contract
  checks. Retain the version-1 field and fixtures; mark its legacy purpose
  explicitly rather than removing a pinned field.
- The QR pairing command already derives a bounded plain host name. Extract
  that logic for the pairing payload and machine descriptor to share.
- ADR 0035 explicitly says a visible machine object requires no new
  capability. This is an additive protocol-version-1 change.

## Proposed wire

`hello_ack.machine` and `session_list_response.machine` are optional.
When present, the object contains:

| Field | Meaning |
| --- | --- |
| `id` | Existing relay room ID, 32 lowercase hexadecimal characters |
| `name` | Bounded plain host name, at most 64 Unicode scalars |
| `platform` | The responding process's platform; clients accept future values |
| `remiVersion` | Version of the responding daemon, for display |
| `harnesses` | The responding daemon's offered harnesses |
| `capabilities` | The responding daemon's current capabilities |

Every entry in a list with a machine descriptor also carries `machineId`,
matching the enclosing descriptor. The descriptor names the machine hosting
the listed session or transcript, including externally discovered transcripts.
It does not claim the transcript's original machine.

The hello's existing version, harness and capability fields stay in place
and agree with the corresponding descriptor fields. Capabilities still apply
to the responding connection; identity equality does not upgrade another
endpoint's capabilities.

An authentication-disabled daemon omits the descriptor. This phase does not
create or unlock an identity just to name an unauthenticated endpoint.
Older or descriptor-free servers retain the client's endpoint fallback.

Names are display metadata. A descriptor ID is not an authorization grant.
Clients bind it to the authenticated full machine public key, preserve their
key pins, and escape untrusted display text.

## Native handoff

The Xcode track consumes the shared type, fixtures and ADR after landing.
Persisted local aliases take precedence over the wire name, then the existing
endpoint fallback. Rename and profile transfer preserve the full public-key
pin and use the stable ID; these remain the native follow-up in #1234.

## Files and order

1. Shared `MachineDescriptor` type and optional protocol fields/factory inputs.
2. Shared default-name helper and per-home ID construction using `ridOf`.
3. Connection and resume hello wiring; requested and broadcast list wiring.
4. Relay list aggregation retains the same descriptor and session IDs.
5. Additive golden examples and legacy fixtures, proposed ADR 0039, roadmap
   status and native handoff. Keep the issue open for the native alias work.

Likely files are `packages/shared/src/types.ts`, `protocol.ts`, `index.ts`,
the protocol fixture builders/generator, daemon connection/resume/session
handlers, `live-sessions-watcher.ts`, `remote/hub-relay.ts`, `cli.ts` and the
pairing name helper.

## Acceptance gate

Use the real factories and source hub/child/Worker endpoints. Require:

- direct and relay paths for one home produce the same existing room ID;
- child and hub descriptors agree on identity and list entries name it;
- requested, broadcast, query and resume paths all include the descriptor;
- distinct homes/key rotation produce distinct IDs;
- authentication-disabled and old fixtures retain their prior shapes;
- existing version-1 fixture fields and legacy routing behavior remain;
- names have bounded scalar length and safe display handling;
- relay responses retain their current child-endpoint refusal;
- focused controls, both Bun gates, normal CI and independent review pass.

No provider turn, cloud deployment or owner signing is needed for these
owned source controls. Native alias UI and physical adoption are later gates.

## Judgment calls

- Use the existing 128-bit room ID, rather than inventing a machine identifier.
- Scope metadata to the responding daemon; preserve per-connection capability
  checks when different versions run on one machine.
- Omit identity metadata when authentication is explicitly disabled.
- Keep `daemonHost` for version-1 compatibility, with a deprecation note.
- Separate the backend descriptor from client-local aliases and profile transfer.

One implementation lead and one independent integration/security reviewer.
