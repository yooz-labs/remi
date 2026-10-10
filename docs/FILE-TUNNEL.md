# Image and file tunnel: threat model and freeze plan

Design proposal for [#1170](https://github.com/yooz-labs/remi/issues/1170), started 2026-10-08; candidate contract updated 2026-10-09.
This document specifies work to review before implementation; it adds no messages, capabilities, endpoints or native attachment controls.
It is not an accepted protocol freeze or an implemented feature.
The owner included the tunnel's frames in the protocol freeze (#1233, comment on #1170); native attachment and preview UI remains X5 (#1245).
The first runnable unit is direct image staging; harness insertion has its own later gates.
This separate follow-up does not establish or block relay backend release acceptance.

## Current code and reuse

Current source check: develop `ef84b4c6`, after [#1284/#1332](https://github.com/yooz-labs/remi/pull/1332) retained recent repositories for native session creation.
Its merge tree equals tested source `28ea5daf`; both full Bun suites and the actual 61-minute relay gate passed.
Develop's successor `23df4739` changes only version strings to `0.7.17-dev.42` and is included in this documentation branch.
The relay backend previously landed through [#1331](https://github.com/yooz-labs/remi/pull/1331) at `b1168126`, whose tree equals tested backend `2858e4bd`; `1d478e07` changes only the development version.
The initial checks against develop `1d800273`, relay epic `8fb5b88b` and source composite `1e96c688` remain historical provenance.
No upload, file-fetch or forwarded-browser implementation was found in the daemon, shared protocol or web client.
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
This requires a tunnel-specific current-grant-incarnation check: today's authenticated connections survive key removal (#1305), so connection authentication alone cannot establish revocation.
Removing and granting the same key again must not revive an earlier transfer; an epoch mismatch or an unavailable authority store permanently invalidates that transfer.

A malicious relay may inspect metadata, delay, truncate or replay transport frames.
Relay encryption does not stop a legitimately authenticated client from requesting files or exhaustively uploading data; filesystem policy and budgets are separate checks.
Direct WebSockets provide authentication without encryption by remi (ADR 0009); use a trusted network, VPN or SSH tunnel for sensitive transfers.

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

Claude's first proposed delivery is an `@path` reference without Enter.
Its exact quoting, spaces, special characters and behavior on the installed CLI require a local probe before accepting this operation.
The shared prompt signal cannot detect every possible dialog; record what those controls demonstrate, without claiming complete screen safety.
Codex insertion remains unavailable until the owner resolves #1207 and an app-server attachment operation is independently verified against the installed version.
An upload must not start a Codex turn, change a thread or use `-i` on a resumed TUI implicitly.

Abandoned and failed partial files are removed when the transfer ends.
Uninserted completed files expire after 24 hours or session exit, whichever comes first.
Before insertion ships, the implementation must establish when each harness no longer needs its image reference, including a later resume.
If it cannot establish that lifetime, insertion does not ship under this deletion policy; it must not silently retain files forever instead.
Crash recovery scans only its own private scratch namespace, with descriptor-based traversal; it never walks the project or follows links.
Deletion is limited to owned transfer artifacts, with failures counted visibly and their reserved disk budget retained until cleanup succeeds.

## Egress lifecycle and credential denial

Egress comes after ingress and the portable filesystem spike.
An explicit client request selects one relative file in the session's project directory; there is no directory listing, glob, recursive download or arbitrary absolute-path endpoint.
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

These are reviewable initial limits, not settings or protocol constants already implemented.

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

All names and fields below are proposals for review, not additions to the protocol registry.
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
| Claude reference insertion | `image_insert_request`: common request envelope, `sessionId`, expected `binding`, `artifactId`; `image_insert_result`: common correlated response, `outcome` exactly `inserted`, `refused` or `uncertain`, and `code` exactly `none` on insertion; `unavailable`, `busy`, `conflict`, `expired`, `binding_changed` or `prompt_up` on refusal; `delivery_unknown` on uncertainty. `inserted` means one confirmed reference write without Enter, never proof the harness read the image. | No automatic insertion after staging. Check authority/binding/prompt at the actual serialized PTY effect. Only refusal before any possible write permits a new explicit attempt; each artifact permits at most one possible insertion. Cache/return recorded results without another write, including a retried request ID; changing the ID cannot evade retirement. Retain retirement while the artifact is usable; do not replay or auto-retry. Installed-Claude and lifetime gates remain unresolved. |
| File fetch | Candidate `file_fetch_begin/accepted`, `file_fetch_chunk/ack`, `file_fetch_complete/result`, `file_fetch_cancel/result`; begin selects one permitted project-relative path. Prepare a reserved private copy before any content frame. Completion describes its length and SHA-256; never claim an atomic source snapshot. | Names stay in freeze scope, not advertised. Exact fetch fields/ack/cancellation rules await descriptor confinement, denial-policy and private-copy spike evidence; no placeholder implementation. |
| Link forwarding | Candidate `link_candidate` and a client-local explicit open choice; candidate carries a bounded validated URL, never a host-fetch instruction. | Unavailable until the per-session shim, URL bounds, selected-client routing and actual launch boundary are specified and proven. |
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
| Agent attachment insertion | Separate from staged upload; Claude unavailable until its effect/lifetime gates, Codex unavailable until #1207 and structured-operation proof. |
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

| Next PR | Existing code and proposed files | Prerequisite and exit gate |
|---|---|---|
| T0a: storage packaging proof | Reuse restricted storage conventions; proposed `packages/daemon/src/tunnel/storage.ts` and owned filesystem controls under `packages/daemon/tests/tunnel/`. Choose a helper only after comparing compiled distribution support. | Execute all three supported targets on both Bun gates; complete the race, non-regular-file and credential-overlap corpus. Record unsupported targets explicitly. No advertised capability. |
| T0b: decoder packaging proof | Compare explicitly declared PNG/JPEG decoder candidates and license/runtime assets; proposed `tunnel/image-validation.ts` and decoder corpus. Do not import Miniflare's development dependency as an implicit runtime dependency. | Standalone compiled execution on all targets, full decode with admission before excessive allocation, finite CPU/memory/deadline/concurrency limits and cancellation. A real held approval stays responsive. No chosen dependency before evidence. |
| T0c: accept the staging contract | Reuse ADR 0035, protocol registry and fixture rules. Add the reviewed ADR, strict validators and golden positive/refusal fixtures under `packages/shared/`; coordinate Swift conformance in the existing native track. | T0a/T0b settle implementation feasibility. Owner reviews the concrete fields, bounds, outcomes and cleanup policy; an independent review finds no unresolved critical decision. Fixtures alone do not advertise support. |
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
| T2: explicit link forwarding | Session-scoped shim and user-triggered client launch. | Actual process environment/shim/client trace; no host fetch, automatic launch or credential inheritance. |
| T3: read-only file egress | Portable descriptor confinement, denial policy, snapshot semantics and inert client handling. | macOS/Linux path-race corpus, credential overlap controls, quotas and revoked-device controls. No egress on an unsupported filesystem API. |
| T4: relay transport and native depth | Reuse accepted v2 transport and implement X5 UI for capabilities already present. | Real Durable Object, hub and client; no content on Worker logs, HTTP answer routes or push; owner signs and exercises physical-device UI. |

Each phase is one independently reviewable PR or is split further when its implementation exceeds that scope.
Pin existing chat/approval behavior before modifying it; mutation-check each new security control by demonstrating that removing the guard fails its named scenario.
A passing parser or build does not establish filesystem confinement, harness delivery, relay privacy or physical-device acceptance.

## Decisions still required before implementation

- Prove the macOS/Linux descriptor API available to Bun, and choose any required platform helper explicitly; do not substitute a racy `realpath` check.
- Prove the descriptor checks for validated private-copy fetch semantics; do not describe them as atomic source snapshots or complete concurrent-edit detection.
- Choose a bounded decoder only after CPU/memory/concurrency and compiled-target evidence; dimensions and a transitive development dependency are insufficient.
- Verify installed Claude reference insertion and establish image-reference lifetime before enabling automatic deletion.
- Resolve Codex attachment delivery with #1207; observing a CLI flag is insufficient to authorize starting a turn.
- Review the proposed type allowlist, bounds, cleanup lifetime and credential deny corpus before freezing them.

This preparation uses one lead and one independent security reviewer.
Implementation reviews and owner hardware/signing are separate future gates.
