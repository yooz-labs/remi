# Image and file tunnel: threat model and freeze plan

Design proposal for [#1170](https://github.com/yooz-labs/remi/issues/1170), dated 2026-10-08.
This document specifies work to review before implementation; it adds no messages, capabilities, endpoints or native attachment controls.
The owner included the tunnel's frames in the protocol freeze (#1233, comment on #1170); native attachment and preview UI remains X5 (#1245).

## Current code and reuse

Checked against `origin/develop` at `1d800273` and the existing relay epic at `8fb5b88b`.
No upload, file-fetch or forwarded-browser implementation was found in the daemon, shared protocol or web client.

| Existing implementation | Reuse and constraint |
|---|---|
| [`protocol.ts`](../packages/shared/src/protocol.ts), [`protocol-version.ts`](../packages/shared/src/protocol-version.ts), ADR 0035 | Additive messages need typed validation, golden fixtures and an advertised capability. Older clients and hubs keep their present behavior. |
| [`input-events.ts`](../packages/daemon/src/cli/handlers/input-events.ts), [`prompt-up.ts`](../packages/daemon/src/cli/handlers/prompt-up.ts) | `promptUpDeps` combines held, terminal and observed menu states. Attachment insertion must use the same signal at the actual queued write. A `user_input` currently appends Enter; an attachment reference must not use that operation. |
| [`harness/types.ts`](../packages/daemon/src/harness/types.ts), ADRs 0032 and 0033 | Keep upload storage neutral and put harness delivery behind the seam. Codex sets `acceptsTypedChat = false`; it has no shipped attachment-delivery operation. Do not send a file reference as raw Codex keystrokes. |
| [`pty/child-env.ts`](../packages/daemon/src/pty/child-env.ts) | Preserve removal of remi's secret environment variables when installing a browser shim. This does not isolate processes running as the daemon's user. |
| [`storage/interprocess-file-lock.ts`](../packages/daemon/src/storage/interprocess-file-lock.ts) | Serialize a durable per-home transfer reservation ledger across hubs, child daemons and manually started wrappers. In-memory per-process counters cannot enforce a per-home budget. |
| Relay epic: `shared/src/relay/channel.ts`, `constants.ts`, `remote/hub-relay.ts`, `remote/child-proxy.ts`, ADR 0034 | Reuse the authenticated, counter-checked channel and session routing. Its maximum plaintext is 524,288 bytes, its frame overhead is 25 bytes, and its pending-send bound is 64. These are channel limits, not a transfer budget. Relay v2 is absent from the cited develop head and remains opt-in. |
| Relay epic: `auth/identity-store.ts`, `notifications/secure-push-store.ts` | `withAuthorizationEpoch` and the captured/current authority pattern distinguish a removed and replaced grant. Reuse the grant-incarnation helper when it is integrated; do not activate secure push or require relay enrollment for a direct tunnel. Develop's `isAuthorized` checks current membership only. |

Issue #1170's older plaintext-relay description predates the rebuild.
The shipping develop path has the relay off by default and fail-closed without authentication; the epic implements v2 separately.
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

First support PNG and JPEG images only; generic file ingress follows a separate allowlist review.
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
Completed files expire after 24 hours or session exit, whichever comes first; the implementation must first establish when each harness no longer needs its image reference.
If it cannot establish that lifetime, insertion does not ship under this deletion policy.
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
Read at most the admitted byte count plus one from that same descriptor; refuse growth, truncation or detected mutation.
A file being rewritten cannot be promised as an atomic snapshot merely because a hash was computed.
The implementation must choose and prove snapshot semantics before freezing the fetch completion contract; until then, concurrently modified files refuse.
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

Base64 of a 32 KiB chunk occupies 43,692 bytes, leaving room inside the proposed 64 KiB transfer frame and the epic's 524,288-byte channel plaintext limit.
Enforce both transfer and transport limits; changing the file budget must never relax channel limits.
Count all a device's connections together and reserve hub capacity before the child starts writing.
The per-home ledger atomically reserves the declared byte budget, minimum allocation cost and one artifact slot before file creation, across every hub and session process using that remi home.
Keep reservations for completed artifacts and failed deletions; reconcile crash leftovers without admitting new work from an unreadable or inconsistent ledger.

## Protocol freeze deliverables

The following is candidate vocabulary for the protocol ADR, not permission to invent or advertise a wire field now.

1. Define separate additive capabilities for staged image ingress, link forwarding and file egress. Advertise each only with a shipping handler and production client caller; a missing capability disables the operation through `hubSupport`.
2. Specify begin/accepted, chunk/ack, complete/result and cancel/result for uploads and fetches. Include request correlation, host-issued transfer ID, session identity, direction, sequence, total bytes, content kind and final digest. Every field, encoding, bound, expiry, refusal and idempotency rule must be in the ADR before models are added.
3. Distinguish staged, inserted, refused and uncertain outcomes. Existing transport acks acknowledge receipt; they must not be reused as proof of a completed disk write or harness insertion.
4. Bind all state to device, authorization grant incarnation, runtime and harness epochs on the child. The hub routes authenticated transfers without gaining an unrestricted file-service path; revoke/regrant, a resumed session or a restarted child cannot revive an earlier transfer.
5. Add golden success and refusal fixtures decoded by both TypeScript and Swift (#1238), with strict numeric/base64/text bounds, duplicate-field handling and explicit unknown-capability behavior. Add counters, digest and boundary vectors for transfer chunks.
6. Use the existing authenticated direct connection initially. Relay transfer support waits for the accepted v2 epic and real Worker/hub/client ciphertext-only controls; it adds no plaintext fallback or Worker file-storage endpoint.
7. Keep native picker, share sheet, previews and attachment controls in X5 (#1245), after the relevant capability and conformance gates pass.

## Implementation order and gates

| Phase | Work | Gate before advancing |
|---|---|---|
| T0: threat model and freeze | Review this proposal; settle filesystem portability, snapshots, image lifetime, bounds and insertion semantics. Write the protocol ADR and fixtures. | No unresolved security-critical decision and a source trace for every reuse claim. |
| T1: direct image staging and Claude insertion | Neutral private scratch storage, authenticated chunk lifecycle, exact-effect Claude guard and one real client caller. | Real source hub/child + installed Claude controls: no Enter, zero prompt input on refusal, correct insertion once, quotas and cleanup. |
| T2: explicit link forwarding | Session-scoped shim and user-triggered client launch. | Actual process environment/shim/client trace; no host fetch, automatic launch or credential inheritance. |
| T3: read-only file egress | Portable descriptor confinement, denial policy, snapshot semantics and inert client handling. | macOS/Linux path-race corpus, credential overlap controls, quotas and revoked-device controls. No egress on an unsupported filesystem API. |
| T4: relay transport and native depth | Reuse accepted v2 transport and implement X5 UI for capabilities already present. | Real Durable Object, hub and client; no content on Worker logs, HTTP answer routes or push; owner signs and exercises physical-device UI. |

Each phase is one independently reviewable PR or is split further when its implementation exceeds that scope.
Pin existing chat/approval behavior before modifying it; mutation-check each new security control by demonstrating that removing the guard fails its named scenario.
A passing parser or build does not establish filesystem confinement, harness delivery, relay privacy or physical-device acceptance.

## Decisions still required before implementation

- Prove the macOS/Linux descriptor API available to Bun, and choose any required platform helper explicitly; do not substitute a racy `realpath` check.
- Define enforceable snapshot behavior for a file concurrently modified by an agent.
- Verify installed Claude reference insertion and establish image-reference lifetime before enabling automatic deletion.
- Resolve Codex attachment delivery with #1207; observing a CLI flag is insufficient to authorize starting a turn.
- Review the proposed type allowlist, bounds, cleanup lifetime and credential deny corpus before freezing them.

This preparation uses one lead and one independent security reviewer.
Implementation reviews and owner hardware/signing are separate future gates.
