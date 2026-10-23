# Plan: backend session capabilities (#1595)

Status: execution approved, terminal first, 2026-10-22; screen qualification remains a gate.
Source baseline: `origin/develop` at `0c6d573bea71b1627e6e5c8dd3d3c1ec838b88f2`.

The media/profile product plan was already approved in [#1313](https://github.com/yooz-labs/remi/issues/1313#issuecomment-6304800880).
This continuation preserves that approval.
The owner selected a **read-only view of the existing agent terminal** in this session.
The owner approved the proposed terminal architecture/limits and chose terminal first, then the existing media/profile uses.
Exact runtime fields remain subject to screen qualification and the accepted ADR; this document registers no wire types or capabilities.
The [initial B1 report](../docs/terminal-screen-characterization.md) preserves the failed original resource gate.
The [bounded-model continuation](../docs/terminal-screen-bounded-model.md) qualifies the approved 1 MiB primitive on all six supported compiled executions under [ADR0046](decisions/0046-bounded-read-only-terminal-screen.md) (#1608).
Strict wire and shared quotas landed in #1616/#1618; [launch capture](../docs/terminal-capture.md) is B3b (#1620), followed by the secure service and real caller.

## Context

The iPhone drawer epic #1588 left navigation and composer seams for #1595.
The issue says file/image/terminal messages do not exist, but that is too broad for current source.
The missing work combines native adoption of existing contracts with genuinely new backend operations.
Profiles belong to [#1157](https://github.com/yooz-labs/remi/issues/1157), and are part of this continuation rather than a new account-management feature.

| Operation | Verified current source | Remaining work |
|---|---|---|
| Upload PNG/JPEG to Claude | Strict `image_upload_*`, storage/decoder, authenticated direct service and web caller | Native conformance/caller; encrypted relay ingress; Codex support |
| Add a staged image to Claude's draft | `image_insert_request/result`, guarded serialized no-Enter effect, explicit web Add and separate Send | Native caller; independently designed relay/Codex delivery |
| Download one explicit project file | Strict `file_fetch_*`, descriptor admission, managed private copy, WSS direct and encrypted relay callers for Claude/Codex | Native transport/controller, preview and Save; no directory browser |
| Terminal | Direct `raw_pty_output` and `terminal_resize` already exist | Explicit bounded read-only screen contract; relay currently refuses raw PTY |
| Login/settings profiles | Codex socket resolver accepts supplied `CODEX_HOME`; PTY strips Remi secrets | Profile config/resolution, complete environment selection, persistence, context propagation and remote selection |

These are source observations, not deployed Worker, installed release or signed-device acceptance.
No current personal session or account was used for a transfer or model turn.
Read-only installed CLI help reported Claude Code 2.1.308 and Codex 0.163.0; older account-isolation observations in #1157 need fresh controls.

## What already exists to reuse (do not rebuild)

- [ADR0035](decisions/0035-protocol-version-and-capabilities.md), [`protocol-version.ts`](../packages/shared/src/protocol-version.ts), and the registry/direction tables in [`protocol.ts`](../packages/shared/src/protocol.ts): additive version-1 features, connection-specific capability checks and golden fixtures.
- [ADR0041](decisions/0041-direct-image-staging.md), [ADR0042](decisions/0042-claude-image-insertion.md), [`image-staging.ts`](../packages/shared/src/image-staging.ts), and [`image-insertion.ts`](../packages/shared/src/image-insertion.ts): existing image fields, strict parsing, staging and insertion semantics.
- [ADR0045](decisions/0045-direct-file-download.md), [`file-download.ts`](../packages/shared/src/file-download.ts), and [`file-download-session-host.ts`](../packages/daemon/src/tunnel/file-download-session-host.ts): explicit-path file reads and protection roots.
- [`cli.ts`](../packages/daemon/src/cli.ts): actual construction, session lifetime, strict dispatch and per-connection capability selection for the image/download services.
- [`hub-relay.ts`](../packages/daemon/src/remote/hub-relay.ts) and [`child-proxy.ts`](../packages/daemon/src/remote/child-proxy.ts): encrypted downloads and original device/grant/enrollment/child authority. Their raw-PTY refusals remain intact.
- [`App.tsx`](../packages/web/src/App.tsx): production upload, Add to draft, separate Send, download and explicit Save callers.
- [`pty-session-setup.ts`](../packages/daemon/src/cli/session-phases/pty-session-setup.ts) and [`pty-message-fanout.ts`](../packages/daemon/src/cli/handlers/pty-message-fanout.ts): real PTY output source, shared by wrapper and daemon sessions.
- [`child-env.ts`](../packages/daemon/src/pty/child-env.ts), [`arg-parser.ts`](../packages/daemon/src/cli/arg-parser.ts), [`session-store.ts`](../packages/daemon/src/session/session-store.ts), and [`codex-socket.ts`](../packages/daemon/src/harness/codex/codex-socket.ts): profile integration seams.
- Native [`MachineEndpoint`](../packages/native/RemiKit/Sources/RemiKit/Store/MachineStore.swift) and [`RemiConnection`](../packages/native/RemiKit/Sources/RemiKit/Transport/RemiConnection.swift): direct endpoints currently construct WS URLs; no native image/download caller was found. `PhoneSessionPane` currently contains only `chat`.

Five load-bearing facts were rechecked directly: the CLI constructs the image services; the CLI constructs and dispatches the download host; the web App calls them; both relay boundaries refuse raw PTY; profile resolution/storage fields are absent despite the Codex-home seam.
The existing ANSI parser explicitly says it is not a terminal screen emulator (`parser/ansi.ts`); accumulated transcript text cannot substitute for an accurate terminal viewport.

## Approach

Keep existing accepted image/download fields and budgets.
Build native adoption against their shared vectors; add backend contracts only for missing behavior.
Treat a terminal as a read-only viewport and a profile as one immutable account/settings selection captured at session creation.
This follows the existing authority and lifecycle services and avoids a second transfer implementation or a general remote shell.

Keep three work streams, with explicit dependencies:

1. File/image integration under #1170/#1313, including native secure endpoints and on-demand previews.
2. The terminal proposal and implementation under #1595/#1245.
3. Profile core/context propagation and then remote choice under #1157.

Backend contracts can be prepared while existing route acceptance continues.
New client effects must wait for machine-qualified routing (#1601), bounded large-message behavior (#1598), the existing route locks and each operation's transport requirements.
Do not mark #1571 complete to advance this work; its remaining acceptance stays separate.

## Existing transfer contracts and privacy limits

| Contract | Preserve |
|---|---|
| `image_staging` | Claude-only binding today; PNG/JPEG; 1 byte to 10 MiB; 32 KiB decoded chunks; 64 KiB raw frames; one chunk awaiting acknowledgment |
| Image validation | Full format validation; at most 8,192 pixels per side and 32 million pixels; bounded disposable decoding |
| Upload lifecycle | 30-second idle / five-minute total partial lifetime; staged image at most 24 hours from first completion, ending earlier on session exit |
| `image_insertion` | Separate explicit Add to draft; original signed direct connection; original expiry; no Enter; one possible effect; uncertain delivery is never replayed |
| `file_download` | One nonempty regular file up to 10 MiB; 32 KiB pull chunks / 64 KiB raw frames; five-minute total lifetime including preparation; 30-second post-acceptance idle limit |
| Shared scratch budget | 100 MiB per Remi home; 128 artifacts per home / 32 per device; at least 4 KiB charged per artifact; two active operations per device / four per session / eight per hub; cleanup debt stays charged |
| Download privacy | WSS with normal certificate/hostname validation or the enrolled encrypted relay; a signed WS/Tailscale connection alone does not satisfy ADR0045 |

Use exact length/digest verification and current device, grant incarnation, connection attachment, child runtime and harness binding checks at the actual effect.
Revoke/regrant, route/context loss and session replacement cannot revive old authority.
Do not put bytes, file paths, filenames, digests, terminal text or account details in notifications or diagnostic logs.
Do not fetch bytes when merely listing chat references.

Native previews extend ADR0045's explicit Save behavior only after verified bytes and the owner's explicit Preview action.
Initially allow PNG/JPEG/PDF previews, one retrieval at a time, and a private cache bounded by four files and 32 MiB.
No background prefetch or eager PDF-page rasterization; purge on session/profile change, Forget or authority loss.
Preview renders inert local content with external-resource/network loading disabled; document scripts, actions and embedded links cannot execute automatically.
Qualification includes active-content and bidirectional-text fixtures plus actual network observation, following `docs/FILE-TUNNEL.md`.
Save/export is a separate user action.
Owner-confirmed cache cleanup: evict the oldest cached preview when capacity is needed, using the existing bounded LRU policy.
This removes only app-owned temporary preview copies, never an explicit Save/export, the host's source file, or a staged image still owned by its draft lifetime.
Other files remain inert downloads; generic file/PDF upload and directory listing need separate contracts and are not inferred from `file_download`.

Codex images and relay image ingress cannot be enabled by broadening an existing capability's meaning silently.
Their contract phase must specify an additive gate and exact new shapes against installed APIs, preserving the existing strict Claude vectors and no-Enter semantics.
Legacy `user_input` stays text-only; it is not an attachment escape hatch.

## Proposed read-only terminal contract

Candidate capability: `terminal_view`, selected for the actual eligible attached session/connection.
The first viewport shows the existing agent PTY's current screen; it launches no process and accepts no terminal input or resize operation.
It is not a transcript, a shell, a historical recording or a way to answer a terminal-only card.

Use WSS direct or the enrolled encrypted relay for this new surface.
The viewport can contain secrets that the agent or a tool printed; no general secret redaction is claimed.
Opening the pane is an explicit request for that session's terminal contents.
Keep the existing raw-PTY rejection at the registry, hub and child boundaries. The web relay also rejects inbound `terminal_resize`; that client check is not a claim that the generic legacy hub/child router forbids every crafted resize request. The new terminal-view route exposes no input or resize operation.
The new route carries validated screen data only, through an explicitly accepted extension of the semantic child protocol.
It does not add a Worker route or change relay cryptography, version or enrollment.

Candidate messages, using the existing strict envelope (`type`, UUIDv4 `id`, UTC `timestamp`, actual `sessionId`; responses also echo `requestId`):

| Direction/type | Proposed additional fields | Meaning |
|---|---|---|
| Client `session_terminal_open` | `binding` | Explicitly request a view of this attached live session |
| Host `session_terminal_opened` | `viewId`, `expiresAt` | A bounded view lease was admitted; not terminal input authority |
| Client `session_terminal_read` | `viewId`, `afterRevision` (null or a safe nonnegative integer) | Pull the latest complete viewport; one read outstanding |
| Host `session_terminal_snapshot` | `viewId`, `revision`, `columns`, `rows`, `lines`, `cursor` | Complete replacement screen, not an append-only byte delta |
| Host `session_terminal_unchanged` | `viewId`, `revision` | No newer complete viewport exists |
| Client `session_terminal_close` | `viewId` | Retire this connection's view |
| Host `session_terminal_closed` | `viewId` | View retired; repeated close is idempotent while its bounded receipt exists |
| Host `session_terminal_refused` | `operation`, `code` | Correlated short refusal without terminal text or host paths |

`binding` is the existing exact Claude/Codex harness identity shape.
`viewId` is a collision-checked host-generated 16-byte opaque identifier, canonical base64url.
`cursor` is either null or `{row, column}` with zero-based coordinates inside the advertised geometry.
`lines` has exactly `rows` scalar strings, with control/escape sequences removed by the screen model; styles, links, clipboard commands and terminal replies are not executable data.
Rendering width, combining characters, wide glyphs, redraws and alternate screens are qualification gates, not assumed properties of string length.
Escape misleading display controls without feeding anything back to the PTY.

Proposed bounds:

- At most 240 columns and 60 rows; 32 KiB aggregate UTF-8 line text and 64 KiB encoded raw JSON per frame. An unsupported geometry/content model makes this view unavailable; never silently truncate a current screen or raise the connection limit.
- At most two reads per second, one outstanding per view. Coalesce screen updates; a slow viewer receives the latest complete snapshot, not an unbounded output queue. Frames for stale view IDs are discarded.
- One active view per connection, two per device, four per session, eight per Remi home. Shared metadata leases count child processes together and release only owned reservations.
- Owner-approved revised budget: at most 1 MiB screen-model state per eligible session and 32 such models per home (32 MiB). The original 256 KiB failure stays recorded in #1609. No terminal contents on disk, in replay history, push or logs. Qualification includes parser and pending-send allocations, not just visible text length; it is not an OS/process memory ceiling.
- A view expires after five monotonic minutes. A new explicit Open may create a new lease. Session exit, disconnect/detach, profile change, lost child ownership or changed grant/binding retires it at the next bounded authority check and before any further send.

Refusal codes proposed: `malformed`, `unavailable`, `busy`, `expired`, `binding_changed`, `unsupported_screen`.
Unknown/foreign IDs, revoked or unreadable authority and inaccessible sessions use `unavailable`.
Specific lifecycle outcomes require the currently authorized owning view.
Use the existing duplicate-member/Unicode/canonical-value defenses before generic dispatch.

Start observing screen state at session launch, under the bounded model reservation, so late viewers do not receive an arbitrary ANSI tail as a fake current screen.
Sessions predating capture, parser desynchronization or unsupported terminal controls get a truthful unavailable result until a proven screen reset establishes state.
Failure or overload disables the view; it must never slow or change local terminal output or approvals.
The read-only transport has no path to `PTYSession.write`, `insertText`, `submitInput` or `resize`.

The first terminal PR must characterize and select a screen implementation before accepting/finalizing these shapes.
Reuse an existing suitable implementation only after checking licensing, supported compiled targets and bounded allocations; no new dependency is selected here.
If the characterization cannot reproduce the real viewport safely, keep the pane unavailable and record the failed gate rather than relabeling transcript output as a terminal.

## Profile contract and wrapper settings (#1157)

One session selects one persistent named profile at launch and retains it on reconnect/resume.
The persistent profile owns stable CLI configuration/login locations; each session gets its own environment and temporary directory.
The built-in `default` leaves existing login selection intact.
Keep the user's `HOME`; select CLI stores with their qualified tool-specific mechanisms instead of creating a new home per session.
This is environment/account-context separation within one OS user, not an OS sandbox.

Local config owns IDs, labels, Claude/Codex directory selectors, safe harness arguments, project-folder mappings and explicit tool environment selectors.
No profile is automatically sourced from repository environment files.
Explicit profiles remove conflicting inherited provider credentials/selectors before applying their configured selectors; Remi's own secret scrub remains the final launch defense.
Use a complete child environment: the present `PTYSession.start()` merges `process.env` again, so deleting values only from an override object would not isolate a profile.
Codex commands also run in the shared app-server; prove the selected server/environment rather than isolating only its TUI.

Proposed selector precedence: `--remi-profile <id>` > `REMI_PROFILE` > longest canonical project-folder match at a path-component boundary > configured default > built-in `default`.
Prefer `--remi-profile` over the older `--profile` proposal to preserve current argument interpretation.
Codex's provider `--profile` is currently deliberately refused by `harness/codex/codex-args.ts`, because it can select a different app-server; that refusal stays intact.
Pin both existing forwarding and deliberate refusals before changing the parser.
For hub creation, resolve against the validated effective project/worktree directory before creating a worktree, reserving a port or starting a child.

Capture profile ID and a private immutable selection snapshot, including stable selector paths/revision, in the session's local state.
Changing a profile definition cannot silently switch a live or resumed session's account.
A deleted, incompatible or unavailable saved selection refuses resume with a safe setup message.
Historic records without profile metadata use the legacy/default path; mixed older writers must be detected so they cannot erase profile metadata and silently resume under default.
Do not claim a session uses an explicit profile until launch, resume, hooks, transcript/history, probes, statusline and Codex socket/app-server selection all follow that same snapshot.
Protect all configured profile-private roots from file admission, including adopted directories outside Remi home and inactive profiles, using ADR0045's required/previously-seen root policy.
An unsafe or changed required root makes the affected file operation unavailable.

Candidate capability: `session_profiles`, advertised by hubs only with the working resolver, validation, child propagation and one production caller.
Candidate `session_profiles_request/response` returns only bounded `{id,label,harnesses}` choices plus the resolved default for an optional validated project directory.
Only operator-configured remotely selectable IDs are listed/accepted; `default` retains legacy remote creation behavior.
Proposed limits: 32 configured profiles; IDs `[a-z0-9][a-z0-9-]{0,31}`; labels 1-64 safe Unicode scalar code points; strict request/response frame limit 64 KiB.
No account email, provider tokens, local paths, environment values or arbitrary configuration is sent.

Add optional `create_session_request.profile` and optional session/creation-result `profile: {id,label}` only behind this capability, with exact field placement settled in its ADR/goldens.
Unknown, malformed or locally disallowed IDs refuse before side effects.
An older daemon must never silently ignore an explicit profile request: clients check the capability before sending it.
An explicit resume under a conflicting profile is refused; it never falls back to another signed-in account.
The session badge describes the selected profile, not verified subscription identity or usage.
Authentication status remains a bounded local CLI probe; unknown status stays unknown.

Local commands may list/show profiles and invoke the provider's normal login in the user's terminal with that stable environment.
Remi does not read, copy, transport or display token contents, and does not implement phone-side login.
Safe per-session Remi settings start with the existing prompt hold durations.
Listener/TLS, device grants, relay enrollment, push secrets and machine-wide policy remain hub settings.
Tool-specific cache/config selectors require their own two-profile control before they are described as isolated.
Account/subscription usage reporting remains later work, distinct from session token metrics.

## Files and delivery sequence

Each implementation item is an independently reviewable PR into `develop`, normally one subsystem and about 500 net implementation lines or less.
Update this phase list before splitting an item; do not silently expand one PR.

Backend preparation comes first. Numbering orders work within each track; it does not put native UI ahead of missing backend contracts.
The bounded B1 primitive and ADR0046 are qualified. B2's strict wire/fixtures are specified in ADR0047 (#1612), with explicit relay refusal until B4. Both PRs retain their source/hosted gates; the next runtime checkpoint is B3's host lifecycle/direct route.

| Track/step | Deliverable | Main files and pass gate |
|---|---|---|
| 0 | Correct backend inventory and contract plan | This file and `.context/plan.md`; reconcile #1595 with accepted ADR0041/42/45 and the prior approved #1313/#1157 plan |
| B1 | Terminal screen characterization and accepted ADR | Existing PTY output observer plus owned qualification harness; supported host/compiled packaging, accurate bounded screen snapshots and an accepted new ADR before runtime adoption |
| B2 | Terminal strict wire | New `shared/src/terminal-view.ts`, registry/directions/capability documentation and shared positive/refusal goldens; no advertised capability yet |
| B3a | Shared model/view reservations (#1617) | New `daemon/src/terminal/reservations.ts`; bounded private metadata, real concurrent child processes, approved model/view limits and exact owned release; standalone until host adoption |
| B3b | Launch-time terminal capture (#1620) | Existing raw PTY output plus local geometry/lifetime observation, before harness start; reserve before model construction, bounded disposal/release and held-answer qualification; no transport or capability |
| B3c | Signed direct terminal service | New `daemon/src/terminal/` authority/lease service and small `cli.ts` composition; real signed WSS client, original grant/attachment/binding/runtime checks, rate/send reservations and no input/resize effects |
| B4 | Terminal encrypted relay route and first caller | Existing hub/child authority seams plus one real web or native read-only caller; only then advertise on the measured route; native controls/rendered QA are separate |
| M1 | Codex image qualification/contract | Existing `harness/codex/`, `harness/types.ts`, shared contract/fixtures; installed API evidence before choosing an image input route; text-chat behavior preserved |
| M2 | Encrypted relay image qualification/contract | Existing `remote/hub-relay.ts`, `child-proxy.ts`, image authority/service; original actor/child owner and one-effect rules; no broad raw-frame forwarding |
| P1 | Profile launch characterization | Existing parser, PTY environment, Claude paths, Codex socket/app-server and owned CLI probes; pin default/forwarded flags and prove two independent noncredential contexts |
| P2 | Profile config/resolver/environment | New `daemon/src/profiles/{config,resolve,environment}.ts`, existing config/parser; bounded validation, deterministic selection and complete environment with Remi secret scrub |
| P3 | Profile persistence and context propagation | Session store/binding/live registry, create/resume, harness/hook/transcript/statusline/probe paths, file protection roots; reject old-writer metadata loss and cross-profile resume |
| P4 | Profile remote contract/caller | New shared profile codec/ADR/goldens, `create-session-events.ts`, actual hub child propagation, one production picker and session badge; capability only with end-to-end selection |
| N1 | Native request targeting prerequisite | Existing #1601: machine-qualified Store/transport/controller identity; equal session IDs on two real hub fixtures must stay independent |
| N2 | Secure native endpoint adoption | `MachineStore.swift`, endpoint/profile persistence, `RemiConnection.swift`, `AddMachineDraft.swift`; explicit WSS with standard validation, no downgrade, no route-lock changes; #1598 bounded-message decision included before native transfer qualification |
| N3 | Native download wire/controller | New `RemiKit/Protocol/FileDownload.swift` and `Store/FileDownloadController.swift`, existing wire dispatch/Store; exact existing shared vectors and real direct/relay host caller; explicit Save |
| N4 | Native on-demand media | `TranscriptEntryView.swift`, shared/native chat views and new bounded preview/cache helpers; zero bytes on collapsed references, one selected verified PNG/JPEG/PDF preview, inert rendering without external-resource loading, active-content/network observation, explicit export |
| N5 | Native Claude image upload/draft | New strict Swift image codec/controller plus existing composer/platform picker/paste; existing ADR0041/42 vectors and actual no-Enter Add, explicit Send and uncertainty state |

Image, terminal and profile preparation are separate backend tracks.
Their architectural preparation can proceed without waiting for native UI or owner hardware; each runtime path waits for its own accepted contract.
Native acceptance retains the previously approved media-then-profile-UI sequence.
No approval for a general shell, arbitrary file upload or live account migration is inferred.

## Decision gate (set before implementation)

An operation is advertised on a route only when its strict wire/goldens, actual host handler, authority/lifecycle controls and one real production caller pass for that route and harness.
Passing direct does not enable relay, passing Claude does not enable Codex, and passing TypeScript does not establish native/device acceptance.

- File operations must preserve the existing 10 MiB/32 KiB/64 KiB limits, exact digest, descriptor confinement and cleanup debt. Zero bytes are fetched by collapsed references. Unknown media stays inert. Failure retains the prior unavailable state.
- Terminal snapshots must reproduce controlled current screens after redraw, alternate-screen changes, Unicode and resize from the local terminal. Oversized/hostile output stays within registered memory/frame/rate limits and never invokes a PTY input/resize method. Failure keeps `terminal_view` unavailable.
- Actual held-hook No must complete within the existing 1,000 ms gate during maximum accepted transfer, screen parsing and snapshot load. No unbounded terminal/file queue may delay decisions. Failure disables the candidate and preserves receipts.
- Two simultaneous profiles must select different owned config/environment/temp and Codex server contexts; resume and histories preserve their captured profile and default behavior. An environment-only pass is not account-isolation acceptance. Failure leaves explicit-profile support unavailable.
- Legacy fixtures and text-only replies remain compatible; the license and harness boundaries remain green. No speculative global capability or version bump.

## Prerequisites (user actions)

No credential or provider login is needed to prepare contracts, inert CLI probes or source-host tests.
The owner completes real provider sign-in/refresh in their own terminal and later confirms simultaneous persistent accounts, including the previously proposed 24-hour refresh observation.
Provider turns/image recognition, production certificate/enrollment changes, Worker deployment and signed iPhone/Mac release acceptance retain their separate concrete authorizations.
This plan does not ask to repeat approval of the existing media/profile product scope.

## Agent budget

Zero subagents spawned for orientation or this plan.
The plan PR used one read-only reviewer, as required by the repository's `.rules/code_review.md`.
B1 used one fresh documentation reviewer and now uses one focused code reviewer for the bounded primitive: maximum three unique subagents across orientation and B1, with no implementation team.
Implementation can proceed sequentially; this is not an authorization for an implementation agent team.
If later explicitly requested, use a bounded plan and at most two review rounds per PR.

## Open judgment calls

- Resolved by the owner this session: view the existing agent terminal read-only; keep input in chat/approval controls.
- Approved architecture: normalized current-screen snapshots over WSS/encrypted relay, with the original geometry/rate/lease bounds above. The owner approved qualifying 1 MiB per session / 32 MiB per home after the original memory-gate failure. Screen implementation and exact wire/ADR remain qualification gates.
- Proposed internal choice: preserve provider flags by using `--remi-profile`; one immutable profile selection per session; remote choices explicitly enabled in local config.
- Approved sequencing: terminal first, then the existing media/profile uses. Reuse the existing file/image contracts when that follow-up begins.
- Deliberately deferred: general shell/input, arbitrary file/PDF upload, directory browsing, empty/larger downloads, account usage polling and OS/container isolation. Each needs a separate scope/contract decision.

## Verification

For this documentation PR: check local links and referenced symbols against the pinned source; run `git diff --check` and `typos` on changed files. No runtime availability claim is made.

For implementation, use real objects/filesystem/source hubs and the shared conformance corpora, not replacements for business logic:

- Shared codecs/registry: `bun test packages/shared/tests`, including protocol positive/refusal vectors and additive compatibility. Swift consumes the same files rather than hand-copied examples.
- Existing source regressions: image staging/insertion tests; `packages/daemon/tests/tunnel/file-download-service.test.ts`; `packages/daemon/tests/integration/file-download-cli.test.ts`; `packages/daemon/tests/remote/hub-relay-file-download.test.ts`; harness/license boundary tests. Add targeted real-host terminal/profile populations with named negative controls.
- Recheck stale device/grant/incarnation, same session ID on two machines, detach/reconnect, child replacement, cancellation/lost results, parser desynchronization and simultaneous profiles. A changed profile/config cannot retarget a queued operation.
- Qualify changed runtime code on supported Apple Silicon Mac, Linux ARM64 and Linux x64 with the repository's two pinned Bun executions. Preserve the compiled image/storage proofs when those subsystems change; do not rerun unrelated long proofs for this docs-only PR.
- Run applicable type/lint/spelling/full-suite/coverage and hosted workflow gates. Relay changes require the existing real 61-minute source R7 gate; its pass does not establish deployed Cloudflare behavior.
- Native PRs run the required Swift/unsigned Mac/Phone gates in `packages/native/AGENTS.md`; render real controls on both apps and check responsive previews, cancellation, offline/uncertain states and route locks. Use owned hubs and S1 build output.
- Owner hardware acceptance separately proves signed sandbox behavior, paste/picker, on-demand Preview/Save, background cleanup and real account persistence. Record measured, unverified and deferred outcomes separately.
