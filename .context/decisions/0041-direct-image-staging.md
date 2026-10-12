# ADR 0041: Direct image staging contract

**Status:** accepted contract (#1170); implementation and capability availability pending
**Date:** 2026-10-11
**Owner:** Yahya

## Context

The phone needs a predictable way to send an image to its attached host session.
The existing [file-tunnel proposal](../../docs/FILE-TUNNEL.md#candidate-direct-staging-contract) already specifies the upload vocabulary and bounds.
This ADR collects that first operation into a concrete contract for TypeScript and Swift implementation.

Private-storage, reservation/recovery and decoder candidates already exist under `scripts/tunnel-storage-proof/` and `scripts/tunnel-decoder-proof/`.
The disposable decoder worker policy landed in [#1453](https://github.com/yooz-labs/remi/pull/1453), with passing six-cell default and held-answer profiles.
Those are standalone results; production helper/budget selection and transfer handlers remain pending.
The owner deferred extra OS resource-limit investigation and asked to continue practical file-transfer work.

The owner accepted these fields, bounds, outcomes, cleanup rules and the `image_staging` name on 2026-10-11.
Contract acceptance fixes the vocabulary; protocol registration, advertised capability and runnable upload integration remain pending.

The dormant [`image-staging.ts`](../../packages/shared/src/image-staging.ts) codec implements strict structural decoding and encoding.
Its [fixture corpus](../../packages/shared/tests/fixtures/image-staging/README.md) contains 33 positive and 470 negative vectors with exact PNG/JPEG bytes.
Both Bun gates preserve 408 existing protocol tests and pass 508 codec tests; all six supported compiled executions and twelve exact guard-removal controls passed.
The corrected entire vector document loads in Foundation; a Swift wire codec still needs to execute the cases.
These are structural conformance results, with transfer authority, state, content and cleanup enforced by the later lifecycle.

## Decision

### 1. One explicit operation: stage an image

The user selects a PNG or JPEG and uploads it to private storage belonging to the currently attached live Claude session.
Completion returns an opaque artifact identifier and a staged result.
Harness insertion is a separate explicit operation with a separate contract and capability.

The additive capability name is `image_staging`, reserved for the completed upload path.
Following [ADR 0035](0035-protocol-version-and-capabilities.md), a client enables its picker only when the connected daemon advertises that capability.
Register and advertise it only with the accepted handler, conformance fixtures and one production client upload caller.
Existing protocol version 1 remains unchanged by the additive operation.

Use the existing authenticated direct transport first.
Following [ADR 0009](0009-transport-encryption-scope.md), direct WebSocket authentication does not encrypt image bytes: connection privacy comes from an existing private transport such as Tailscale, a VPN or an SSH tunnel.
Plain LAN WebSocket traffic has no Remi encryption.
Relay support follows through the existing authenticated encrypted v2 channel, with its own caller acceptance.
Attachment bytes belong in neither notifications nor a Worker file-storage endpoint.

### 2. Common envelope and exact encodings

Every frame contains exactly `type`, `id`, `timestamp`, `sessionId` and the additional fields listed below.
Every response also contains `requestId`, echoing the initiating request's `id`.
There are no optional fields in these shapes.

| Field | Required shape |
|---|---|
| `id`, `requestId` | Lowercase canonical UUID v4. |
| `sessionId` | Lowercase canonical UUID of the live Remi session; it must also match the connection's actual attachment. |
| `timestamp` | A real UTC instant in the exact 24-character `YYYY-MM-DDTHH:mm:ss.sssZ` spelling. Client time grants no authority and changes no deadline. |
| `binding` | Exactly `{harness:"claude",harnessSessionId:<string>}`. The harness ID is nonempty, at most 200 UTF-8 bytes, valid Unicode scalar text and free of controls. Compare its exact bytes to the current authenticated session binding. |
| `transferId`, `artifactId` | Distinct host-generated 16-byte random identifiers, canonical unpadded base64url, 22 characters. Check collisions before publication. IDs convey no file path. |
| `mediaType` | Exactly `image/png` or `image/jpeg`. Verify it against completed content. |
| `byteLength` | Integer 1 through 10,485,760. Verify exact completed length. |
| `digest` | SHA-256 of all claimed file bytes, encoded as canonical unpadded base64url, 43 characters representing 32 bytes. Verify the actual completed digest. |
| `seq` | Integer 0 through 319. Transfer state requires the exact next sequence, starting at 0. |
| `data` | Canonical unpadded base64url without whitespace. Decoded length is 1 through 32,768; state requires exactly `min(32768, remaining bytes)`. |
| `receivedBytes` | Integer 1 through 10,485,760. State requires the cumulative completed write count, never greater than the declaration. |
| `expiresAt`, `artifactExpiresAt` | Valid UTC timestamps with the same spelling as `timestamp`, chosen and enforced by the host. |

Bound each raw frame to 65,536 UTF-8 bytes before JSON/base64 conversion.
Require valid UTF-8 and Unicode scalar strings, reject duplicate decoded member names at every object depth, unknown fields, wrong types, noninteger or out-of-range numbers and noncanonical encodings.
JSON whitespace and member order carry no authority; canonical encodings apply to the individual values.
The existing bounded duplicate-member scanner in `shared/src/relay/strict-json.ts` supplies reusable parsing behavior; Unicode and message-specific validation still need explicit checks.
The current general `deserialize` calls `JSON.parse` before outer-envelope validation, so adding registry entries alone cannot satisfy this ingress contract.

Shape validation proves only that a frame is structurally readable.
Transfer state separately validates authority, correlation, declaration, ordering, progress, expiry and actual content.
An independently valid chunk is not evidence that it belongs to a live transfer.

### 3. Messages and outcomes

Requests carry the common envelope; responses carry that envelope plus `requestId`.
The table lists every additional field.

| Direction and type | Additional fields | Meaning |
|---|---|---|
| Client `image_upload_begin` | `binding`, `mediaType`, `byteLength`, `digest` | Request admission for the currently attached live session. |
| Host `image_upload_accepted` | `transferId`, `expiresAt` | Capacity was reserved and one exclusive private partial was created; receiving may begin. |
| Client `image_upload_chunk` | `transferId`, `seq`, `data` | Write the exact next chunk. Send only one chunk awaiting acknowledgment. |
| Host `image_upload_chunk_ack` | `transferId`, `seq`, `receivedBytes` | That private write completed. The cumulative count includes this chunk. It does not assert crash persistence or harness delivery. |
| Client `image_upload_complete` | `transferId` | Verify and publish the completed image. |
| Host `image_upload_result` | `transferId`, `outcome:"staged"`, `artifactId`, `artifactExpiresAt`, `byteLength`, `mediaType`, `digest` | Exact length, actual digest, accepted full PNG/JPEG decode and current authority passed; one private artifact is retained. No host path is returned. |
| Client `image_upload_cancel` | `transferId` | Cancel an owned unfinished transfer. |
| Host `image_upload_cancel_result` | `transferId`, `outcome:"cancelled"` | Its partial was closed and confirmed deleted. Capacity may now be released. |
| Host `image_upload_refused` | `operation`, `code` | Correlated refusal. `operation` is exactly one of the four client request types above. |

Correlate the response type, request ID, session ID and, where present, transfer ID together.
The ordinary transport `ack` is separate from the completed-write and staged outcomes.

Refusal codes are exactly `malformed`, `unavailable`, `busy`, `conflict`, `sequence`, `integrity`, `unsupported_media`, `decode_failed`, `expired`, `binding_changed` and `cleanup_failed`.
The refusal shape carries no transfer/artifact identifier, host path or diagnostic details.
Use `unavailable` for unknown IDs, another device/grant/session, revoked authority, missing binding or unreadable authority state.
Other codes require the currently authorized owning device/grant.
Begin can refuse `busy` for capacity or `conflict` for request reuse before issuing a transfer ID.
Transfer-specific lifecycle codes require an owned known transfer.
An uncorrelatable malformed envelope ends the transfer connection without a correlated reply.

### 4. Admission and bounded storage

Capture device public key, authorization grant incarnation, connection attachment, session, child runtime and harness binding on the host.
Check the captured/current relationship at each read, write and publication effect.
The existing `IdentityStore.withAuthorizationEpoch` transaction is a reusable grant-incarnation check; current membership alone is insufficient after revoke/regrant.
An unreadable authority store or changed grant invalidates the transfer.
A changed known binding permits only the owner's `binding_changed` refusal and cleanup.
Capability-only or unbound connections cannot stage.

Keep these existing proposed bounds:

| Resource | Limit |
|---|---|
| One image | 10 MiB |
| Decoded image dimensions | 8,192 pixels per side; 32 million pixels total |
| One decoded chunk / raw frame | 32 KiB / 64 KiB |
| Unacknowledged chunks | 1 per transfer |
| Active transfers | 2 per device, 4 per session, 8 per hub |
| Reserved scratch bytes | 100 MiB per Remi home, including partial and completed artifacts |
| Retained scratch artifacts | 128 per home, 32 per device, including partial artifacts |
| Minimum allocation reservation | 4 KiB per artifact, rounded up; charge greater actual allocated blocks |
| Retry/tombstone slots | 128 per home, 32 per device, active transfers and partial tombstones together |
| Idle / total partial lifetime | 30 seconds / 5 minutes |
| Staged lifetime | At most 24 hours after first completion, ending sooner on session exit |

Reserve declared bytes, minimum allocation cost, one artifact slot, concurrency and one retry/tombstone slot before creating the partial.
Count a device's connections together; serialize per-home reservations across hub and session processes.
Publication converts the same reservation into one completed artifact.
Confirm deletion before releasing it; retain failed-cleanup debt.
Crash recovery reconciles private artifacts and reservations and does not revive transfer authority.

### 5. Progress, retries and cleanup

The host sets the original five-minute expiry at first acceptance and also bounds execution using local monotonic elapsed time.
Only an admitted completed chunk write refreshes the 30-second idle timer.
The original staged expiry is chosen on first completion.
Retries keep these original deadlines; a fresh response timestamp never extends them.

| Event | Required behavior |
|---|---|
| Identical begin with the same request ID while receiving | Return the same live acceptance and original expiry; allocate nothing more. |
| Begin ID reused with changed fields, for another operation, or after staging | `conflict`. Cancelled/expired transfer authority yields `unavailable`. |
| Duplicate/gap chunk or premature completion | Owner's `sequence` refusal is terminal for the partial; schedule cleanup. |
| Late chunk after staging | `conflict`; retain the completed artifact. |
| Lost chunk acknowledgment | Delivery is uncertain. Cancel; start a new transfer with a fresh begin ID after confirmed cancellation or expiry cleanup. There is no partial resumption or blind retransmission. |
| Retried complete while artifact and captured authority remain current | Return the same artifact and staged fields, correlated to the new request ID; allocate nothing more. Expired/revoked/missing artifacts yield `unavailable`. |
| Retried cancel | Return the same cancelled outcome while the bounded owned tombstone is retained. Retry failed owned cleanup while retaining quota. A staged artifact yields `conflict`. |
| Disconnect, detach or child restart | Invalidate unfinished transfer authority and schedule owned partial cleanup. Restart retains tombstones for refusal only. A lost completion can remain unavailable even if recovery finds a file. |
| Expiry | End the partial and perform owned cleanup. Replays and rejected frames extend no deadline. |
| Bookkeeping | Partial tombstones end no later than their original five-minute expiry; one completion record per retained artifact. Refuse admission when safe correlation capacity cannot be retained. |

## Implementation and native handoff

1. Add the strict typed codec and golden positive/refusal/boundary vectors to `packages/shared`.
   Run byte-identical conformance vectors through TypeScript and Swift; preserve existing protocol fixtures.
2. Settle production storage/decoder adoption and adopt the existing storage/reservation/recovery work.
3. Register the accepted messages with registry/direction/dispatch coverage and implement the authenticated direct transfer lifecycle.
   Exercise a real source hub/child for exact bytes/digest, ordering, lost acknowledgments, cancellation, capacity, cleanup and changed device/grant/session/binding.
   A real held answer must remain responsive during decode.
4. Add one production web upload caller and verify rendered selection, progress, cancellation, refusal and reconnect states.
   Register and advertise `image_staging` with that completed path.
5. X5 consumes the landed fields and conformance vectors for native picker/progress/staged-result UI in the existing native worktree.
   Relay transfer, harness insertion, links and file fetch follow their separate contracts and acceptance.

## Remaining implementation gates

- Production storage-helper and bounded-decoder adoption. Finite packaging and interpreter-policy observations remain distinct from a production allocation ceiling.
- TypeScript/Swift strict parsing, protocol integration and runtime caller acceptance. A directly imported codec or fixture suite alone does not make uploads available.

This scope requires no new machine hardening, host signing setting, account grant or device setup.
The practical boundaries are the intended client, session, bytes, private storage and predictable cleanup.
