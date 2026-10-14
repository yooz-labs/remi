# Plan: the roadmap

Updated 2026-10-11.
One page: where remi stands, what comes next and in what order, and how each step is tested.
The work itself lives in GitHub milestones and issues; standing decisions live in [decisions/](decisions/) as ADRs; history lives in [archive/](archive/).

## Where things stand

- **Supported hosts (owner decision, ADR 0040):** Apple Silicon Macs (M1 and
  later), Linux ARM64 and Linux x86_64. Intel Mac/Rosetta is outside acceptance
  and future distribution scope.
- **Released on GitHub:** [0.7.16](https://github.com/yooz-labs/remi/releases/tag/v0.7.16), published 2026-10-07.
- **On develop (0.7.17-dev), ahead of the stable release:**
  - no local judge: Claude Code decides permissions, remi relays them (#1125, ADR 0030);
  - held-hook answers (#1126, #1127, ADR 0031);
  - the Codex adapter (epic #1175, ADR 0033);
  - first-connect approval: every client key is approved once with `remi authorize` (#873);
  - the relay off by default and fail-closed (#1193);
  - one `turn_failed` alert per failure until the agent works again (#1153, #1226).
- **Relay backend landed in develop:** [#1331](https://github.com/yooz-labs/remi/pull/1331), merge `b1168126`, includes the existing R1-R5 and daemon R6 contracts, the authority-contention correction, v1 retirement and heartbeat replies. Relay remains off by default. Both full Bun suites and the actual [61-minute Linux relay gate](https://github.com/yooz-labs/remi/actions/runs/37905906897) passed at backend `2858e4bd`, whose tree equals the merge. Signed-device and deployed-Worker acceptance remain open; #1195/#1202 are not closed by the source landing.
- **File tunnel:** [#1329](https://github.com/yooz-labs/remi/pull/1329) records the broader proposal. Direct PNG/JPEG staging and its web caller landed in #1487 under accepted [ADR 0041](decisions/0041-direct-image-staging.md). [ADR 0042](decisions/0042-claude-image-insertion.md) separately covers explicit no-Enter insertion and visible original expiry: host lease/coordinator/strict direct dispatch controls are recorded below; the explicit client action and native conformance remain availability gates. Links and downloads are later scope.
- **Apps today:**
  - a sandboxed macOS menu-bar app that hosts the web UI;
  - the Capacitor iPhone app with a Notification Service Extension;
  - the web client.

  Native SwiftUI source lives in `packages/native`: [native-apps-plan-2026-10.md](native-apps-plan-2026-10.md).
  Relay and secure native answers continue in existing [#1330](https://github.com/yooz-labs/remi/pull/1330), against the landed backend; its handoff lists the foreground Ping/Pong fix, source-test refresh and remaining signed/device gates.

## Milestones, in order

Each milestone is a GitHub milestone of the same name. Issues outside a milestone belong to a track (below).

| # | Milestone | What it delivers | Done when |
|---|---|---|---|
| 1 | **0.7.16 release** | Develop shipped to users, with its release blockers fixed: #1223 (legacy cards not dismissed on a real close), #729 (the always-on hub's logs never rotate), #1131 (third-party notices in the packages), #1249 (the agent's process inherits remi's secrets), #1254 (a machine the phone disconnected from keeps pushing to it) | The owner approves the release (#1233); `develop` to `main` is merged; the upgrade notes cover the one-time `remi authorize` and stopping the old engine by hand |
| 2 | **Relay R7** | Relay v2 finished and merged into develop, still off by default: #1224, #1225, R7 (#1202); then close #1195, #1199, #1200, #544, #373 | The R7 suite passes against a real Durable Object (session over an hour; replay, displacement, stranger and revoke refused; ciphertext only); the owner's signed-device and deployed-Worker gates pass |
| 3 | **Protocol freeze** | The wire a native client builds on: machine object (#1234), Decision (#1235), workspaces and worktrees (#1236), version and capabilities (#1237), fixture coverage (#1238), multiple profiles per session (#1157), the file tunnel's frames (#1170), plus #1129, #534, #695, #791 | Every message a native client uses has a golden fixture and an ADR records each new shape |
| 4 | **Native foundations (X0-X2)** | Repo prep for Xcode's agents (#1240), the `RemiKit` core (#1241), relay v2 in Swift and native answers (#1242, #1201) | Every fixture round-trips in Swift; all relay v2 vectors pass in Swift; a TypeScript hub accepts a Swift-signed answer |
| 5 | **Native apps (X3-X4)** | The Conductor-like Mac app (#1243) and the iPhone app (#1244) | The Mac app replaces the WebView window for daily use on two machines; the iPhone app reaches parity with the Capacitor app |
| 6 | **Native depth (X5-X6)** | Diffs, files and a terminal view (#1245); Live Activities, Watch and widgets (#1246) | Per phase issue |

Milestones 2 and 3 run in parallel.
The native apps (milestones 4 and 5) run in parallel too: Codex builds them in Xcode from `packages/native/handoff/README.md`, on `develop` (the scaffold moved there on 2026-10-07 in #1267; there is no epic branch), as two tracks, the Mac app and the iPhone app.
They build against today's wire and adopt the freeze's shapes as they land.
The epic for 4 to 6 is #1239.

## Completed backend continuation: recent repositories (#1284)

The owner selected #1284 on 2026-10-09 while the native developer continues X2 separately.
The wire stays unchanged; only successful hub starts write history, capped at 20 with no age expiry.
Landed through [#1332](https://github.com/yooz-labs/remi/pull/1332) at `ef84b4c6`, with the same tree as tested `28ea5daf`.
Both full Bun suites passed 7,942 tests with no failures; Linux CI and the actual 61-minute relay gate passed.
The existing native caller needs no new Swift model or wire field for this persistence behavior.

1. Pin the removed-worktree and expired-session regressions against the original source, plus ordinary creates and hub resumes (`tests/integration/hub-create-session.test.ts`, `hub-resume.test.ts`).
2. Add restricted atomic history (`workspace/recent-store.ts`), merge it into `workspace/recent.ts`, and wire the successful shared starter and recent-repositories handler in `cli.ts`; async lock waiting reuses the existing ownership and stale recovery rules.
3. Verify canonical main repositories, latest-use deduplication, cap, permissions, damaged-source fallback, simultaneous writers and responsive bounded lock waiting; update ADR 0036's source and disclosure descriptions.
4. Review, mutation-check each behavior, run fresh full suites on Bun 1.4.2 and 1.3.11 and the existing CI gates, then land through a PR to develop.

## Next work while native acceptance proceeds

1. Complete the backend machine descriptor in #1234, with the existing relay room ID and shared bounded pairing name, hello/list fields, entry machine IDs, fixtures and ADR 0039. Native persisted aliases, rename controls and profile transfer follow these contracts in the Xcode track. #1330 and #1342 have landed; remaining signed/native acceptance stays with #1242/#1201.
2. The file-tunnel proposal [#1329](https://github.com/yooz-labs/remi/pull/1329) landed at `35254d7e`. Packaging [#1350](https://github.com/yooz-labs/remi/pull/1350), admission [#1362](https://github.com/yooz-labs/remi/pull/1362) and private-copy proof [#1381](https://github.com/yooz-labs/remi/pull/1381) landed; six supported target/version executions passed 27 storage/admission/copy controls. Decoder admission #1383 and child lifetime #1397 landed. The held-answer proof [#1411](https://github.com/yooz-labs/remi/pull/1411) keeps a real hook's No responsive under repeated owned decoding; its synchronous parent-block control crosses the one-second limit. Palette admission [#1416](https://github.com/yooz-labs/remi/pull/1416) passed the combined six-pair 21-group matrix. These are standalone controls, not production adoption. Portable CPU/memory enforcement and the native macOS worker startup failure [#1417](https://github.com/yooz-labs/remi/issues/1417) remain open. Trusted reservation accounting [#1415](https://github.com/yooz-labs/remi/pull/1415) and its private-copy composition [#1419](https://github.com/yooz-labs/remi/pull/1419) landed, including failed-cleanup allocation retention and unknown-allocation blocking debt. The standalone [storage-load held-answer proof](../scripts/tunnel-storage-proof/README.md#held-answer-storage-load-proof) passed all six supported compiled cells with the unchanged 43 storage groups plus four real held-answer controls. The standalone immutable ownership journal [#1440](https://github.com/yooz-labs/remi/issues/1440) passed all six supported compiled cells with 61 groups (43 predecessors plus 18 recovery groups), an independent 43-group compatibility matrix and five semantic mutations on both Bun gates. Original canonical-byte guards passed duplicate/noncanonical/empty/truncated marker controls on both compiled Mac gates before a shared-predicate extraction. The 61-group recovery profile retains its reservation charge after journal cleanup. Standalone quota reconciliation and bounded journal retirement #1443 passed all six supported compiled cells with 88 groups (61 predecessors plus 27 settlement groups), independent six-cell 61/43-group compatibility profiles, and six semantic mutations on both Bun gates (12 exact compiled failures). It retires witnessed journal markers before quota release and retains at most 128 pending/completed ledger rows without evicting pending debt. Managed writes precharge and retain measured or blocking debt under the same nonblocking transaction before further admission. Real partial-write and close failures preserve intent ownership until process death; 130 completed cycles leave bounded receipts and empty owned namespaces. Independent review completed. These are standalone observations; no production authority is implemented. Production lifecycle and decoder availability/resource enforcement still precede staging. Internal journal-helper adoption is recorded below; no attachment capability is available. Keep #1170 open.
   **Decoder worker policy (#1417):** the standalone candidate now supplies `BUN_JSC_useJIT=0` through its existing private environment whitelist on both one-shot and repeated workers. The default 19-group and held 22-group profiles retain all original 18/21 checks and passed all six supported platform/Bun cells each; removing the setting produced the exact compiled assertion and actual child exit 23 on both Mac Bun gates. Original pixels, cancellation, five-second lifetime, two-second reap and 1000 ms held-answer thresholds passed unchanged. Parent runtime settings are preserved. Independent review and root verification matched the compiled inputs, binaries and logs. This is finite standalone acceptance, not a general Bun startup fix or production helper selection. The extra OS resource-limit investigation is deferred by owner direction; continue the practical file-transfer plan.
3. Follow the [file-tunnel execution queue](../docs/FILE-TUNNEL.md#next-independently-reviewable-changes): reuse the standalone storage/decoder proofs and accepted staging codec/fixtures, settle production helper/budget adoption, integrate reservations and authenticated direct staging, then add one production client caller. Coordinate Swift wire conformance against the shared vectors in the existing native track. Claude insertion, links, outbound files and relay/native depth each have separate gates. The sharp candidate failed compiled loading; the existing pngjs/jpeg-js candidate has standalone malformed-input, cancellation and held-answer evidence, with production decoder/budget selection still pending. Do not duplicate the native developer's work or wait for relay deployment to prepare direct staging.

## Tracks (work outside the milestones)

Labeled by area and prioritized P1 to P3.
Take P1 and P2 items between milestones; P3 items when they are in the way.

- **claude** (the Claude Code harness): #375 (P1, suspend and resume loses input), then #808, #1147, #940, #1189 with #1211, #1137.
- **codex:** #1192 (Guardian reviews), #1187; #1207 waits on an owner decision.
- **web:** #1146, then the P3 list.
- **quality:**
  - #1232: one port helper; it supersedes #1150, #1159 and #1169.
  - #1213, which likely causes the hub-create flake.
  - #1206, the `bun test` hang, capped in CI by #1215.
  - #855, #1191.
- **docs:** #1145, a new notification-flow diagram.
- **backlog:** ideas, not scheduled.

## Owner decisions

Collected in #1233. Decided on 2026-10-06:
- **Release 0.7.16:** yes, once milestone 1 is done.
- **Release automation:** the Bun, npm and Homebrew pipeline stays automated (`release.yml`). The native apps go to TestFlight by pushing the archive directly, the way transit and whisper do; the owner runs the upload (#1240).
- **Mac app distribution:** the App Store if the sandbox allows it; otherwise Developer ID.
- **Minimum OS:** macOS 26 and iOS 26.
- **Capacitor iOS app:** it retires once the same mechanics are designed natively, at X4 parity (#1244).
- **Worktrees:** hub-created worktrees live in `../remi-worktrees`, next to the repository (#1236).
- **Freeze scope:** the file tunnel (#1170) and multiple profiles per session (#1157) join the protocol freeze.
- **Remote and hub posture:** the host passes its default (#1208, #1192).
- **Old epics:** #548 and #885 are closed, their leftovers tracked on their own.

- **Project structure:** the native apps use a checked-in Xcode project with synchronized folders (`packages/native/Remi.xcodeproj`); `packages/macos` keeps xcodegen until it retires.
- **Native apps start now,** in parallel with the protocol freeze.

Still open:
- the push lease: how many days a phone can go without reconnecting before a machine stops pushing to it (#1254; proposed 30);
- whether closing a session deletes its worktree (until decided, it does not);
- Codex typed chat (#1207).

## How every step is tested

- A pin test is committed first, and it must fail; then the fix.
- Each part of a fix is mutation-checked: revert it and a test fails.
- No mocks that replace business logic.
- Gates on every PR:
  - the full `bun test` on Bun 1.4.2 and on the CI-pinned Bun 1.3.11;
  - `bun run typecheck`, `bunx biome check`, `typos`;
  - the macOS `RemiTests` for Swift changes;
  - the integration scripts and browser tests when the daemon wire or the web client changes.
- Each PR gets a Sonnet review, and every finding is fixed or recorded with its reason.
- Owner hardware gates (signed builds, real devices, a deployed Worker) are listed in their milestone and are never claimed as passed without the owner's run (ADR 0011).

## Internal file-tunnel accounting adoption

The existing reservation and strict journal schema now live under
`packages/daemon/src/tunnel`, with proof adapters sharing the same implementation
and `RecoveryError` constructor.
The accounting bodies, limits and registered guard variants are preserved.
Six supported compiled executions each passed the unchanged 88 groups; twelve
exact Mac guard controls passed, alongside both-Bun actual filesystem and boundary checks.
The one-time CI relocation rule in #1462 preserves ordinary gates and skips the
unrelated relay soak only while reviewed producer/consumer provenance remains exact.

Descriptor, journal and explicit helper ownership are recorded below.
Next adopt the disposable decoder and active production lifecycle, then the
authenticated direct upload handler and one client.
No attachment capability or runtime transfer caller is available from this move.

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

The existing explicit journal factory and exact C bytes now live under
`packages/daemon/src/tunnel`; its proof module re-exports the same function.
The daemon owns the C asset declaration, referenced by the factory and proof
assets. This preserves the original root TypeScript graph without an extra
focused declaration input. Native operations, errno, flags and exactly-one
closure semantics are unchanged; link remains unsupported for the separate copy
path. No index export, startup initialization or active upload caller is added.

All six supported compiled cells pass the unchanged 88 groups with frozen source
and clean owned temporary state. Both root type checks and both 41-test/500-assertion
focused populations pass. The new test verifies actual descriptor operations,
successful CLOEXEC results and lock contention/release before ordered closure.
Prior guard receipts remain source-qualified historical observations.

Image header admission and full decoding are recorded below. Next integrate the
existing owned worker/controller and trusted entry, then authenticated direct
staging and one production client.
These internal packaging results do not establish a physical allocation ceiling,
power-loss guarantee, active lifecycle or upload availability. Keep #1170 open.

## Internal image header admission adoption

The daemon owns the existing bounded image header parser in
`tunnel/image-admission.ts`, distinct from descriptor admission.
Proof callers use explicit re-exports of the same function, constant and type.
Thirteen bound-proven numeric type assertions satisfy the unchanged root
TypeScript configuration while preserving byte-identical emitted JavaScript.
Runtime guards, input/format/dimension limits and decoder worker policy are unchanged.

The existing default runner now captures the actual moved daemon implementation
through its shared tree/entry/snapshot support. Final default 19-group and held
22-group profiles each pass all six supported platform/Bun cells, preserving
original controls, full-decoded fixture pixels, pinned 42-member proof dependencies
and clean owned temporary state. The header phase passed both root type checks
and focused 42-test/495-assertion populations with no new diagnostics or warnings.
After journal-helper integration, both unchanged root checks and the combined
43-test/520-assertion populations also pass; the four header source paths retain
their reviewed hashes.

This selects internal header-parser ownership. Full-decoder ownership and
dependencies are recorded below; owned worker/entry/lifecycle, authenticated
upload and one client remain subsequent phases.
Header admission is not full pixel validation;
no active upload caller or capability is advertised. Keep #1170 open.

## Internal full image decoder adoption

The daemon owns the existing synchronous `decodeImage` implementation and exact
PNG declarations. Proof callers explicitly re-export the same function and
reference that declaration, retaining their image asset types.
Direct dependencies select the measured pngjs 7.0.0 and jpeg-js 0.4.4 bytes.
The generated lock preserves every other package entry and qrcode's PNG 5.0.0
resolution. Actual bundle/license checks show the decoder's two selected
packages; the CLI still has its original 17-package graph with PNG 5 only.
There is no startup or active transfer decoder caller.

Both unchanged root type checks and both focused 53-test/618-assertion populations
pass. The real-fixture test preserves input and pixel hashes, shared function
identity, header refusal and normalized PNG CRC refusal. Python diagnostics are
unchanged; formatting and spelling checks pass. The two existing profiles now
capture daemon metadata as well as moved source and the root lock.

Final default 19-group and held 22-group profiles each pass all six supported
platform/Bun cells, with all 24 build/run exits zero, original ordered controls
and pixels, exact 42-member dependencies and clean owned temporary state.
Actual held No latency under decoder load was 0.72-61.16 ms against the unchanged
1,000-ms limit; all six deliberate parent-block controls exceeded that limit.
These are finite standalone results, not portable memory/CPU ceilings.

Controller/worker ownership is recorded below. Next select a trusted entry before
CLI initialization, then implement authenticated staging and one production
client. Dependency/body ownership does not advertise upload availability.
Keep #1170 open.

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

## Configurable CLI harness (#1473)

The owner requested a local CLI default on 2026-10-12.
`[harness] default` selects Claude or Codex, with Claude as the built-in default.
Explicit `remi claude`, `remi codex` and `--harness` override it; conflicting
explicit choices and invalid tables/values are refused.
One resolver drives local and remote creation plus resume/recent/directory guards.
Hub and management commands stay session-less or administrative.
Each hub child receives its resolved harness explicitly, including Claude for
legacy/native omitted requests and hub resume. Wire and stored omissions retain
their existing Claude identity meaning.

Both original root type checks pass. Both focused populations pass 471 tests
and 1,776 assertions across 12 files, with no failures or formatting warnings.
A repeatable actual-config/parser/protocol scenario suite scores 36/36 after
versus 18/36 using the original selector expressions. Owned CLI subprocess
checks verify configuration, help, management and early routing refusals.
These observations do not claim a new real Claude/Codex turn or device acceptance.
Independent review precedes publication; fresh hosted CI precedes landing.

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
harness or returns a host path. Direct WebSocket encryption remains outside Remi;
use an existing private transport as described in ADR 0009.

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

## Image insertion: installed CLI and queue prerequisite

Direct staging #1487 and queued-input guards #1489 are now merged on develop.
The next #1170 slice reuses the guarded queue and held JournalRead; no second upload store is planned.
The [installed-CLI observation](../docs/claude-image-insertion-characterization.md) records four owner-authorized turns on Claude Code 2.1.296.
Quoted absolute PNG paths with spaces, JPEG and extensionless PNG bytes became actual image attachments only after a separate Enter.
A normal exit/resume worked after removal of the submitted originals.
Removing a new draft reference's original before submission produced no new image attachment.
The response to that negative control was unusable; only the missing embedding is accepted as evidence.

The dormant `PTYSession.insertText` method uses the existing write queue, checks its required guard at the effect, rejects controls and adds no Enter.
Real PTY tests cover exact literal input, queue ordering, queued validity changes, guard failure and exited terminals.
This does not advertise insertion or add a production caller.
Artifact acquisition/one-effect retirement, an accepted expiration contract, shared/native wire conformance and explicit client action remain the next slice.
The current 24-hour/session-exit policy does not promise an indefinitely valid unsent reference; settle that product behavior explicitly before freezing insertion.

## Image insertion: owned reference preparation

The internal `JournalRead.referencePath()` candidate reuses its held staged file and current descriptor/name/root/accounting checks.
It supplies no path before successful retention or after close, creates no copy and changes no quota or deadline.
The later coordinator must still check device/grant/session/binding/prompt and expiration at the queued effect; this internal accessor supplies none of that authority.
No protocol field, capability or production insertion caller is registered by this slice.

Both Bun source populations pass 25 tests/593 assertions, including staged PNG/JPEG access and actual replacement, mutation, symlink, hardlink, unlink and configured-root refusal on macOS.
Six supported compiled executions pass the 105-group storage/journal profile; added reference controls cover staged-only access, exact named bytes and closed access.
Specific accessor mutation controls remain source macOS observations, while the compiled profile exercises the reused ownership validators' existing fault controls.
All six executions retain identical current source/dependency inputs and report no cleanup errors.

The first compiled attempt found a stale predecessor control before the new reference groups: 130 same-device cycles expected 128 home rows but correctly retained 32 device receipts plus one pending row.
The unchanged 95702c73 base reproduced the same `33 != 128` failure.
The corrected control independently checks 130 same-device cycles and 130 distinct-device cycles, proving both 32/device and 128/home history bounds, retained pending charge and both eviction/retry outcomes.
Production reservation limits and algorithms remain unchanged; original failures and corrected receipts are retained on S1.
Independent review completed without actionable findings; publication/hosted checks precede landing.
The insertion contract was subsequently accepted by the owner; the exact-path
result and correction are recorded below. Production caller/native acceptance remain later gates.

## Image insertion: accepted contract and filename correction

The owner accepted ADR0042 on 2026-10-13, including the first-version original
direct connection, one possible insertion, separate Send and visible original
24-hour/session-end expiry. Exactly one additionally authorized Claude turn
tested actual private `.artifact` references outside its project: neither became
an embedded image. Insertion remains unavailable; no capability/caller is added.

New image journals select `.png` / `.jpg` from their declared media type at
creation; completion already verifies that type against bytes and full decoding.
The exact extension is stored in the lease/reservation and immutable version2
markers. Original `.artifact` journals retain version1 naming and recovery.
Read, accounting, cleanup and retirement use that same persisted choice.
No existing file is renamed, copied or linked, and no quota/deadline changes.
Older binaries reject the extended ledger schema instead of guessing cleanup;
these rows require the matching daemon for recovery and remain charged otherwise.

The correction preserves all 105 predecessor compiled groups and adds 18
actual-file/image-name groups, including both formats, wrong-format refusal,
descriptor/name/root mutation and six killed-retirement restart boundaries per
format. Both Bun source populations pass 25 tests/635 assertions, and all six
supported compiled cells pass 123 groups with unchanged source, clean runtime
temp and no cleanup errors, using the predecessor's 256 MiB/64-PID Linux envelope.
Independent review found only stale caller banners in three touched storage
modules; those descriptions are corrected in this same change.
The subsequent corrected exact-path model check passed, as recorded below.
Managed insertion retirement, shared vectors, handler/client integration and
native conformance are separate subsequent gates.

## Image insertion: corrected CLI route and internal lease

The filename correction landed in #1495 at `9a6ef90b`.
One separately approved corrective Claude turn passed with exact retained PNG
and JPEG paths outside its project: both image payloads and color answers match,
with zero CR/LF before one explicit Enter. Exactly six authorized turns are used.

The internal lease prepares the existing reader, original PTY and expiry.
It rechecks original signed socket, grant incarnation, attachment incarnation,
live session/runtime, binding, deadline, prompt and current file at retirement.
Retirement marks one possible write for the image before a sink can run; a
lease reports whether it crossed that boundary. It allocates no new file,
reader, quota, deadline or retry map and registers no wire message/capability.

A real detach/reattach control exposed that membership alone revived an old
capture on the same socket. Process-local attachment tokens now preserve
duplicate attach, change on genuine reattach and clear on detach/session exit.
Staging's existing authority checks use the same token. The original control
failed before this fix and passes afterward; the old upload cannot revive either.

The following sections record outcome/retry handling, shared vectors and direct
host dispatch. The explicit client action, capability availability and native
conformance remain separate gates; the lease alone is not Add to draft.

## Image insertion: shared structural contract

The accepted two-message codec and request-only correlated ingress reuse the
existing strict scalar/UUID/date/opaque-ID/binding/frame guards. Before extraction,
all 503 staging vector outcomes were pinned; their decoded/ingress/encoded hash
remains unchanged. At that stage the public registry and capability advertisement
were unchanged; direct dispatch is recorded below.

An independent generator imports no production codec/guard and supplies 14
positive and 282 negative insertion vectors. Both Bun source populations pass
1,747 focused tests and 16,249 assertions, including existing protocol fixtures.
The supported compiled matrix passes the new vectors and the preserved staging
hash on Apple Silicon Mac and Linux ARM64/x64 with Bun 1.3.11 and 1.4.2.
The outer corpus loads in Foundation; this is fixture interchange, not native
decoder conformance. The later sections record the coordinator and queued host
caller. The explicit client action and native conformance remain separate gates.

## Image insertion: internal outcome coordinator

The coordinator captures request fields and retains at most 128 process-local
attempts. Exact concurrent/repeated requests share one immutable recorded result;
changed fields conflict only while the original signed owner remains current.
A pre-write refusal stays recorded for that ID; a fresh explicit ID can try again.
The artifact's separate retirement still permits only one possible write.
Cache validation after retirement grants no new write authority. Lost authority,
file validity or deadline prevents cached delivery; busy never discards a receipt.
At capacity, unusable receipts are pruned before returning busy. Close cancels
queued effects and drops correlations; no file, quota or lifetime is added.

Actual signed/decoded/PTY controls cover both formats, concurrent/lost response
replay, caller mutation, held-hook refusal then a fresh explicit attempt, queued
grant/reattach/binding/exit/file/close changes and foreign/revoked cached access.
Closing the actual terminal at the retirement boundary records an uncertain
effect and prevents replay; session exit may separately end delivery authority.
The first 128-request bound control timed out because each request revalidated
all retained files. Sweeping only at capacity makes that same unchanged control
pass in 2.1 seconds, without relaxing its 15-second limit.

The direct dispatch section below records the supported compiled caller controls.
The coordinator alone does not provide the explicit client action or native
conformance required for availability.

The coordinator's R1 found that spreading binding members preserved their JSON
order in the retry signature. Copying the two binding fields in a fixed order
now makes equivalent reordered retries share the recorded outcome. The actual
signed-wire regression failed before this fix; the coordinator source controls
pass 169 tests and 1,508 assertions on both supported Bun versions afterward.

## Image insertion: strict direct host dispatch

Exactly two public message/direction entries use the strict codec before legacy
parsing and ordinary ID deduplication. The existing fixed-unit candidacy scanner
is reused with a second fixed prefix; a separately committed original 503-case
candidacy hash remains unchanged, alongside the earlier codec/ingress hash.
Malformed hints locate only the original current owner for a fixed refusal code.
Uncorrelatable, wrong-direction and oversized frames close without an effect.

The CLI constructs the coordinator beside the supported authenticated direct
Claude staging service, uses the same current harness prompt-up wiring as chat,
and closes the coordinator before staging cleanup. The signed-socket fixture
uses that same production handler factory. On Apple Silicon Mac, both Bun source
populations pass 1,764 shared/event tests (16,623 assertions) plus 178 daemon/PTY/registry/journal
tests (1,705 assertions), with root and web type checks clean.

The actual compiled production entry passes on Apple Silicon Mac and Linux
ARM64/x64 with Bun 1.3.11 and 1.4.2. Each cell provisions an ephemeral signed
client, stages PNG and JPEG through the actual worker, writes one original
reference per image with zero CR/LF, replays an equivalent reordered retry,
refuses another ID, refuses insertion during the actual HTTP permission hold,
answers No, and rejects cached delivery after grant revocation. Owned helper and
daemon exits are awaited/ESRCH-confirmed; three rows settle to zero charge and
staging names are gone. The harness executable is inert cat, with no model or
owner configuration used. This complements the six earlier approved Claude
turns; it does not claim additional model, native or device acceptance.

`image_insertion` is still not advertised. The production explicit Add to draft
client, visible original expiry, client result correlation and rendered QA are
the next step; native runs the shared corpus independently.
