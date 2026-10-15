# Image and file tunnel: threat model and freeze plan

Design proposal for [#1170](https://github.com/yooz-labs/remi/issues/1170), started 2026-10-08; direct staging contract accepted 2026-10-11 in ADR 0041.
This document specifies work to review before implementation; it adds no messages, capabilities, endpoints or native attachment controls.
The direct staging vocabulary is accepted; protocol/runtime integration and the other tunnel operations remain pending.
The owner included the tunnel's frames in the protocol freeze (#1233, comment on #1170); native attachment and preview UI remains X5 (#1245).
Direct image staging and explicit Claude draft insertion have source callers under accepted ADRs0041/0042. Native, relay attachment transport, links and downloads retain their separate gates.
This separate follow-up does not establish or block relay backend release acceptance.

## Current code and reuse

Current source check: develop `ef84b4c6`, after [#1284/#1332](https://github.com/yooz-labs/remi/pull/1332) retained recent repositories for native session creation.
Its merge tree equals tested source `28ea5daf`; both full Bun suites and the actual 61-minute relay gate passed.
Develop's successor `23df4739` changes only version strings to `0.7.17-dev.42` and is included in this documentation branch.
The relay backend previously landed through [#1331](https://github.com/yooz-labs/remi/pull/1331) at `b1168126`, whose tree equals tested backend `2858e4bd`; `1d478e07` changes only the development version.
The initial checks against develop `1d800273`, relay epic `8fb5b88b` and source composite `1e96c688` remain historical provenance.
At that historical baseline no upload, file-fetch or forwarded-browser implementation was found. Subsequent source continuations below supersede that baseline for their specifically qualified operations.
`WebSocketAdapter`'s `onClientConnect` callback passes the server-derived fingerprint, `IdentityStore.withAuthorizationEpoch` supplies a grant-incarnation transaction, and `PTYSession.write` queues raw writes without a prompt callback.
Current chat checks `promptUp` before enqueue and then calls `PTYSession.submitInput`, which appends Enter; neither operation is an attachment insertion implementation.

| Existing implementation | Reuse and constraint |
|---|---|
| [`protocol.ts`](../packages/shared/src/protocol.ts), [`protocol-version.ts`](../packages/shared/src/protocol-version.ts), ADR 0035 | Additive messages need typed validation, golden fixtures and an advertised capability. Older clients and hubs keep their present behavior. |
| [`input-events.ts`](../packages/daemon/src/cli/handlers/input-events.ts), [`prompt-up.ts`](../packages/daemon/src/cli/handlers/prompt-up.ts) | `promptUpDeps` combines held, terminal and observed menu states. Attachment insertion must use the same signal at the actual queued write. A `user_input` currently appends Enter; an attachment reference must not use that operation. |
| [`harness/types.ts`](../packages/daemon/src/harness/types.ts), ADRs 0032 and 0033 | Keep upload storage neutral and put harness delivery behind the seam. Codex sets `acceptsTypedChat = false`; it has no shipped attachment-delivery operation. Do not send a file reference as raw Codex keystrokes. |
| [`pty/child-env.ts`](../packages/daemon/src/pty/child-env.ts) | Preserve removal of remi's secret environment variables when installing a browser shim. This does not isolate processes running as the daemon's user. |
| [`storage/interprocess-file-lock.ts`](../packages/daemon/src/storage/interprocess-file-lock.ts) | Serialize a durable per-home transfer reservation ledger across hubs, child daemons and manually started wrappers. In-memory per-process counters cannot enforce a per-home budget. |
| `shared/src/relay/channel.ts`, `constants.ts`, `remote/hub-relay.ts`, `remote/child-proxy.ts`, ADR 0034 | Reuse the authenticated, counter-checked channel and session routing now in develop. Its maximum plaintext is 524,288 bytes, its frame overhead is 25 bytes, and its pending-send bound is 64. These are channel limits, not a transfer budget. Relay v2 remains opt-in. |
| `auth/identity-store.ts`, `notifications/secure-push-store.ts` | `withAuthorizationEpoch` and the captured/current authority pattern distinguish a removed and replaced grant. Reuse the integrated grant-incarnation helper; do not activate secure push or require relay enrollment for a direct tunnel. `isAuthorized` alone checks current membership, not the captured grant incarnation. |

Issue #1170's older plaintext-relay description predates the rebuild.
The v2 backend is now in develop, off by default and fail-closed without authentication; deployed-Worker and signed-device acceptance remain separate gates.
No attachment bytes may use a legacy relay route, a Worker HTTP answer route, APNs or notification payloads.

## Assets, actors and boundaries

Protect host credentials, project files, scratch storage, session/harness identity, client privacy and the availability of approvals.
Treat file bytes, file names, agent output, URLs, MIME labels and every incoming request as untrusted.

An unauthenticated peer has no tunnel authority.
An authorized client may request an explicit transfer for a live session it is attached to; possession of another session's ID or transfer ID grants nothing.
The hub must capture the authenticated device, authorization grant incarnation and current session binding, and the child must recheck them before reading, writing or inserting a reference.
Cancellation, detach, authorization removal and a changed session binding invalidate unfinished transfers.
This requires a tunnel-specific current-grant-incarnation check: direct connections recheck their grant before dispatch and at the existing heartbeat (#1305), and each queued transfer effect must still verify its captured original grant.
Removing and granting the same key again must not revive an earlier transfer; an epoch mismatch or an unavailable authority store permanently invalidates that transfer.

A malicious relay may inspect metadata, delay, truncate or replay transport frames.
Relay encryption does not stop a legitimately authenticated client from requesting files or exhaustively uploading data; filesystem policy and budgets are separate checks.
Direct `ws://` provides authentication without encryption by Remi; optional `[daemon.tls]` supplies HTTPS/WSS ([setup](DIRECT-TLS.md), ADR 0009 amendment). The new link/download release requires HTTPS/WSS with normal certificate and hostname validation.

A malicious project or agent may plant traversal paths, symlinks, credential files, URL schemes or deceptive display text.
The daemon must not acquire credentials for this feature, inspect credential stores or interpret an agent's output as permission to transfer a file or open a link.
A user-selected image or ordinary project file can itself contain sensitive information; an extension or MIME allowlist does not prove otherwise.
The transfer surface must make the selected item and destination clear.

A process with the daemon's OS identity can already read many of the daemon's files and mutate a project.
The tunnel must withstand path replacement races without claiming isolation from that same-user process.
Administrator compromise and an intentionally disclosed secret in an otherwise permitted file are outside the protection claim.

## Threats and required controls

| Threat | Required behavior before it ships | Evidence required |
|---|---|---|
| Cross-session or cross-device transfer | Bind each transfer to authenticated device, grant incarnation, session, current harness binding and runtime. Recheck at each effect; refuse an unknown or replaced binding. | Real hub/child controls for another session, detach, revoke/regrant, authority-store fault, restart and rebind. |
| Writing an attacker-chosen path | Accept no destination path. Generate the scratch directory and file names on the host; exclusive creation, directory mode 0700, file mode 0600. Never overwrite or execute an upload. | Traversal, absolute path, alternate separator, name collision and preplanted symlink controls. |
| Reading outside the project or reading a credential | Accept a project-relative path only. Resolve beneath a captured project root, deny hidden components and credential names, reject symlinks and multiply linked files. Inspect and stream the same regular-file descriptor. | Real temporary filesystem corpus, including links and concurrent path replacement. |
| Check/use race in file serving | A `realpath` check followed by reopening the original path is insufficient. Use traversal relative to a stable root directory descriptor with no symlink following at every component. Unsupported platform support refuses file egress. | macOS and Linux portability spike and deterministic ancestor/final-component replacement controls. |
| Resource exhaustion | Reserve byte, artifact-count and concurrency budgets before allocation, disk creation or reading. Use one interprocess per-home ledger, bound queued chunks and preserve room for answer/control messages. Never buffer a whole file in a JSON frame. | Tiny-file and multi-process saturation during a real held approval, cancellation/disconnect and timeout cleanup. |
| Corrupt, reordered or replayed transfer | Strict sequence, exact declared length and SHA-256 of completed bytes. Duplicate chunks refuse; a failed integrity check never inserts or publishes a file. IDs are scoped capabilities, never credentials. | Duplicate, reorder, gap, truncated completion, changed digest and replay after completion. |
| Upload text accidentally answers a permission | Delivery requires a harness-specific attachment operation. Check the shared prompt signal at the queued effect, refuse when a prompt is known up, and send no Enter. Do not use `raw: true` as a guard bypass. | Real held hook, released-to-terminal prompt, observed menu and prompt appearing while the upload waits. |
| Agent output opens a malicious link | Forward a candidate only. A person opens it explicitly. Permit `https` and `http`; reject credentials, control characters, other schemes and malformed URLs. Never fetch the URL on the host or follow it automatically. | Scheme/control corpus, rendered display checks and browser-call spy at the actual launch boundary. |
| File preview executes content or contacts a server | Deliver a download or bounded inert text/raster preview. No scripts, active HTML/SVG, external resources or automatic archive extraction. Escape deceptive display text. | Native/web preview tests with active and bidirectional content, and a network-observation control. |
| Transfer data enters logs or push | Log outcome code and byte counts only. No file bytes, reference text, raw paths, URLs, original names or content digests in telemetry or notifications. | Actual caller/log capture with identifiable test markers. |

## Ingress lifecycle

First support single-frame PNG and JPEG images only; animated or multi-image containers and generic file ingress follow a separate allowlist review.
Validate the declared kind against the completed bytes and a bounded image decoder before offering the result to a harness.
Limit dimensions to 8,192 pixels per side and 32 million pixels total to bound decoder work; a header-only MIME check is insufficient.
Do not alter image metadata silently or claim that an uploaded image is credential-free.

The session child owns a host-generated directory under the configured remi home, separate from the project and harness configuration.
Capture its directory descriptor before any upload; never accept a caller-provided directory or reconstruct a writable path from the display name.
Create a private, exclusive partial file, stream validated chunks, and publish a completed reference only after length, digest and content checks pass.
References contain only daemon-generated text; original client names never become shell commands or PTY input.

Upload and harness insertion are separate effects.
Completion means the image is staged, not delivered to the agent.
Explicit insertion must recheck the captured device grant incarnation, runtime, session/harness binding and `promptUp` through the same serialized path that writes to the PTY.
If refused, the image may remain staged until its expiry, with an honest retryable result; a later retry must not replay an earlier insertion.
Idempotency must distinguish confirmed insertion from uncertain delivery; it must not type a second copy after a lost response.

Claude insertion uses a quoted absolute retained PNG/JPEG reference without Enter, under [ADR0042](../.context/decisions/0042-claude-image-insertion.md).
The installed Claude 2.1.296 check read the exact retained PNG/JPEG files outside the project, including spaces; unmeasured quote, backslash and control-containing host paths are refused.
The shared prompt signal cannot detect every possible dialog; record what those controls demonstrate, without claiming complete screen safety.
Codex insertion remains unavailable until the owner resolves #1207 and an app-server attachment operation is independently verified against the installed version.
An upload must not start a Codex turn, change a thread or use `-i` on a resumed TUI implicitly.

Abandoned and failed partial files are removed when the transfer ends.
Completed files retain their original at-most-24-hour/session-exit deadline after insertion.
The owner accepted the visible Send-before lifetime in ADR0042: an expired unsent reference requires a fresh upload and manual removal from the terminal draft.
The installed CLI embeds image bytes on submission; the observed ordinary exit/resume retains them, without claiming later compaction or file reads never need the original.
Crash recovery scans only its own private scratch namespace, with descriptor-based traversal; it never walks the project or follows links.
Deletion is limited to owned transfer artifacts, with failures counted visibly and their reserved disk budget retained until cleanup succeeds.

## Egress lifecycle and credential denial

Egress comes after ingress and the portable filesystem spike.
An explicit client request selects one relative file in the session's project directory; there is no directory listing, glob, recursive download or arbitrary absolute-path endpoint.

Protected roots cover the known launch-environment, default and explicitly
supplied Remi/Claude/Codex locations. Remi does not resolve arbitrary private
locations from harness-internal settings. Missing active/explicit roots and
unreadable or replaced protected roots keep downloads unavailable; an inactive
default is optional only until it has first existed.
An agent's printed path is merely a suggestion.
The final UI displays the escaped project-relative name and byte size before export; authentication is still checked on the daemon, independently of that display.

Reject empty components, `.` and `..`, NUL/control/bidirectional characters, absolute paths, backslashes and platform drive/UNC syntax before opening anything.
Apply the policy to each component and final name using ASCII case-insensitive comparisons; reject alternate data stream syntax where applicable.
Deny every dot-prefixed component, `node_modules`, credential/config directories, private-key/certificate/container formats (`.key`, `.pem`, `.p12`, `.pfx`, `.keystore`) and exact credential names such as `id_rsa`, `id_ed25519`, `credentials`, `authorized_keys` and `known_hosts`.
The deny corpus must include `.env` variants, `.git`, `.ssh`, `.aws`, `.config`, the resolved remi home and Claude/Codex configuration roots, including when a project root overlaps one of them.
Configured credential roots require component-aware containment checks against the captured root and descriptor traversal, even if a directory has a non-hidden custom name.
There is no general-purpose secret detector: renamed credentials and secrets embedded in otherwise ordinary files remain a disclosure risk.

Open relative to the captured root; reject symlinks at every component, non-regular files, devices, FIFOs, sockets, multiply linked files and an initial size over the budget.
Read at most the admitted byte count plus one from that same descriptor into a reserved private copy; refuse growth, truncation or detected mutation before sending content to the client.
The completed fetch describes immutable bytes of that validated private copy, not an atomic snapshot of the source file.
The portability spike must establish the before/after descriptor checks and their limits; neither a hash nor unchanged metadata proves that every concurrent edit was detected.
Publish and stream only the completed private copy, without reopening the project path; inability to enforce the chosen checks refuses egress.
Never use a client-supplied path in an error or log; return a short refusal category without expanding the host path or exposing file existence beyond an admitted request.

## Link forwarding

Setting `BROWSER` only influences programs that honor it; it does not intercept every `open` or `xdg-open` call.
The shim must be tied to one live session and use an OS-local, per-session capability excluded from client messages and logs.
Its request yields a candidate URL to attached clients, and never opens a browser by itself.
Do not grant the harness a daemon-wide capability, copy remi's secret environment or shell-interpolate a URL.
Treat query strings and fragments as potentially sensitive; send only to the selected authenticated client and exclude them from all telemetry.
Client launch may contact the requested site, including a private-network host, so require a visible user choice with the exact escaped destination.

## Proposed transfer bounds

ADR 0041 accepts these bounds for direct image staging; the dormant shared codec validates its wire-shape limits.
Production resource enforcement remains part of lifecycle adoption.
File-fetch bounds remain proposed.

| Resource | Proposed limit |
|---|---|
| One image upload or file fetch | 10 MiB |
| One decoded chunk | 32 KiB |
| One transfer JSON frame | 64 KiB, including base64 and metadata |
| Unacknowledged chunks | 1 per transfer; no whole-file send queue |
| Active transfers | 2 per device, 4 per session, 8 per hub |
| Reserved scratch bytes | 100 MiB per remi home, counting completed and partial files |
| Retained scratch artifacts | 128 per remi home, 32 per device, counting completed and partial files |
| Minimum scratch reservation | 4 KiB per artifact, rounded up; increase to actual allocated file blocks when greater |
| Unproductive wait | 30 seconds |
| Total transfer lifetime | 5 minutes |
| Completed image staging lifetime | At most 24 hours, subject to the harness lifetime gate above |

Padded base64 of a 32 KiB chunk occupies 43,692 bytes; the candidate unpadded base64url spelling occupies 43,691, leaving room inside the proposed 64 KiB transfer frame and the epic's 524,288-byte channel plaintext limit.
Enforce both transfer and transport limits; changing the file budget must never relax channel limits.
Count all a device's connections together and reserve hub capacity before the child starts writing.
The per-home ledger atomically reserves the declared byte budget, minimum allocation cost and one artifact slot before file creation, across every hub and session process using that remi home.
Keep reservations for completed artifacts and failed deletions; reconcile crash leftovers without admitting new work from an unreadable or inconsistent ledger.

## Protocol freeze deliverables

The following is candidate vocabulary for the protocol ADR, not permission to invent or advertise a wire field now.

1. Define separate additive capabilities for staged image ingress, harness insertion, link forwarding and file egress. Advertise each only with a shipping handler and production client caller; a missing capability disables the operation through `hubSupport`. Backend preparation and tests are not production client callers.
2. Specify begin/accepted, chunk/ack, complete/result and cancel/result for uploads and fetches. Include request correlation, host-issued transfer ID, session identity, direction, sequence, total bytes, content kind and final digest. Every field, encoding, bound, expiry, refusal and idempotency rule must be in the ADR before models are added.
3. Distinguish staged, inserted, refused and uncertain outcomes. Existing transport acks acknowledge receipt; they must not be reused as proof of a completed disk write or harness insertion.
4. Bind all state to device, authorization grant incarnation, runtime and harness epochs on the child. The hub routes authenticated transfers without gaining an unrestricted file-service path; revoke/regrant, a resumed session or a restarted child cannot revive an earlier transfer.
5. Add golden success and refusal fixtures decoded by both TypeScript and Swift (#1238), with strict numeric/base64/text bounds, duplicate-field handling and explicit unknown-capability behavior. Add counters, digest and boundary vectors for transfer chunks.
6. Use the existing authenticated direct connection initially. Relay transfer support waits for the accepted v2 epic and real Worker/hub/client ciphertext-only controls; it adds no plaintext fallback or Worker file-storage endpoint.
7. Keep native picker, share sheet, previews and attachment controls in X5 (#1245), after the relevant capability and conformance gates pass.

## Candidate direct staging contract

The names and fields below are the owner-accepted contract in [ADR 0041](../.context/decisions/0041-direct-image-staging.md), with shape/state validation and retained retry deadlines.
They remain absent from the protocol registry; `image_staging` stays unregistered until production handler/caller conformance establishes availability.
The directly imported [`image-staging.ts`](../packages/shared/src/image-staging.ts) codec and [conformance vectors](../packages/shared/tests/fixtures/image-staging/README.md) prepare those field checks independently of a transfer lifecycle.
Initial staging targets an attached live Claude session with a known, non-null harness binding.
It writes private storage only and never types a reference, presses Enter or starts a turn.

### Envelope and encodings

| Field or rule | Exact candidate meaning |
|---|---|
| `type`, `id`, `timestamp` | Every frame has the listed discriminator, a lowercase canonical UUID v4 message ID, and a valid 24-character UTC `YYYY-MM-DDTHH:mm:ss.sssZ` string, preserving the existing protocol timestamp shape. Client time is not authority. |
| `requestId` | Every response echoes the initiating message's `id`; its own `id` identifies the response. Correlate type, request, session and transfer together, not the ID alone. |
| `sessionId` | Canonical UUID of the live remi session. Every staging frame and response carries it. It must match the connection's actual attachment; knowledge of it grants nothing. |
| `binding` | Begin carries exactly `{harness:"claude",harnessSessionId:<string>}` copied from the authenticated session's known binding. The ID is non-empty, at most 200 UTF-8 bytes and free of controls. Compare the exact bytes with the server's current binding; this is an expected-binding guard, not authority. |
| `transferId`, `artifactId` | Distinct host-generated identifiers: 16 cryptographically random bytes encoded as canonical, unpadded base64url (22 characters). Never derive them from a path, name, device or digest; collision checks precede publication. |
| `mediaType`, `byteLength`, `digest` | `image/png` or `image/jpeg`; integer 1 through 10,485,760; SHA-256 of the entire claimed file as 32 bytes of canonical, unpadded base64url (43 characters). Verify actual bytes at completion. |
| `seq`, `data` | Integer sequence starting at 0, at most 319; canonical unpadded base64url, no whitespace or alternate spelling. Decoded length is exactly `min(32768, remaining bytes)`, bounding the chunk count to 320. |
| `expiresAt`, `artifactExpiresAt` | Valid UTC timestamps in the same shape as `timestamp`, chosen by the host. Transfer expiry is five minutes after acceptance; local monotonic elapsed time also bounds execution. Staging expiry is at most 24 hours after completion, ending sooner on session exit. |
| Parser limits | Measure at most 65,536 UTF-8 frame bytes before JSON/base64 allocation. Require valid UTF-8 and Unicode scalar strings; reject duplicate decoded member names at every object depth, unknown fields, wrong types, non-integer/out-of-range numbers and non-canonical encodings; no coercion or path/name fields. |
| Common authority | Capture device public key, grant incarnation, attachment, session, child runtime and harness binding on the server. Recheck them at each read/write/publish/insertion effect. Store faults or changed grants/bindings permanently invalidate the transfer. |

### Lifecycle and correlation

Requests carry the common envelope plus `sessionId`; responses add `requestId`.
The columns below list every additional field; no field is implicitly optional.

| Client request | Response and fields | Transition or refusal |
|---|---|---|
| `image_upload_begin`: `binding`, `mediaType`, `byteLength`, `digest` | `image_upload_accepted`: `transferId`, `expiresAt` | Attached, currently authorized identity only. Reserve the declared bytes, allocation minimum, artifact slot and concurrency before exclusive partial creation; then enter `receiving`. Unauthenticated, capability-only or unbound connections cannot stage. |
| `image_upload_chunk`: `transferId`, `seq`, `data` | `image_upload_chunk_ack`: `transferId`, `seq`, `receivedBytes` | In `receiving`, write exactly the next chunk to the captured private file descriptor, then increment sequence/bytes and acknowledge. `receivedBytes` is cumulative. At most one chunk is unacknowledged. Ack proves this private write completed, not crash persistence or harness delivery. |
| `image_upload_complete`: `transferId` | `image_upload_result`: `transferId`, `outcome:"staged"`, `artifactId`, `artifactExpiresAt`, `byteLength`, `mediaType`, `digest` | Only after exact length, actual digest, bounded PNG/JPEG decode and current authority pass. Publish one private artifact, convert rather than duplicate its reservation, enter `staged`; return no host path or insertion text. |
| `image_upload_cancel`: `transferId` | `image_upload_cancel_result`: `transferId`, `outcome:"cancelled"` | Cancel an owned unfinished transfer, close it and delete its partial file. Report success and release quota only after confirmed deletion. Failed cleanup stays terminal with its reservation retained. |
| Any correlatable refused request | `image_upload_refused`: `operation`, `code` | `operation` is the rejected request discriminator; no host paths, details, transfer/artifact identifiers or existence evidence are returned. Malformed envelopes without usable canonical request and session IDs receive no correlated reply and end the transfer connection. |

Refusal codes are exactly `malformed`, `unavailable`, `busy`, `conflict`, `sequence`, `integrity`, `unsupported_media`, `decode_failed`, `expired`, `binding_changed`, and `cleanup_failed`.
Use `unavailable` for unknown IDs, another device/grant/session, revoked authority, missing binding or unreadable authority state; these cases share the same response shape without an existence oracle.
Resolve identifiers only within the admitted device/grant/session namespace; never probe another owner's artifact and then report whether it exists.
Other codes require the currently authorized owning device/grant: capacity is `busy`; conflicting request reuse is `conflict`; order/length is `sequence`; digest mismatch is `integrity`; content-kind mismatch is `unsupported_media`; decoder refusal is `decode_failed`.
An owned known transfer reaching its deadline, changing binding or failing deletion uses `expired`, `binding_changed` or `cleanup_failed`, respectively; changed binding grants no further effect.

### Retry, retirement and cleanup

| Event | Exact candidate behavior |
|---|---|
| Same begin ID and identical begin fields | While `receiving`, return the same live acceptance, never allocate another partial. Changed fields, reuse for another operation or an already `staged` transfer is `conflict`; cancelled/expired transfer authority yields `unavailable`. Client timestamps do not refresh deadlines. |
| Duplicate/gap chunk or premature completion | `sequence` is terminal for the owner's partial; stop accepting bytes and clean it up. A late chunk after `staged` returns `conflict` without deleting or changing the completed artifact. |
| Lost chunk ack | The client cannot infer whether the write occurred. No blind retransmission and no partial resumption: cancel the owned transfer, then begin a new one with a fresh request ID after confirmed cancellation or expiry cleanup. |
| Retried complete | While the one artifact is retained and its captured authority is current, return the same staged artifact/outcome, correlated to the retry's request ID. Never allocate another artifact or insert anything. Expired/revoked/missing artifacts yield `unavailable`. |
| Retried cancel | An owned cancelled partial returns the same success while its bounded tombstone is retained; retry failed owned cleanup without releasing quota early. A staged artifact is not an unfinished partial: cancel returns `conflict` and cannot delete it. |
| Disconnect, detach or restart | No resumable partial state. Invalidate unfinished transfers and schedule owned cleanup; restart recovers only private artifacts/reservations, not transfer authority. A lost completion may therefore remain unavailable even if cleanup finds a file. |
| Unproductive wait or total expiry | Thirty seconds without an admitted completed write, or five minutes total, terminates a partial. Replays and rejected messages never extend either limit. |
| Bookkeeping bounds | Admission also reserves one retry/tombstone slot, at most 128 per home and 32 per device, counting active transfers and partial tombstones together. Keep partial tombstones at most until their original five-minute expiry, including across restart for refusal only; never restore transfer authority. Retain at most one completion record per retained artifact, bounded by the existing artifact quotas. If safe correlation cannot be retained, refuse new admission rather than forget an uncertain effect. |

Envelope examples illustrate candidate field spelling only; they are not golden fixtures or an end-to-end success receipt.
The staged result shape is separate from the chunk example; actual matching PNG/JPEG bytes and digest require conformance fixtures.

```json
{"type":"image_upload_begin","id":"11111111-1111-4111-8111-111111111111","timestamp":"2026-10-09T00:00:00.000Z","sessionId":"22222222-2222-4222-8222-222222222222","binding":{"harness":"claude","harnessSessionId":"33333333-3333-4333-8333-333333333333"},"mediaType":"image/png","byteLength":32768,"digest":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
{"type":"image_upload_accepted","id":"44444444-4444-4444-8444-444444444444","timestamp":"2026-10-09T00:00:00.001Z","sessionId":"22222222-2222-4222-8222-222222222222","requestId":"11111111-1111-4111-8111-111111111111","transferId":"AQEBAQEBAQEBAQEBAQEBAQ","expiresAt":"2026-10-09T00:05:00.001Z"}
{"type":"image_upload_chunk","id":"55555555-5555-4555-8555-555555555555","timestamp":"2026-10-09T00:00:01.000Z","sessionId":"22222222-2222-4222-8222-222222222222","transferId":"AQEBAQEBAQEBAQEBAQEBAQ","seq":0,"data":"AA"}
{"type":"image_upload_refused","id":"66666666-6666-4666-8666-666666666666","timestamp":"2026-10-09T00:00:01.001Z","sessionId":"22222222-2222-4222-8222-222222222222","requestId":"55555555-5555-4555-8555-555555555555","operation":"image_upload_chunk","code":"sequence"}
{"type":"image_upload_result","id":"77777777-7777-4777-8777-777777777777","timestamp":"2026-10-09T00:00:02.000Z","sessionId":"22222222-2222-4222-8222-222222222222","requestId":"88888888-8888-4888-8888-888888888888","transferId":"AQEBAQEBAQEBAQEBAQEBAQ","outcome":"staged","artifactId":"AgICAgICAgICAgICAgICAg","artifactExpiresAt":"2026-10-10T00:00:02.000Z","byteLength":32768,"mediaType":"image/png","digest":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
```

### Separately gated candidate operations

| Operation | Candidate frames and effect | Gate and availability |
|---|---|---|
| Claude reference insertion | `image_insert_request`: common request envelope, `sessionId`, expected `binding`, `artifactId`; `image_insert_result`: common correlated response, `outcome` exactly `inserted`, `refused` or `uncertain`, and `code` exactly `none` on insertion; `unavailable`, `busy`, `conflict`, `expired`, `binding_changed` or `prompt_up` on refusal; `delivery_unknown` on uncertainty. `inserted` means one confirmed reference write without Enter, never proof the harness read the image. | No automatic insertion after staging. Check authority/binding/prompt at the actual serialized PTY effect. Only refusal before any possible write permits a new explicit attempt; each artifact permits at most one possible insertion. Cache/return recorded results without another write, including a retried request ID; changing the ID cannot evade retirement. Retain retirement while the artifact is usable; do not replay or auto-retry. The owner accepted the original expiry in ADR0042. The installed corrected route, direct host and explicit web caller are verified separately; native conformance is still required for native availability. |
| File fetch | [Accepted ADR0045](../.context/decisions/0045-direct-file-download.md): begin/accepted, bounded `file_fetch_read/chunk` pull responses, complete/result, cancel/result and short refusal. One admitted project-relative nonempty regular file, 10 MiB, exact private-copy digest and explicit client Save. A read acknowledges the preceding chunk; cancellation also works during preparation using the begin ID. | The current source composes strict original-byte ingress, the managed journal, actual Claude/Codex session lifetimes and an explicit web Save caller on authenticated WSS. Capability readiness belongs to the concrete attached connection and known binding. Coherent runtime, compiled Linux, independent review and fresh hosted gates precede release. Native, operator certificate setup and relay acceptance remain separate. |
| Link forwarding | Accepted ADR0044: `browser_link_receiver_request/result/ended` and `browser_link_candidate`; exclusive explicit Receive, bounded canonical HTTP(S) destination and a separate client Open choice. | The source now composes the Claude BROWSER producer and the explicit web receiver over both the signed public-TLS direct path and the authenticated encrypted relay channel. Relay tests use the source Worker under Miniflare, HubRelay, the child proxy and the actual app; browser checks cover selection, explicit Open, replacement and natural expiry. No plaintext fallback. Deployed Worker, native-device, Codex-producer, installed-consumer and operator PKI acceptance remain separate. |
| Codex attachment delivery | No candidate PTY insertion, `-i` relaunch or implicit `turn/start` fallback. | Unavailable until the owner resolves #1207 and the structured attachment operation/posture is independently demonstrated. |

## Spike plan and Xcode handoff

No helper or decoder dependency is selected by this proposal.
The owner's supported hosts are Apple Silicon Macs and Linux ARM64/x64.
Run each implementation spike on `bun-darwin-arm64`, `bun-linux-arm64` and
`bun-linux-x64`, including the actual compiled release shape and both project
Bun gates, before relying on it: six required target/version executions.
Intel Mac and Rosetta execution are outside product scope.

| Spike | Evidence and pass/fail gate |
|---|---|
| Portable private storage and egress | Identify descriptor-relative open/create/rename/unlink and regular-file inspection APIs. Use captured roots and the same opened descriptor; deterministic ancestor/final-component replacement, symlink/hardlink/device/FIFO, credential-root overlap and detected source-mutation cases must refuse. Prove private-copy publication and crash cleanup without project traversal. Unsupported target/API or inability to enforce checks means no corresponding capability, never a path-based fallback. |
| Bounded image decode | Compare explicitly declared decoder candidates and their license/distribution requirements. Miniflare's transitive `sharp` is not a daemon runtime implementation. Before choosing, prove full PNG/JPEG decode, dimension/pixel admission before excessive allocation, finite CPU/memory/deadline/concurrency budgets, cancellation and malformed/truncated/decompression cases on all three supported compiled targets. Decoder work must not stall a real held approval. Failure leaves staging unavailable. |
| Claude insertion and lifetime | Record the installed version; use owned scratch paths including spaces and quoting cases. Measure actual bytes/no Enter and no reference write for held, terminal, observed-menu and queued-prompt controls. Trace when image contents are consumed and whether session exit/resume still needs the file. Prove one effect with lost-receipt, revoke/regrant and changed-binding controls. Unproven quoting, prompt protection or reference lifetime leaves insertion unavailable. |

| Xcode operation | Availability after this docs-only preparation |
|---|---|
| Picker/upload progress | No runnable capability yet. X5 may consume frozen staging frames only after handler, production caller and TypeScript/Swift conformance gates pass. |
| Agent attachment insertion | Separate from staged upload; signed direct Claude host/web caller under ADR0042, native independently gated; Codex unavailable until #1207 and structured-operation proof. |
| File download/preview | Unavailable until fetch fields, portable confinement, validated private-copy semantics and inert preview gates pass. |
| Open agent link | Unavailable until explicit selected-client forwarding/launch gates pass; no automatic open or host fetch. |
| Relay attachment bytes | Unavailable until accepted v2 transport and real Worker/hub/client ciphertext-only controls; no APNs/HTTP-answer/legacy fallback. |

## Implementation order and gates

### Preparation measured on 2026-10-09

Private feasibility probes used owned temporary files and containers; no production handler, dependency, capability or native control changed.
The storage prototype passed seven primitive controls on Bun 1.3.11 and 1.4.2: exclusive private creation/publication, same-descriptor inspection/read, component validation, symlink and hardlink refusal, and cleanup through a captured directory after path replacement.
All eight target binaries built; six executions passed: Mac ARM natively, Linux ARM in a Docker VM and Linux x64 under Docker Desktop emulation, on both Bun versions.
At that checkpoint Mac x64 execution was unmeasured because Rosetta was unavailable.
These primitive controls do not establish the full race/credential corpus, durable quotas, recovery or transfer authority.

The final experiment used a small C wrapper and checked native symbols with Bun's experimental compiler/FFI APIs.
Earlier compiled experiments failed on embedded source lookup and Linux libc linking; a rejected pointer experiment crashed because it used a function property absent from the public API.
Those failures remain part of the packaging evidence; no helper is selected for shipping.
The existing development dependency `sharp` 0.33.5 passed five tiny source decode/refusal cases, but its compiled Mac ARM binary could not load the native runtime from an empty working directory.
That candidate has no distributable or bounded-resource acceptance yet.
Receipts and exact input hashes are retained in `/private/tmp/remi-1284-77yRf87N/tunnel-probe/`; these are local evidence, not repository dependencies.

The existing seven-control source is now reproducible through
[`scripts/tunnel-storage-proof/`](../scripts/tunnel-storage-proof/README.md).
Its runner builds both Bun versions for the three supported targets, records source and
executable hashes, and accepts a runtime result only when its version,
platform, architecture and named controls match.
Missing executions remain explicit failures; `--build-only` exits 2 with an
incomplete receipt. This tool selects no production
helper. Its initial tooling PR (#1343) carried build preparation;
the historical runtime results above belong to the earlier private source.

On 2026-10-10, after the owner approved installing Rosetta, the checked-in
seven-control probe built and executed successfully on all eight target/version
combinations: Mac ARM natively, Mac x64 through Rosetta, Linux ARM in Docker's VM
and Linux x64 through emulation, on Bun 1.3.11 and 1.4.2.
The first repeat stopped before Linux execution: Docker's platform inspection
returned a platform manifest digest that `docker run` could not address.
The corrected runner pins each reference once for the whole matrix to a local
image/index ID, inspects the requested platform
through that immutable ID, records both IDs, and runs it with the explicit platform.
The original failure and successful unchanged primitive controls are retained in
`/private/tmp/remi-1170-packaging-20261010-a/` and sibling `-b/`/`-c/` receipts.
A controlled retag of a unique owned alias before the second Bun compiler left
all eight executions passing, with all four Linux executions using the original
image; that control and alias cleanup are
recorded in `/private/tmp/remi-1170-pin-control-20261010/receipt.json`.
The full path-race, nonregular-file and credential-overlap corpus remains a T0a
gate before production storage is selected.

The owner then clarified on 2026-10-10 that Intel Mac support is not offered.
The Intel/Rosetta executions above are historical extra work and impose no
current acceptance requirement. Required matrices now cover Apple Silicon Mac,
Linux ARM64 and Linux x64 on both Bun gates. Linux x64 remains supported.

The private T0b candidate pins `pngjs` 7.0.0 and `jpeg-js` 0.4.4 and adds admission
before full decoding; neither dependency is selected for the daemon.
Its eight standalone executions decoded the same two owned sample inputs and
reported matching dimensions, pixel lengths and pixel hashes on all target/version
combinations. The revised candidate, input/dependency hashes, initial static
finding and runtime receipts are in `/private/tmp/remi-1170-decoder-20261009-b/`.
This establishes valid-sample packaging only; malformed/decompression handling,
hard process budgets, cancellation, concurrency and actual held-approval
responsiveness remain unproved T0b gates.

### Next independently reviewable changes

Continue #1170 and this proposal; do not start another tunnel plan or duplicate native X2.
Paths below are proposed implementation locations, not modules already present.
Keep each change to one subsystem and about 500 net implementation lines; split it when needed.

The next bounded T0a change extends the existing standalone storage candidate
under `scripts/tunnel-storage-proof/`; it selects no production helper.
Its admission gate is fixed before execution: preserve all seven primitive
controls and pass hidden/credential component refusal before any native open,
configured credential-directory containment (including custom names, sibling
prefixes, replacements and renamed directories), captured-root replacement,
deterministic ancestor/leaf replacement, retained-descriptor revalidation,
symlink/hardlink and directory/FIFO/socket/device refusal, and the initial
10 MiB size boundary. All three supported compiled targets must pass on both
Bun versions with matching source hashes and no cleanup failures.
Private mutations of the component, credential-path/identity, regular-file,
link-count, size, name-identity, current-root refresh and retained-root snapshot
guards must fail their exact named real-filesystem assertions.
Failed runs remain evidence; they do not relax the gate.

The candidate rejects backup suffix `~`, colon syntax, control and bidirectional
characters, components over 255 UTF-8 bytes and paths deeper than 64 components.
Trusted absolute roots are walked from `/` without following symlinks; their
canonical spelling is supplied by the owned fixture setup, never a client.
Credential roots are represented by held directory identities plus their
configured component boundaries, compared with ASCII case folding.
A rename keeps the identity denied; a replacement at the configured name keeps
the path denied. The candidate also captures current configured-directory
identities before admission and lease revalidation to cover actual filesystem
normalization/non-ASCII case aliases without assuming string collation rules.
The admission snapshot's descriptors and identities stay held through traversal
and the resulting file lease; a configured replacement moved under a selected
ancestor during lookup remains denied, even after its configured name is recreated.
It inspects directory metadata only; missing/unreadable configured roots refuse.
Receipts report which actual alias modes the filesystem provided.
The device control inspects `/dev/null` metadata without reading bytes or
creating a device; every other content fixture is an owned temporary file.
These admission checks detect the recorded name replacements, but do not
establish an atomic snapshot or a validated private copy. Private-copy bounds,
growth/truncation/mutation, publication/recovery, quotas and transfer authority
remain separate subsequent gates. No capability or attachment UI is advertised.

Admission landed in #1362 at `35ccce9a`: six builds/executions passed all
16 controls, and 12 guard mutations failed their exact named assertions on
both compiled Mac ARM Bun versions (24/24). Linux mutation execution remains
unmeasured; the standalone candidate selects no production helper.

The next bounded change adds `private-copy.ts` and an owned `copy-probe.ts`
beside that candidate, reusing `AdmittedFile`, captured directories and native
exclusive creation/link/unlink. Its gate is fixed before execution:
preserve all 16 controls; pass empty/nonempty/10 MiB copies with exact bytes,
digest and mode; read no more than admitted size plus one using bounded chunks;
refuse growth, truncation, detected same-size edits (including restored mtime),
new hardlinks and source ancestor/leaf/root replacements; refuse private-root
replacement and publication collisions without overwriting another file;
prove captured-directory cleanup and real read/write errors. All six compiled
executions must match the exact control list and input hashes, without cleanup
errors. Removed copy guards must fail their exact named filesystem assertions
on both compiled Mac ARM Bun versions; Linux mutations remain a separate limit.
Failed runs are retained. No source bytes leave the probe before validation.

This step checks descriptor identity/type/link count/size and nanosecond
mtime/ctime against admission metadata before and after copying. Publication
uses a generated private name and only the completed private descriptor is read.
It does not prove atomic source snapshots or complete concurrent-edit detection.
Durable reservations, recovery, production-helper selection, transfer authority
and the attachment capability remain later gates.

Independent review of the initial E/B candidate found destination mutations
after validation and private name replacement missing from its controls.
The corrected candidate repeats destination validation at publication and
binds generated names to the held private device/inode before publication and
cleanup. Replaced names refuse cleanup without deleting the replacement.
New controls alter destination bytes/mode at publication and replace actual
partial/completed names. This detects the recorded replacements; name checks
and subsequent effects are not atomic against every concurrent edit.

The corrected private-copy candidate passed six builds and six executions on
2026-10-10 with all 27 primitive/admission/copy controls and no cleanup errors.
Twelve removed-guard variants failed their exact named assertions on both
compiled Mac ARM Bun gates (24/24); Linux mutation execution and forced partial
writes are unmeasured. Final source snapshots, binaries and logs are retained
in `/private/tmp/remi-1170-copy-20261010-f/` and
`/private/tmp/remi-1170-copy-mutations-20261010-d/`.
Earlier copy receipts remain historical snapshots. A targeted typecheck found
a fixture type-annotation shadowing error, corrected before the final result.
Mutation receipt C caught the new name guards but failed exact witness matching
because `assert.throws` prepends `Missing expected exception:`. D registers that
full message; no source, corpus, mutation or exit condition changed. C remains
failed evidence, rather than acceptance.

Private-copy preparation landed in #1381 at `0ebbcc92`; no storage helper or
attachment capability is selected. The next bounded T0b change reuses the
existing private pngjs 7.0.0/jpeg-js 0.4.4 admission candidate and valid-sample
proofs under `scripts/tunnel-decoder-proof/`, sharing the supported-target
runner with storage rather than duplicating its Docker/platform logic.
Before execution its gate is: six compiled runs reproduce exact owned PNG/JPEG
input and pixel hashes; reject malformed/truncated headers, excessive input,
sides and pixels, PNG animation/interlace and duplicate/end/chunk errors,
JPEG frame/table/segment/scan/end errors; full decoding rejects CRC and entropy
damage. A header check alone never declares valid pixels. Relevant removed
admission guards must fail exact named assertions on both compiled Mac ARM gates.
Preserve all six storage proof executions when adapting the shared runner.
Dependency files and helper/source inputs must be snapshotted and hashed.

The current pngjs synchronous interlaced path calls `zlib.inflateSync` without
an output limit (`pngjs/lib/parser-sync.js`); this feasibility candidate will
refuse interlace before calling it. This is a candidate subset, not a selected
production format policy. Hard process budgets, cancellation/concurrency and
actual held-approval responsiveness remain the subsequent T0b gate; this
header/corpus preparation cannot clear them or advertise upload support.

Decoder admission preparation passed six builds and six executions on
2026-10-10 with ten exact header/malformed/full-decode control groups and
matching owned input/pixel hashes. Eighteen removed-guard variants failed
their exact named assertions on both compiled Mac ARM Bun versions (36/36);
Linux mutations remain unmeasured. The shared runner's default storage proof
also passed six builds/executions with all 27 controls.
Independent review found that initially enumerated dependency hashes missed
added files. The runner now compares exact entry types/names/hashes in both
installed and captured trees, verifies the copied manifest and archives its
own input. Actual extensionless-file additions in each tree invalidated the
receipt before the second compiler's first build started; owned dependency
copies were used.
Final evidence is retained in `/private/tmp/remi-1170-decoder-20261010-corpus-e/`,
`-storage-e/`, `-mutations-b/` and `-tree-control/`.
Earlier receipts remain historical snapshots. The first private tree-control
driver failed parsing before execution; its corrected driver and failure are
retained separately, and only the executed controls count as acceptance.

| Next PR | Existing code and proposed files | Prerequisite and exit gate |
|---|---|---|
| T0a: storage packaging proof | Reuse restricted storage conventions; proposed `packages/daemon/src/tunnel/storage.ts` and owned filesystem controls under `packages/daemon/tests/tunnel/`. Choose a helper only after comparing compiled distribution support. | Execute all three supported targets on both Bun gates; complete the race, non-regular-file and credential-overlap corpus. Record unsupported targets explicitly. No advertised capability. |
| T0b: decoder packaging proof | Compare explicitly declared PNG/JPEG decoder candidates and license/runtime assets; proposed `tunnel/image-validation.ts` and decoder corpus. Do not import Miniflare's development dependency as an implicit runtime dependency. | Standalone compiled execution on all targets, full decode with admission before excessive allocation, finite CPU/memory/deadline/concurrency limits and cancellation. A real held approval stays responsive. No chosen dependency before evidence. |
| T0c: staging codec and conformance | Implement accepted [ADR 0041](../.context/decisions/0041-direct-image-staging.md) with strict validators and golden positive/refusal fixtures under `packages/shared/`; coordinate Swift conformance in the existing native track. | Owner accepted fields, bounds, outcomes and cleanup policy on 2026-10-11. T0a/T0b production adoption feasibility and protocol/runtime integration still precede availability. Fixtures alone do not advertise support. |
| T1a storage: reservations and recovery | Reuse `storage/interprocess-file-lock.ts`; proposed `tunnel/reservations.ts`, private artifact ledger and startup recovery. | Reserve bytes and artifact slots across actual processes before creation; retain failed-cleanup reservations. Crash recovery touches only captured private roots. This internal preparation exposes no upload API. |
| T1a lifecycle: authenticated direct staging | Reuse server-derived identity, `withAuthorizationEpoch`, hub/child session routing and frozen validators; proposed `cli/handlers/image-upload-events.ts` and `tunnel/transfers.ts`. | Exact bytes/digest/decode; revoke/regrant, detach, rebind, lost-ack, cancellation, saturation and cleanup controls against real hub/child. Keep the capability unadvertised until its production client caller lands. |
| T1a caller: one direct client upload | Reuse `packages/web/src/components/chat/InputArea.tsx`, connection dispatch and `hubSupport`; add explicit file selection, progress, staged result and cancellation. | One shipping caller completes an image against the source hub; rendered select/cancel/refusal/reconnect states pass. Advertise staging only with the accepted handler and caller. Completion never inserts a reference. |
| T1b: optional Claude insertion | Reuse `harness/types.ts`, `prompt-up.ts` and the serialized PTY effect; add a separate insertion handler/capability and explicit caller. | Installed-version quoting and reference lifetime proof, zero input for each prompt refusal, and at most one possible effect after a lost receipt. Codex remains gated by #1207. |
| T2-T4: links, fetch and native depth | Follow the gates below. X5 (#1245) adds native picker/progress for the landed staging contract; native insertion and fetch controls follow their separate capabilities. | Independent scope and acceptance for each. Direct staging does not wait for relay deployment or insertion; relay attachment bytes and signed native UI require their own runtime/device evidence. |

T0a and T0b can proceed independently while native #1330 receives review and owner device acceptance.
Use one implementation lead and one independent reviewer per change; keep the Xcode developer's existing native worktree and ownership.
The immediate packaging probes require neither cloud deployment nor a paid harness turn.
If a gate fails, preserve its evidence and resolve or narrow the supported scope before advancing.

| Phase | Work | Gate before advancing |
|---|---|---|
| T0: threat model and freeze | Review this proposal; settle filesystem portability, snapshots, image lifetime, bounds and insertion semantics. Write the protocol ADR and fixtures. | No unresolved security-critical decision and a source trace for every reuse claim. |
| T1a: direct image staging | Portable private storage, bounded decoder, authenticated chunk lifecycle and one real client caller; no insertion. | Real source hub/child: strict bytes/digest/decode, device/grant/session isolation, quotas, lost-ack/refusal and cleanup; a real held approval remains responsive. |
| T1b: explicit Claude insertion | Optional harness attachment operation and guarded serialized reference write, with separate capability/caller. | Installed Claude: no Enter, zero prompt input on refusal, one effect under lost receipt, and proven image lifetime including resume. |
| T2: explicit link forwarding | HTTPS/WSS first, then a session-scoped shim and user-triggered client launch. | Actual process environment/shim/client trace; no host fetch, automatic launch or credential inheritance. |
| T3: read-only file egress | HTTPS/WSS first; accepted 10 MiB limit, portable descriptor confinement, denial policy, snapshot semantics and inert client handling. | macOS/Linux path-race corpus, credential overlap controls, quotas and revoked-device controls. No egress on an unsupported filesystem API. |
| T4: relay transport and native depth | Reuse accepted v2 transport and implement X5 UI for capabilities already present. | Real Durable Object, hub and client; no content on Worker logs, HTTP answer routes or push; owner signs and exercises physical-device UI. |

Each phase is one independently reviewable PR or is split further when its implementation exceeds that scope.
Pin existing chat/approval behavior before modifying it; mutation-check each new security control by demonstrating that removing the guard fails its named scenario.
A passing parser or build does not establish filesystem confinement, harness delivery, relay privacy or physical-device acceptance.

## Decisions still required before implementation

- Prove the macOS/Linux descriptor API available to Bun, and choose any required platform helper explicitly; do not substitute a racy `realpath` check.
- Prove the descriptor checks for validated private-copy fetch semantics; do not describe them as atomic source snapshots or complete concurrent-edit detection.
- Choose a bounded decoder only after CPU/memory/concurrency and compiled-target evidence; dimensions and a transitive development dependency are insufficient.
- Claude direct insertion and visible original expiry are accepted in ADR0042; native follows its own conformance and rendered-device gates.
- Resolve Codex attachment delivery with #1207; observing a CLI flag is insufficient to authorize starting a turn.
- Review the proposed type allowlist, bounds, cleanup lifetime and credential deny corpus before freezing them.

This preparation uses one lead and one independent security reviewer.
Implementation reviews and owner hardware/signing are separate future gates.

## Internal reservation accounting preparation

The sole reservation and journal-schema implementations now live in
`packages/daemon/src/tunnel/`; the standalone proof paths re-export them.
`RecoveryError` is extracted once and shared by both paths, preserving constructor identity.
No daemon source imports the proof directory.

This move preserves all accounting guards and limits, trusted private metadata,
nonblocking locking, retained cleanup debt and bounded settled receipts.
It stores no transfer authority and initializes no owner state at startup.
The package index has no new export or runtime caller.
Descriptor, journal and explicit native-helper ownership are recorded below;
active transfer lifecycle and upload availability remain upcoming.

Both Bun gates passed a pre-edit actual-ledger characterization and the
88-group compiled Mac baseline.
After the move, all six supported compiled cells passed the unchanged 88 groups,
and twelve exact Mac guard controls passed with their registered witnesses.
The focused filesystem test verifies proof/daemon constructor and schema-function
identity, actual private ledger persistence and device-cap refusal.
Full shared and focused license/harness boundary populations pass on both Buns.
These observations establish the mechanical internal move, not a production
transfer, physical allocation ceiling or power-loss guarantee.

## Internal descriptor admission adoption

The daemon owns the existing descriptor admission implementation and exact
`PrivateOps` type; the proof paths explicitly re-export the same classes and type.
The shared ancestor checks, file admission rules and private-copy behavior are
unchanged. There is no package index export or active daemon caller.

The original 88-group Mac baseline passed on both Bun versions before the move.
The moved implementation passed those same 88 groups on all six supported
Mac/Linux and Bun combinations, plus twelve exact Mac settlement guard controls.
A focused test uses the real native operations to verify constructor identity,
actual captured directory descriptors and closure. Shared and boundary tests pass
on both Buns. These results cover the internal descriptor move; journal lifecycle adoption
and journal-helper packaging are recorded below. Transfer handlers, client
upload and capability advertisement remain upcoming.

## Internal journal lifecycle adoption

The daemon owns the existing descriptor-backed recovery and settlement bodies.
The proof paths explicitly re-export the same implementation and error constructor;
mutation controls now target the moved source while preserving every guard and witness.
No package index export, startup initialization or active transfer caller is added.

The unchanged 88-group compiled profile passed all six supported Mac/Linux and
Bun combinations after the move. Twenty-two exact Mac guard controls passed,
and their 44 misleading setup/success controls were rejected. Both Bun versions
passed shared and focused boundary tests; the new filesystem test writes and
closes the actual private journal, verifies owned cleanup and retires its lease.
These results cover internal adoption, not a physical allocation ceiling or
power-loss guarantee. Helper adoption is recorded below; decoder adoption,
authenticated upload handlers, a client caller and capability advertisement
remain upcoming.

## Internal native journal helper adoption

The daemon owns the existing `recoveryNative` factory, its byte-identical C
asset and the sole C filename declaration. The proof module re-exports that same
function; the old proof C source is removed. Both the factory and proof asset
declaration reference the daemon-owned type declaration, so the original root
TypeScript graph resolves the bundled asset without a focused-only files override.

The factory preserves descriptor-relative open/create, exact native errno,
close-on-exec, nonblocking flock and unlink. Its link operation remains explicitly
unsupported. The selected helper supplies the journal operations; the private-copy
path retains its existing helper. The caller closes dependent descriptors before
exactly one factory close.
No package index export, startup initialization or active transfer caller is added.

All six supported platform/Bun compiled cells passed the unchanged 88-group
settlement profile, with matching frozen inputs and clean owned temporary state.
Both original root TypeScript checks pass. Both Bun versions passed 41 focused
tests and 500 assertions; the new real-filesystem test checks function identity,
owned image bytes, exact errno, raw successful CLOEXEC results, nonblocking lock
contention/release and ordered closure. Earlier guard receipts remain qualified
historical evidence; unchanged guards received no new mutation campaign.

This accepts the explicit internal helper packaging.
An active daemon lifecycle, physical allocation ceiling and power-loss behavior
are not established by these finite observations. Image header admission is
recorded below, followed by internal full-decoder ownership. Owned worker
integration, authenticated staging and a production client caller still precede
upload availability and capability advertisement.

## Internal image header admission adoption

The existing image header parser now lives in daemon
`tunnel/image-admission.ts`; descriptor admission keeps its distinct module.
The proof path explicitly re-exports the same constant, function and type.
Input, dimension, palette, segment and scan guards retain their existing behavior.
Thirteen type assertions on byte reads already bounded by those guards satisfy
the original root TypeScript settings. Their emitted JavaScript is byte-identical
to the original parser; no runtime guard or configuration is changed.

The default decoder proof now captures the moved daemon source through the same
repository-tree and compiled-entry facilities used by the held-answer profile.
The final default 19-group and held 22-group profiles each passed all six
supported platform/Bun cells. All 24 build/run exits are zero; original controls,
fixture pixels, the 42-member candidate dependency tree and cleanup results are
preserved. The header phase passed both root type checks and both focused
42-test/495-assertion populations with no new static diagnostics or warnings.
After integration with the journal helper, both unchanged root checks and the
combined 43-test/520-assertion populations also pass. The four header source
paths retain their reviewed hashes; these integration checks do not replace the
source-qualified six-cell decoder receipts.

These observations cover internal header admission and its existing standalone
proof callers. Internal full decoding and direct decoder dependencies are
recorded below. The owned worker entry and active staging lifecycle remain
subsequent work.
No package index export, startup call, upload handler, production client or
attachment capability is added. Header admission alone does not validate pixels
or establish a universal process memory/CPU ceiling. Keep #1170 open.

## Internal full image decoder adoption

`tunnel/image-decode.ts` owns the existing synchronous decoder function body.
Only its status comment and admission import target change; the proof path
re-exports the same function. Header admission remains outside the decoder's
try block. PNG CRC validation, strict JPEG options, dimension/pixel-length checks
and normalized decode failure retain their existing behavior.
The exact 602-byte PNG/CRC declaration now belongs to the daemon; the proof
references it and retains its separate image asset declarations.

The daemon directly selects pngjs 7.0.0 and jpeg-js 0.4.4.
Their installed 42-member dependency tree is byte-identical to the measured
candidate. Bun-generated lock changes add only those exact pins and relocate
the unchanged PNG 5.0.0 entry for qrcode. All other package and workspace metadata
is unchanged. Actual bundle/license checks find PNG 7/JPEG 0.4.4 in the decoder
module and only PNG 5 in the existing 17-package CLI graph.
The proof notices now describe the selected internal dependencies; license text
is preserved. No package index export or startup decoder call is added.

Both original root TypeScript configurations pass without extra declaration or
files inputs. Both focused populations pass 53 tests and 618 assertions, including
real owned image input/pixel hashes, shared function identity, header refusal and
PNG CRC failure. Python diagnostics remain unchanged; scoped formatting,
spelling and diff checks pass. Missing offline metadata/tarballs were resolved
in an owned S1 install with a frozen lock; earlier setup failures are retained.

Both existing profile runners capture the daemon manifest, moved source and root
lock. The final default 19-group and held 22-group profiles each passed all six
supported platform/Bun cells: all 24 build/run exits are zero. Original ordered
controls, fixture pixels, all 42 dependency members and clean owned temporary
state are preserved. Actual held No latency under repeated decoding was
0.72-61.16 ms below the unchanged 1,000-ms limit; every deliberate parent-block
control exceeded it. Original child lifetime, output and reap controls remain.
These finite observations do not establish universal process memory/CPU ceilings.

This accepts internal decoder dependency/body ownership. Synchronous decoding
is not an active transfer path: controller/worker ownership is recorded below,
and a trusted pre-CLI entry still precedes lifecycle integration.
Authenticated staging, current transfer authority and one production client still
precede capability advertisement. No upload caller or `image_staging` capability
is added. Keep #1170 open.

## Internal image controller and worker adoption

`tunnel/image-process.ts` and `tunnel/image-worker.ts` now own the existing
controller and worker bodies. Only ownership comments and admission/decoder
import targets change. The proof modules explicitly re-export the same runtime
and type symbols. No production child entry, startup caller, message registration
or upload capability is added.

The controller retains owned input, its single busy slot, 4,096-byte output cap,
at-most-5,000-ms deadline, SIGKILL cancellation and awaited child exit before
slot release. Its child environment still admits PATH, LANG and TMPDIR plus the
fixed interpreter policy; the parent environment remains unchanged. Worker input
bounds, normalized refusal, scalar pixel result and repeated proof mode retain
their measured behavior.

Both original root TypeScript checks pass. Both focused populations pass 54 tests
and 662 assertions. The new actual-child test checks shared symbol identity,
PNG/JPEG input and pixel hashes, input ownership, CRC refusal, busy rejection,
repeated cancellation, reaping, slot reuse and parent policy isolation.
Scoped formatting, spelling and diff checks pass with no new warnings.
The decoder graph selects its existing two packages; the CLI keeps its unchanged
17-package graph and licenses.

Both existing default 19-group and held 22-group profiles pass all six supported
platform/Bun cells; all 24 build/run exits are zero. Original ordered controls,
fixture pixels, the 42-member decoder dependency tree and clean owned temporary
state are preserved. Actual held No latency under repeated decoding was
0.55-15.29 ms against the unchanged 1,000-ms limit; all six deliberate parent-block
controls exceeded it. These finite observations do not establish a universal
process memory/CPU ceiling or an active upload path.

Trusted pre-CLI entry packaging is recorded below. Next implement the
authenticated staging lifecycle and one production client.
Keep #1170 open; capability availability follows that completed path.

## Trusted image worker entry

The daemon entry now selects the exact local `--internal-image-worker` mode
before importing CLI, home or configuration modules. It accepts one PNG/JPEG
media argument; malformed internal shapes are refused before imports.
Every other invocation imports the existing CLI. Only the first operand selects
the internal mode, so words after `--` retain their ordinary harness meaning.
Root and daemon source/build scripts, the release compiler, integration Docker
compiler and default notice graph now point to this entry. The compiled-version
marker stays in `cli.ts`, whose implementation bytes are unchanged.

The fixed local factory derives the source entry from its own module or uses the
actual compiled executable, including arbitrary artifact names. It requires a
locally generated private empty directory owned by the service; it accepts no
client executable or command. The service must retain that directory exclusively
until its child is reaped. The factory check does not protect against later
mutation by the owning user. The controller adds only an optional cwd and two
spawn properties; absent cwd preserves the original proof callers.
Child environment, JIT policy, bounds, input ownership, cancellation and awaited
exit remain unchanged. Normal CLI runtime configuration behavior is preserved;
the private worker cwd prevents loading a repository's runtime configuration.

Both original root checks and both focused populations pass on Bun 1.3.11 and
1.4.2: 58 tests and 741 assertions. The new integration profile has a separate
strict type check using the unchanged root options and exact existing declarations.
Actual default-entry bundle/license checks include PNG 5, PNG 7 and JPEG across
19 packages. Two Mac source controls and all six supported compiled platform/Bun
cells pass 36 identical ordered controls each, covering actual entry pixels,
private-cwd factory/self-exec, argument boundaries, normal help/version, a real
sessionless hub and an inert child. All 20 entry build/run exits are zero.
Owned dotenv and bunfig positive controls are observable on every runtime cell;
private-cwd controls remain clear. Linux source-runtime acceptance is not claimed.

The unchanged default 19-group and held 22-group profiles also pass all six
supported compiled cells, for 24 additional zero-exit rows. Original ordered
controls, pixels, 42 dependency members, fixture limits, reaping and cleanup are
preserved. Held No latency was 0.52-69.21 ms below the unchanged 1,000-ms limit;
all six deliberate parent-block controls exceeded it. Earlier test-only CLI
environment and remote-argument failures remain superseded evidence. No
production guard or deadline was weakened to pass them.

This establishes the owned child entry and its finite packaging acceptance.
The authenticated staging lifecycle still owns reservations, current transfer
authority, private worker-directory lifetime and staged cleanup. One production
client remains required before `image_staging` advertisement. No upload handler
or capability is added here. Keep #1170 open.

## Internal staged journal read ownership

A successfully closed managed journal now opens one internal `JournalRead` view.
It reacquires and holds the journal's intent lock and an owned read descriptor,
exposes only bounded reads of at most 32 KiB, and requires the exact declared file
length. Cleanup may win between writer close and read open; that open then refuses.
Current roots, private ownership, marker witnesses, inode, size and modification
metadata are checked around reads and staged retention. Missing artifacts refuse;
cleanup's zero-allocation observation never supplies a readable file. Failed closes
latch failure without retrying a potentially reused descriptor; the tested artifact
descriptor failures retain the intent until process death.

`captureJournalRead` and `retainJournal` use the existing nonblocking ledger lock.
Staged conversion retains the same lease, declaration, ownership, bytes, artifact
slot and monotone accounting debt; it frees only active-transfer counts. Repeating
retention on the same current held staged reader allocates nothing more. Generic
retain/refund methods still reject journal rows, and original witnessed settlement
remains the only refund path. The v1 ledger schema and native helper are unchanged.

Both original root type checks pass. Both focused populations pass 59 tests and
750 assertions across 13 files, including 17 shared real-filesystem groups and
two actual failed-close/recycled-descriptor children whose deaths are awaited.
The existing compiled settlement profile preserves its original 88 ordered
groups and appends those 17. All six supported platform/Bun cells pass 105 groups,
with all 12 build/run exits zero, exact PNG/JPEG inputs, child reaping and clean
owned temporary state. Existing 256 MiB/64-process Linux fixtures and deadlines
are unchanged; these are finite observations. Python diagnostics preserve one
existing Ruff result and zero Pyright diagnostics, with none added.

Transfer IDs, authorization grant/session/binding, digest/decode, retry deadlines
and published completion belong to the subsequent authenticated coordinator.
This storage API does not recreate live readers after restart, register messages
or advertise uploads. One production client still precedes `image_staging`
availability. Keep #1170 open.

## Direct staging coordinator: dormant milestone

`ImageStagingService` now composes the owned journal and decoder for begin,
acknowledged chunks, completion and cancellation. It captures the actual signed
direct connection, canonical public key, authorization epoch, attached session,
PTY and exact Claude binding; each effect rechecks that captured authority.
Storage quotas use the full public-key hash, independently of the display fingerprint.
Admitted completions share one decoder queue and retain their original deadlines.
Completed artifacts retain the managed read lock until expiry or session exit.
Cancellation receipts remain bounded and cannot revive an evicted lease.

Both root type checks and the focused 55-test, 563-assertion population pass on
Bun 1.3.11 and 1.4.2. These Mac source checks construct real signed sockets,
PTYs, files and decoder children, including foreign-client refusals, grant
replacement, binding changes, shared-home recovery/capacity, cancellation during
completion, the actual 30-second idle deadline and retirement at shutdown.
That dormant milestone had no startup caller or advertised capability.
The subsequent direct integration and its acceptance are recorded below.
Keep #1170 open for the remaining native, relay and explicit insertion work.

## Direct image staging integration

The candidate now registers all nine ADR 0041 messages and routes staging frames
through the strict bounded parser before ordinary JSON decoding or deduplication.
Only an authenticated supported Claude host initializes the coordinator.
Its actual signed direct attachment selects `image_staging`; session-less hubs,
query connections, relay virtual connections and capability-only peers retain the
base capabilities. Hello and direct reattachment carry the current binding and
matching connection-scoped machine descriptor.

The production web connection manager owns a stop-and-wait upload controller.
The chat panel selects a PNG/JPEG, shows acknowledged progress, permits explicit
cancellation and reports the staged result or uncertainty. An unconfirmed attempt
cannot blindly restart on the same context. No upload inserts an image into the
harness or returns a host path. Unconfigured direct `ws://` remains unencrypted
by Remi; use the optional TLS listener or an existing private transport as
described in ADR 0009.

Both Bun source populations pass 1,462 tests and 5,427 assertions across eleven
files, including both shipping direct-dispatch endpoints. Root, web app and web
test type checks pass on both Bun gates. A real source hub, child and shipping
web transport/controller stage exact PNG/JPEG bytes; reattachment carries binding
and capability. All six compiled server cells pass the corresponding 21-assertion
control on Apple Silicon macOS, Linux ARM64 and Linux x64 under Bun 1.3.11 and
1.4.2. The Linux test driver is Bun 1.3.11 for both compiled server versions;
its fixture uses 256 MiB, 64 processes and an executable private tmpfs for the
inert test CLI. These are finite observations, with no new OS resource campaign
or model turn.

Fresh rendered Chrome acceptance of the production App at 1,024 and 390 pixels
passes PNG/JPEG staging, content refusal and cancellation without page errors or
overflow. A real held PermissionRequest returns HTTP 200 with `behavior: deny`
while image completion is in flight; the observed UI answer resolves 225 ms before
the staged result. The full review and one fix review completed. Retired preparation
stops permanently, optional browser APIs have compatible fallbacks, and upload
eligibility honors protocol compatibility and current mutual authentication.
A matching identity prop effect preserves a proof completed after synchronous
identity provision; a different identity disables upload. The isolated real-browser
regression passes eight assertions on each Bun, and restoring the old effect fails
its post-effect enabled assertion. Native/Swift and physical-device acceptance,
relay transport and harness insertion remain separate. Hosted checks precede landing.


## Explicit direct Claude draft caller

The existing web upload panel now offers **Add to draft** after successful staging when the original signed direct connection advertises `image_insertion`.
The host writes one generated retained reference without Enter.
The panel shows the unchanged **Send before** deadline and session-end limit.
The existing Send action submits separately, including an image-only turn; its input receipt remains distinct from the image insertion result.
A transport ACK confirms receipt, never submission; a later correlated input refusal remains visible, and the existing message retry keeps its original input ID.
A possible reference retains the original deadline and blocks replacement. Clearing its status requires a separately explained explicit choice and never removes text from the terminal draft.

A delayed insertion response shows uncertainty; the person can explicitly check status with the exact original insertion request.
No timer, reconnect or new request ID automatically reinserts the image.
Known session close and local expiry remove the Send affordance; an expired unsent reference must be removed manually before a fresh upload.
The client retains bounded metadata, not the File bytes, and uses a single deadline timer rather than polling.

Production App controls cover PNG/JPEG at 390×844, 1024×768 and 1440×1000, plus an actual paused-source-daemon retry.
Compiled host controls cover Apple Silicon Mac and Linux ARM64/x64 on Bun1.3.11/1.4.2; the inert CLI consumes no additional model turn.
These controls do not establish native conformance, phone battery use, deployed relay attachments or a new 24-hour hardware soak.
Keep #1170 open for those scopes and the link/download follow-ups.

## Encrypted relay browser-link delivery (2026-10-15)

The relay path now routes a selected child's Claude BROWSER candidates to one
explicitly selected web receiver over the existing authenticated encrypted
machine channel. Receiver selection is exclusive; replacing the receiver ends
the prior lease. The client retains bounded candidates briefly and opens a
chosen HTTP(S) destination only after a separate user action. The Worker
forwards opaque channel frames; it does not receive the URL as parsed content.

Local source acceptance constructs the source Worker under Miniflare, HubRelay,
the child proxy, the actual BROWSER producer and the web app. Rendered browser
checks cover 390×844, 768×1024 and 1440×900, including natural lease expiry.
These results do not establish deployed Cloudflare behavior, signed native
clients, physical-device UI, Codex link production or installed-host browser
opening. Keep #1170 open for those remaining scopes.
