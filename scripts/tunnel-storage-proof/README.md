# File storage packaging spike (#1170)

This reproduces the existing T0 experiment from `docs/FILE-TUNNEL.md`.
The probe uses newly created temporary content files and closes its descriptors.
Its nonregular-file control also opens `/dev/null` for metadata inspection;
it reads no device bytes and creates no device.
The original storage primitive probe embeds its C source in the executable,
then materializes it into a private temporary directory for Bun's experimental
C compiler. The standalone held-answer load proof described below prepares its
own library before the measured worker starts.
The native `openat` address is resolved explicitly; its variadic creation
call is made through a fixed C wrapper.

The seven existing primitive controls cover exclusive creation/publication,
same-descriptor inspection/read, invalid components, leaf/ancestor symlinks,
hardlinks and cleanup through a captured directory after path replacement.
The candidate now adds nine admission controls with a real descriptor walk from
`/`: hidden/credential components before opening, configured credential-root
overlap and replacements, symlink/hardlink refusal, deterministic ancestor/leaf
replacement, descriptor lease revalidation, directory/FIFO/socket/device refusal,
the initial 10 MiB boundary, and captured-root replacement.
The complete spelling is checked before any native open. Credential directories
are denied both by component-aware configured paths and held device/inode
identities, so custom names, replacements and renamed directories are covered.
Current configured-directory identities are refreshed through real descriptor
captures before admission and lease revalidation. This covers observed filesystem
normalization/case aliases to replacement inodes; missing configured roots refuse.
The lookup snapshot is retained through traversal and owned by the file lease
until close, so moving a sampled replacement beneath a selected ancestor does
not remove its denial identity. A real checkpoint proves this rename/recreate case.
The receipt reports actual alias modes, rather than assuming every filesystem
provides them. ASCII case aliases also refuse lexically before native opens.
The corpus confirms a sibling prefix remains readable.
Replacement checkpoints run after actual native opens and perform real renames;
they do not substitute filesystem calls or metadata.

The private-copy candidate reuses the admitted source FD and checks its original
device/inode, regular type, single link, size and nanosecond mtime/ctime before
and after copying. It reads at most the admitted size plus one into 32 KiB
buffers, handles partial writes, verifies the completed private length/digest
and repeats destination validation at publication. Generated private names
are checked against the held device/inode before publication and cleanup;
replacements refuse cleanup and remain untouched. Publication uses exclusive
descriptor-relative linking. Generated partials
are 0600 beneath a captured owner-only 0700 directory; only the completed
private descriptor is read. A retained directory FD supports cleanup after a
root-path replacement and an actual failed completed unlink remains retryable.

Eleven copy control groups cover empty/nonempty/10 MiB bytes/digest/mode, growth,
truncation and detected same-size changes, an exactly restored mtime with a
changed ctime, source name replacements and new hardlinks, private byte/mode
changes, effect-time source validation, actual EBADF reads/writes, creation and
publication collisions, captured cleanup and independent completed bytes.
Destination bytes/mode are changed at the final validation checkpoint too;
actual partial/completed name replacements prove inode-bound cleanup refusal.
All fixture changes use actual OS files/descriptors; checkpoint completion is
required before a refusal counts. Short writes are handled in source but not
forced in this corpus. No fixture establishes atomic snapshots or complete
concurrent-edit detection, including edits between final checks/publication.

This remains a packaging/admission/copy experiment. The separate reservation
candidate below adds trusted metadata accounting; descriptor-confined recovery
and transfer lifecycle remain subsequent work. Bun's compiler/FFI APIs
remain candidate mechanisms; no production helper has been selected.
No helper or decoder is selected for production by this spike.

## Run

Use the project's Bun 1.3.11 pin and the installed current Bun.
The owner's supported hosts are Apple Silicon Macs and Linux ARM64/x64.
These three targets on two Bun versions require six runtime executions.
Supply existing Docker image references with suitable Linux runtimes; the
runner uses `--pull=never` and records the executable's actual architecture.
Linux execution requires Docker's platform-specific image inspection support.
The runner resolves each reference once for the whole matrix to a local
immutable image/index ID, inspects
the requested platform through that ID, then executes the same ID with the
explicit platform. Both the runnable ID and selected platform's ID are recorded.
With Docker's containerd store, a platform inspection can report a platform manifest
digest that is not itself a runnable image reference.
Choose a new private output directory outside the checkout.

```sh
uv run python scripts/tunnel-storage-proof/matrix.py \
  --bun-1311 /path/to/bun-1.3.11 \
  --bun-current /path/to/current-bun \
  --out /private/tmp/remi-storage-packaging-unique \
  --linux-arm64-image image-reference \
  --linux-x64-image image-reference
```

The Mac execution requires an Apple Silicon host; if unavailable, it is recorded
as missing and the matrix remains incomplete. There is no Intel Mac target.
The scope of the storage entry's 6/6 execution result is seven primitive,
nine admission and eleven private-copy controls.
`--build-only` prepares all six executables, records their hashes and exits 2
with every runtime execution explicitly unmeasured.

## Receipts

`receipt.json` records source and executable hashes, commands, exits and
the probe's reported Bun/platform/architecture. Each stage has a retained
log and a 120-second deadline. Docker writes this run's container ID into
a fresh cidfile; failure cleanup removes only that ID, never a name whose
creation failed. All other containers are untouched.
The child environment selects PATH, LANG and the private temporary directory;
it does not replace HOME or pass the parent's credential variables.

The output must report six successful builds and six matching runtime
executions before `complete` is true. A build alone proves no execution.
Missing or mismatched probe output fails the stage.
The storage runner records the compiler versions, checks all 27 named controls,
and refuses to advance if its source changes during a run. Mac binaries run
from a newly created empty working directory to check their embedded source.
Compilation uses a captured source snapshot and a private working directory;
compiler caches stay beside the retained evidence, outside the checkout.
Missing or unreadable source invalidates the final receipt. A failed Docker
cleanup is recorded with the owned container name for a later retry.

API references: [Bun C compiler](https://bun.sh/docs/runtime/c-compiler)
and [Bun FFI](https://bun.sh/docs/runtime/ffi).

## Standalone reservation candidate

`reservations.ts` exercises the proposed accounting bounds from #1170 in one
trusted, owned metadata namespace.
It uses the shipping nonblocking interprocess lock and restricted fsync/rename
JSON writer, with exclusive initialization separated from reopening.
Constructor validation and inspection share that same nonblocking lock with
writers; read-only operations do not rewrite the ledger.
Missing, malformed, nonprivate, oversized or inconsistent ledger state refuses;
it never initializes replacement accounting.
The namespace must remain trusted: the path-based lock and writer do not isolate
same-user replacement races and this is not a descriptor-confined journal.

The candidate reserves 10 MiB per file, 100 MiB per home, 128 artifacts per home,
32 per device and active counts of 2 per device, 4 per session and 8 per hub.
Charges round up to 4 KiB with a 4 KiB minimum.
Staged artifacts and failed cleanup retain byte and artifact charges.
Actual allocated file blocks can increase a retained charge; durable accounting
debt above the budget refuses new admissions.
Metadata overhead is not included in scratch file accounting.
`releaseAfterCleanup` depends on the caller's confirmed owned cleanup and does
not inspect or delete content files.
No automatic orphan deletion, crash recovery, tombstone, grant or transfer
authority is implemented or restored on restart.

`reservation-entry.ts` first executes the unchanged storage entry in a compiled
child role (`--reservation-storage`), then runs nine accounting groups for 36
total named groups.
The accounting groups cover rounding and owner admission; active saturation and
staged conversion; home bytes and retained cleanup; tiny artifact counts; actual
allocated-block debt and confirmed deletion before release; malformed/missing
ledger refusal; private-root replacement refusal; multiprocess/restart accounting;
and nonblocking lock contention.
The multiprocess group runs both a 10-by-10-MiB home race and three actual children
sharing one server-chosen device identity across connections, collectively limited
to two active tiny reservations.
All eight owned children must exit and be reaped.
The contention control performs an actual cooperating atomic rename, refuses
reads while its lock is held, then reopens the valid replacement successfully;
an actual malformed replacement still refuses both reopening and inspection.

For this slice, this explicitly supersedes item 3's private-copy integration in
the private `reservation-plan.md`.
The actual file creation/growth/deletion witness demonstrates reserve-before-create
and confirmed-delete-before-release at an owned fixture callsite.
That reservation entry does not integrate the ledger with `copyToPrivate`;
the separate trusted composition profile below exercises that next gate.
The PNG supplies only owned content bytes and is never decoded by this profile.
No production helper, handler, capability, wire field or native UI is selected.

```sh
python3 scripts/tunnel-storage-proof/reservation-matrix.py \
  --bun-1311 /path/to/bun-1.3.11 \
  --bun-current /path/to/bun-1.4.2 \
  --out /Volumes/S1/yooz/remi/artifacts/reservation-unique \
  --runtime-temp-base /Volumes/S1/yooz/remi/tmp \
  --linux-pids-limit 64 \
  --linux-arm64-image oven/bun:1.3.11 \
  --linux-x64-image oven/bun:1.3.11
```

The profile snapshots the complete daemon/shared source trees and storage-proof
source tree, plus root TypeScript/package/Bun configuration and the original
decoder `fixture.png` as an explicit embedded input.
Compilation uses the snapshot's real root `@remi/shared` aliases; there are no
codec or ambient dependency imports.
The receipt records exact source membership, types, hashes, input SHA-256,
executable hashes and executed commands.
Each execution reports the parent's memory sample in bytes at receipt time;
that sample is not a measured peak or a production resource bound.
The shared guard rechecks those exact trees and files before and after every
stage, including additions; `--invalidation-control` requires dependencies and
does not apply to this dependency-free profile.
Linux starts with a 256 MiB, 32-PID, one-CPU and 32 MiB tmpfs fixture, with network
disabled and the executable mount read-only.
These are proof runner resource fixtures, not a production resource contract.
The reservation profile's first Bun 1.3.11 Linux ARM run at the default 32 PIDs
aborted an owned child with exit 134.
An owned shell diagnostic reproduced it with `pids.peak` 32 and three PID denials,
while memory limit/OOM counters stayed zero.
A 128-PID diagnostic passed the unchanged 36-group binary with a measured PID
peak of 51; the diagnostic shell contributes one PID.
The command above therefore opts into a 64-PID fixture and keeps 256 MiB memory.
Six builds and six matching 36-group executions, unchanged input and successful
owned scratch/container cleanup are required for a complete receipt.

## Reserved private-copy composition

`reserved-copy.ts` composes the existing copy and reservation candidates in the
same trusted metadata namespace, without selecting a production helper.
It reserves before any private copy effect, stages the same-descriptor actual
allocated block charge before returning a handle, and deletes through the
captured private handle before releasing accounting.
Normal copy refusal confirms internal partial cleanup before refunding;
thrown cleanup failure retains quota and reports `cleanupConfirmed=false`.
Failed discard captures allocation from the same owned regular descriptor before
closing it, checking captured device/inode/owner and safe nonnegative blocks.
`PrivateCopyCleanupError` carries that measurement or `null`; the existing
`private cleanup failed` message is preserved.
Completed failure measures the still-held completed descriptor.
Unknown allocation retains `100 MiB + 4 KiB` of blocking accounting debt when
metadata retention succeeds. That debt refuses every fresh admission until
confirmed owned cleanup; it is neither an allocation measurement nor a physical
ceiling. Metadata failure remains visible and never silently refunds a record.
The same handle can retry failed completed cleanup or an accounting-only
failure after confirmed deletion.
Only actual nonblocking lock refusal before mutation has a proven retry path.
The restricted writer can commit its rename before a later acknowledgment fails:
`cleanupConfirmed=true` proves file deletion only, never whether metadata changed
or was durably acknowledged. An absent reservation remains unavailable.
Generic write acknowledgment recovery and idempotency remain a separate gate.

`reserved-copy-matrix.py` uses the same immutable repository snapshot and original
PNG bytes. Its entry preserves all 36 existing groups and adds seven actual
integration groups: success and preallocated blocks; full-home refusal before
copy effects; source growth and confirmed partial cleanup; completed unlink
failure and retry; partial unlink failure and explicit owned fixture cleanup;
captured-root replacement; and accounting contention/corruption after deletion.
At the native unlink boundary, the failure fixtures rename only the known owned
name after descriptor identity validation, then call the actual unlinkat on the
missing original. Completed retry restores that same name; partial cleanup
explicitly confirms the held fixture's identity before deletion/refund.
No ledger record is used to discover or authorize deletion.

The fixture-only fixed C wrapper invokes real Darwin `F_PREALLOCATE` or Linux
`fallocate(FALLOC_FL_KEEP_SIZE)` on the captured descriptor at the validated
checkpoint. It increases blocks without changing logical PNG bytes, which the
candidate then revalidates before publication. This is a discriminating owned
allocation witness, not a production preallocation policy.
Run the reservation command above with `reserved-copy-matrix.py` and a fresh
output path, preserving its explicit 256 MiB/64-PID resource fixture.
All six compiled pairs must report exactly 43 groups, unchanged source and
successful cleanup; 27-group and 36-group entries also retain compatibility runs.
Trusted metadata, same-user path replacement, metadata overhead, descriptor
journal/recovery, grant/transfer authority and production adoption limits remain.
The reserved-copy composition does not itself measure held-answer latency. A
separate standalone profile, `storage-approval-matrix.py`, adds that proof
without adding a production upload caller, selecting a helper, or changing the
existing 43 storage groups.

## Immutable journal and restart cleanup proof (#1440)

`recovery.ts` is a standalone prerequisite for #1170. It uses unchanged
reservation IDs, captured `DirectoryRoot` descriptors and three immutable 0600
markers: `<id>.intent`, `<id>.owned` and `<id>.cleaned`. An exact 32-character
lowercase hexadecimal ID generates `<id>.artifact`; no client filename or path
is admitted. Canonical marker reads are capped at 4 KiB. Roots require current
UID and exact 0700 mode; markers and artifacts require current UID, regular type,
one link and exact 0600 mode, including special permission bits.

Intent is fsynced before exclusive artifact creation, and artifact identity is
fsynced before returning a writable descriptor. Nonblocking OS flock holds the
exact intent descriptor through effects. Every native journal open adds
`O_CLOEXEC`; the proof checks actual descriptor flags, competing processes and
lock release after an observed SIGKILL. Roots, marker names and artifact identity
are rechecked at effects. These are sampled checks, not atomic protection against
every same-user race or a power-loss durability claim.

Recovery only reopens existing state. Missing owned witnesses, malformed or
incomplete immutable markers, unavailable roots, unexpected link/type/mode or
replaced names refuse cleanup. No incomplete marker is rewritten or retired.
Cleanup unlinks only the witnessed artifact, fsyncs its directory, then persists
and fsyncs a cleaned outcome. Exact ENOENT after durable ownership can finish
cleanup. An existing cleaned marker validates intent and owned markers and
requires exact ENOENT at the artifact name; any conflicting entry refuses.
A reopened intent never recreates an artifact. This records a cleanup
acknowledgment, not transfer or harness authority. Reservations remain charged
through confirmed journal cleanup; cross-ledger refund reconciliation is deferred
rather than inferred from pathname absence.

`recovery-matrix.py` requires the original 43 groups plus 18 recovery groups
(61 total). The independent `reserved-copy-matrix.py` default stays at 43. Five
real child processes stop at a checkpoint handshake and are SIGKILLed before
creation, after creation before witness, after witness, after unlink before
cleaned, and after cleaned before acknowledgment. Each owned child has bounded
4 KiB stdout and 8 KiB stderr, a deadline, an awaited exit and a post-exit ESRCH
check; failures retain their PID/exit/signal/byte-count log. Real filesystem
controls cover each marker's unknown fields, duplicate known keys, noncanonical
JSON, empty/truncated bytes, size/link/FIFO/mode/missing state, held name
replacement, both root replacements, artifact replacement, conflicting terminal
state and actual native unlink failure. Project and sibling marker bytes remain
unchanged, and every reservation remains charged. On the unprivileged Mac,
create fault evidence is EACCES; UID0 in the unchanged Linux fixture uses the
owned read-only `/proof` mount's EROFS. Journal root-mode refusal is checked
separately. No synthetic failure substitutes for either native syscall.

Use a fresh S1 output and the existing 256 MiB/64-PID resource fixture:

```sh
TMPDIR=/Volumes/S1/yooz/remi/tmp/srp PYTHONDONTWRITEBYTECODE=1 \
python3 scripts/tunnel-storage-proof/recovery-matrix.py \
  --bun-1311 /Volumes/S1/yooz/remi/cache/tools/bun-1.3.11-darwin-arm64 \
  --bun-current /opt/homebrew/Cellar/bun/1.4.2/bin/bun \
  --out /Volumes/S1/yooz/remi/artifacts/recovery-unique \
  --linux-arm64-image oven/bun@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 \
  --linux-x64-image oven/bun@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 \
  --runtime-temp-base /Volumes/S1/yooz/remi/tmp/srp \
  --linux-memory-mib 256 --linux-pids-limit 64
```

The short Mac canary adds `--canary-only`. Full acceptance requires all six
supported compiled target/Bun cells, matching source/artifact hashes and zero
cleanup errors. This profile does not rerun the 47-group held-answer measurement.

`recovery-mutations.py` reuses the strict compiled assertion receipt gate and
synthetic-success/setup rejection controls. Run its five semantic selectors
`ownership`, `current-root`, `schema`, `cleanup-outcome`, and `canonical-bytes`
on both `1311` and `current`:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/tunnel-storage-proof/recovery-mutations.py \
  --mutation ownership --bun-label 1311 \
  --source-root /Volumes/S1/yooz/remi/artifacts/recovery-unique/source \
  --bun-1311 /Volumes/S1/yooz/remi/cache/tools/bun-1.3.11-darwin-arm64 \
  --bun-current /opt/homebrew/Cellar/bun/1.4.2/bin/bun \
  --out /Volumes/S1/yooz/remi/artifacts/recovery-ownership-1311-unique \
  --linux-arm64-image oven/bun:1.3.11 --linux-x64-image oven/bun:1.3.11 \
  --runtime-temp-base /Volumes/S1/yooz/remi/tmp/srp
```

The schema mutation removes the unknown-field keyset guard. The canonical-bytes
mutation removes the shared predicate used by both parse and retained-descriptor
validation; it fails the duplicate-known-key refusal. Both original guards were
characterized against actual duplicate/noncanonical/truncated/empty marker bytes
on both compiled Mac Bun cells before this behavior-preserving extraction.
These controls test five semantics, not every individual check. Each must fail
its exact named assertion in a compiled Mac stack with a
completed nonzero runtime exit. Setup failure or assertion-looking successful
output is rejected as evidence. Production helper adoption, portable decoder
CPU/memory limits, native decoder startup #1417 and staging contract freeze
remain separate prerequisites.

## Journal quota settlement candidate (#1443)

`journal-settlement.ts` composes the standalone reservation and immutable journal
candidates. It selects no production helper, upload API or transfer authority.
Plain reservation rows and the strict top-level version-1 ledger are unchanged.
Journal rows bind a fresh 128-bit nonce, ledger directory identity, captured
scratch/metadata identities and exact generated marker inode/content witnesses.
The managed writer exposes only a lease, `write` and `close`; it holds the intent
flock until its owned writer descriptor closes. A close error latches failure,
refuses later writes/closes and retains the flock until process death. An explicit
standalone proof callback closes that actual descriptor to induce EBADF; it is
not a production import or simulated syscall result.

Admission charges the rounded declared artifact cost plus three 4096-byte marker
allowances. Actual owned allocated blocks raise accounting when larger; this is
accounting, not a physical allocation ceiling. Immutable identity compares marker
kind, device, inode and content hash independently of allocated-block measurement.
Ownership is committed before returning the managed writer. Missing ownership
binding refuses reconciliation rather than guessing from existing files.

Managed writes hold the same nonblocking home transaction through exact lease,
root, ownership and original writer-FD checks, precharge, real 64 KiB write chunks,
and post-write measurement/commit. Precharge is the monotonic maximum of observed
owned allocation plus marker allowances and rounded projected cumulative logical
bytes plus markers; it is durable before writes. Empty writes still account actual
owned preallocation. Observed/projected debt may exceed the home budget; subsequent
admissions refuse. This adds no public write threshold or physical ceiling.
An actual partial-write or post-measurement failure commits known charge or the
existing blocking debt before refusal. Uncertain effects latch failure and hold
the intent until death; busy refusal before effects remains retryable. The explicit
proof callback closes the owned FD after one real chunk, causing the next write
and original-FD measurement to fail with actual EBADF. The lost numeric FD is
never retried or substituted with a newly opened path FD.

Settlement holds the existing nonblocking per-home transaction through actual
cleanup, retirement-witness commit, intent flock acquisition, descriptor-relative
owned/cleaned/intent deletion (intent last), final exact artifact/marker absence
checks, metadata directory fsync and atomic settled-receipt commit. Persisted
retirement witnesses permit exact ENOENT after a partial crash. An absent intent
cannot be reopened for cleanup. A marker replacement, recreated name, unavailable
root/store or real unlink failure preserves debt and refuses settlement.
Settled receipts have zero charge and no ownership/retirement arrays. They consume
bounded history space but no device/session/hub artifact capacity. Admission
evicts only the oldest completed receipts to keep at most 128 combined rows and
256 KiB; unfinished rows never make room. An exact recent retry reports
`already_settled` without adopting or deleting a new artifact. Unknown/evicted
receipts, mixed IDs/nonces and copied home bindings refuse.

`settlement-matrix.py` preregisters 88 groups: the original 61 plus 27 settlement
groups. Separate `recovery-matrix.py` (61) and `reserved-copy-matrix.py` (43)
remain compatibility gates. The new groups cover actual allocation/refund and
historical retries; managed writer lifetime and actual close failure with FD reuse;
raw API refusal, mixed/injected nonces and missing ownership; current/recaptured
scratch, metadata and home identities plus copied ledgers; missing/corrupt/oversize
and malformed ledger states; ongoing write growth/admission saturation, empty
preallocation, busy retry and actual partial-write debt; each marker's schema/type/link/mode/content/absence
controls; real artifact/retirement unlink errors; every persisted witness before
effects; actual marker preallocation; marker recreation after unlink/fsync;
SIGKILL after witness commit, each of three marker unlinks, final metadata fsync
and settled commit before acknowledgment; real intent contention/death release;
parallel settlements/new admission; and exactly 130 complete cycles for one owner
(with history beyond the 32-device-artifact limit) with bounded
history, preserved pending debt, recent retries, evicted refusals and empty owned
artifact/marker namespaces.

Each owned child has an exact PID/checkpoint handshake, 4 KiB stdout/8 KiB stderr
limits, awaited exit/signal diagnostics and post-exit ESRCH. The shipping home
lock's stale policy is unchanged: a live owner and a freshly killed unaged owner
both cause busy refusal. Only after the lock's PID matches the actual owned dead
child and ESRCH is confirmed does the fixture explicitly age both `acquiredAt`
and file mtime. The nonblocking candidate still refuses that stale owner; the
fixture then explicitly invokes the shipping waiting-owner lock path once to
reclaim it before nonblocking reconciliation. This maintenance prerequisite is
not automatic stale recovery in settlement. It measures deliberate fixture
timestamp aging and real maintenance recovery, not a 30-second wall-clock stale
interval. Intent flock releases
immediately on death. The parallel fixture explicitly retries observed busy
refusals; candidate APIs never wait or silently queue.

Use an empty owned S1 `PYTHONPYCACHEPREFIX` with `PYTHONDONTWRITEBYTECODE=1`
for every Python command, isolating cache reads as well as writes. Earlier captured
cache artifacts are quarantined separately from source acceptance. Use fresh S1
output names; the canary runs only the two compiled Mac Bun gates:

```bash
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPYCACHEPREFIX=/Volumes/S1/yooz/remi/tmp/jsp/pycache-settlement-unique \
python3 scripts/tunnel-storage-proof/settlement-matrix.py \
  --bun-1311 /Volumes/S1/yooz/remi/cache/tools/bun-1.3.11-darwin-arm64 \
  --bun-current /opt/homebrew/Cellar/bun/1.4.2/bin/bun \
  --out /Volumes/S1/yooz/remi/artifacts/settlement-unique \
  --linux-arm64-image oven/bun@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 \
  --linux-x64-image oven/bun@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 \
  --linux-pids-limit 64 --runtime-temp-base /Volumes/S1/yooz/remi/tmp/jsp \
  --canary-only
```

Remove `--canary-only` for the six supported cells, preserving the same 256 MiB,
64 PID, one CPU and 32 MiB noexec Linux fixtures and immutable cached image pins.
`settlement-mutations.py` reuses the strict compiled named-assertion receipt gate
for `home`, `nonce`, `ownership`, `retirement-before-refund`, `history-bound`
and `ongoing-accounting`
on each Mac Bun gate. Its successful witness-looking output and setup-failure
controls must be rejected. The nested recovery support module also goes through
the shared immutable helper hash gate; an actual copied-source tamper must refuse
before mutation setup/build. Linux mutations are not claimed. Full gates,
independent review, source/artifact verification and publication are separate
acceptance steps.
No 47-group held-answer/R7/main runtime result is inferred from this candidate.

## Held-answer storage load proof

`storage-approval-entry.ts` combines the existing 36 reservation and seven
reserved-copy groups with a real held-hook load scenario. One owned child
repeatedly reserves and descriptor-copies a generated 10 MiB regular file with
the current `reserveAndCopy` composition. It compares private bytes against
the admitted source descriptor in fixed-size chunks, checks the digest, mode,
actual allocated blocks and ledger charge, then requires confirmed deletion
and an empty ledger before counting progress. No whole-file buffer, timer-only
load, transfer authority or recovery behavior is added.

An independent compiled client measures from its actual No send until it parses
the original `PermissionRequest` HTTP deny response. The normal scenario must
stay below 1,000 ms while the storage child makes real progress before and after
the denial. A synchronous parent CPU block overlaps a second client's send and
must make its measured answer exceed 1,000 ms; this calibrates the measurement
and does not claim that a production upload path blocks the daemon.

Before creating its held hook, the parent prepares the unchanged `openat.c`
snapshot with the separate proof-only `storage-approval-native.c` wrappers.
On macOS, `xcrun` resolves the actual compiler and SDK; the receipt records the
launcher, compiler and SDK identities, both source hashes, the library hash,
the exact compile command and setup duration. Linux uses the official
`golang` 1.26.8 Trixie compiler image pinned by index
`sha256:0f063af2d465d8dcae54cce04278ada488b96f77b42449c8d071e47d016cc65a`,
with ARM64 manifest `sha256:4364967143356b3498a4bcec1f1a2a2129495333f85f8f05b4e4dbb9ef70d287`
and AMD64 manifest `sha256:af00f232205a01baf323bddc5bb4a4ea2e4cbf49e8ccc988beb2558d0f9c882a`.
The parent verifies the local root index ID and its selected platform child ID
before creating a compiler container. The compiler container runs with no
network, no image pulls, a read-only root, one CPU, 512 MiB, 64 PIDs and 32 MiB
tmpfs. It mounts only the frozen C inputs read-only and one owned S1 output
directory. Its receipt keeps the root index ID, selected platform manifest
digest and the actual Docker container inspect `.Image` value as distinct
fields. The `.Image` value must match the root index ID; architecture comes
from the separately verified platform manifest, compiler target, `uname` and
ELF machine. The receipt also records compiler path, version, target and binary
hash, libc version, source hashes, exact command, dependencies, GLIBC symbol
requirements and library hash. The S1 packager embeds those bytes and metadata
in the derived proof source; the runtime never accepts a library path or
invokes a compiler.
Each compiler run gets a unique container name, a host-side CID file outside
the writable mount, and a private lifecycle receipt. Its `finally` cleanup is
bounded to 20 seconds and removes a container only after its ID, name, image
and private run labels match that receipt; both ID and name absence are then
checked. An unverified cleanup remains a failed preparation with its receipt
and logs retained. The lifecycle has been exercised for both Linux compiler
architectures; final six-cell matrix and mutation acceptance remain separate
gates.
The parent derives the asset from its own platform and architecture, verifies
the manifest/source/library hashes, copies it into its owned 0700 fixture
directory and checks identity before the child loads it through one FFI table.
The wrappers forward the same descriptor-relative `openat`, `linkat` and
`unlinkat` calls with their original flags and return values. Helper
preparation stays outside the measured worker lifetime, which remains bounded
from child spawn to reap at 5,000 ms. This is proof packaging only; no production
upload or helper is adopted.

For this profile only, the Linux runner mounts its existing 32 MiB `/tmp` fixture
as executable so the worker can `dlopen` the hash-verified helper from its owned
private temporary directory. The matrix receipt records the exact tmpfs option.
Other profiles keep the shared runner's existing `/tmp:rw,nosuid,size=32m`
argument. CPU, memory, PID, tmpfs size, network, read-only root and pull limits
are unchanged; executable tmpfs is a proof-fixture requirement, not a production
helper or upload capability.

The held-answer proof reuses the production `HookServer`, `AutoApproveGate`,
`createInputHandlers` and `PTYSession` through the same local seam as #1411. A
real `/bin/cat` baseline and post-answer barriers require two marker copies and
75 ms of quiet, then compare the bytes through actual child reap. An intentional
wrong PTY write must invalidate the zero-byte assertion. The worker output and
lifetime are bounded, the worker is one-at-a-time with no queue, and cleanup
removes only the owned fixture root after all owned children are reaped.

The matrix adds four named groups to the unchanged 43 storage groups. Its
private-source controls must fail the actual-copy, actual-denial and zero-PTY
witnesses. First run the Mac canary to freeze the corrected source, then prepare
the Linux support assets from that S1 source snapshot. The packager writes all
generated source, libraries, logs and receipts under S1; it never pulls images.

```sh
uv run python scripts/tunnel-storage-proof/storage-approval-matrix.py \
  --canary-only \
  --bun-1311 /path/to/bun-1.3.11 \
  --bun-current /path/to/bun-1.4.2 \
  --runtime-temp-base /Volumes/S1/yooz/remi/tmp \
  --out /Volumes/S1/yooz/remi/artifacts/storage-approval-mac-canary

uv run python scripts/tunnel-storage-proof/storage-approval-prepare-linux.py \
  --source-root /Volumes/S1/yooz/remi/artifacts/storage-approval-mac-canary/source \
  --out /Volumes/S1/yooz/remi/artifacts/storage-approval-linux-helper
```

Then pass the packager's `source/` output to the full matrix. It requires this
owned S1 source root; the final Bun runtime containers keep the pinned
no-network images and existing limits. For all four Linux executions, the
approval wrapper first resolves each caller-selected image locally and checks
the original Bun 1.3.11 index and per-platform IDs below. It writes a bounded
inspect-only receipt beside the requested output as
`<out>-linux-image-profile.json`. If the first successful platform inspection
returns the already verified parent index ID, the wrapper makes one identical
metadata read and records both responses. It still requires the exact pinned
platform child ID and OS/architecture; any other ID or a second mismatch is
rejected. This is bounded to two reads for that platform inside the same
preflight deadline. The wrapper then passes the immutable accepted index ID to
the unchanged matrix runner. The container image supplies the Linux fixture
environment; each compiled artifact carries and checks the Bun runtime used
to build it.

```sh
uv run python scripts/tunnel-storage-proof/storage-approval-matrix.py \
  --source-root /Volumes/S1/yooz/remi/artifacts/storage-approval-linux-helper/source \
  --bun-1311 /path/to/bun-1.3.11 \
  --bun-current /path/to/bun-1.4.2 \
  --out /Volumes/S1/yooz/remi/artifacts/storage-approval-unique \
  --linux-arm64-image oven/bun:1.3.11 \
  --linux-x64-image oven/bun:1.3.11 \
  --runtime-temp-base /Volumes/S1/yooz/remi/tmp \
  --linux-memory-mib 512 \
  --linux-pids-limit 64
```

The six required compiled executions are Apple Silicon Mac, Linux ARM64 and
Linux x64 on Bun 1.3.11 and 1.4.2. Both Linux architectures use the original
locally pinned Bun 1.3.11 image index
`sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7`,
with ARM64 platform image ID
`sha256:06bd53b80989da758c8d2995ba711733090caf688bab09e7d4b21c6c8df728b7`
and AMD64 platform image ID
`sha256:38919894db4e117a37f74e3dca503e84f24d97f19cabc5f499a289c2a5d0db7c`.
The wrapper rejects a selected local image unless both its index and requested
platform match those pins, then passes the immutable index ID to the matrix.
The Bun 1.4.2 AMD64 child is not needed for this profile; the 1.4.2 compiled
artifact supplies its own Bun runtime. Linux is one CPU, 512 MiB, 64 PIDs and
32 MiB tmpfs in the fixture runner; those values are not portable production
limits. The compiled receipts bind the source snapshot and executable hashes.
The matrix uses `--pull=never` and stops if either pinned local platform is
absent.
No held-answer latency claim is accepted until the named groups, private-source
controls, cleanup and all six matching runtime executions pass on one immutable
source snapshot.

Run the private-source controls against the `source/` snapshot from a passing
matrix build. Each command makes a separate private mutated copy and exits
successfully only after a completed compiled runtime exits nonzero with the
exact named `AssertionError` and a compiled-proof stack frame. A successful
control that prints the same assertion-looking witness text, and a setup-failure
control with a nonzero exit and the same text, must both be rejected by receipt
acceptance:

```sh
uv run python scripts/tunnel-storage-proof/storage-approval-mutations.py \
  --mutation actual-copy \
  --bun-label 1311 \
  --source-root /Volumes/S1/yooz/remi/artifacts/storage-approval-unique/source \
  --bun-1311 /path/to/bun-1.3.11 \
  --bun-current /path/to/bun-1.4.2 \
  --out /Volumes/S1/yooz/remi/artifacts/storage-approval-copy-mutation \
  --linux-arm64-image oven/bun:1.3.11 \
  --linux-x64-image oven/bun:1.3.11 \
  --runtime-temp-base /Volumes/S1/yooz/remi/tmp
```

Repeat with `--mutation actual-denial` and `--mutation zero-pty`, each with a
fresh output path. For every mutation, run once with `--bun-label 1311` and once
with `--bun-label current`, using a fresh output path each time. The mutation
runner selects only that label's compiled Mac cell and records its requested and
resolved executable, binary hash, observed Bun version, build command and
runtime version from the failure log. Normal matrix runs still execute both Bun
versions. These private negative controls do not edit the worktree source or
replace the restored-source six-execution matrix.

Independent review added an actual excess-allocation partial refusal control:
the original published adapter retained 8,192 bytes for a 24,576-byte owned
orphan after source growth and real native unlink failure.
The preserved original failure is
`reserved-copy-excess-partial-control/current.log` in the private sprint artifacts;
its exact assertion is `failed partial retains actual allocated block charge`.
The partial group now includes that control and an actual descriptor closure/reuse
case proving unknown allocation retains blocking debt without a path fallback.
The group count remains 43; original 27/36 compatibility profiles remain required.

## Admission checkpoint (2026-10-10)

All six supported compiled executions passed the sixteen controls on Bun 1.3.11
and 1.4.2: Apple Silicon Mac natively, Linux ARM64 in Docker's VM, Linux x64 under
Docker Desktop emulation. Twelve private guard variants on compiled Mac ARM each
failed their exact expected assertion on both Bun gates (24/24): hidden components,
credential path, credential directory/root identity, regular-file type,
link count, initial size, name identity, no-follow flags, credential case folding
current configured-directory refresh and retained lookup snapshots. Mutation execution
on Linux was not measured. This proves those controls detect the named guard
removals; it does not prove every race or private-copy mutation is detected.

The initial private mutation runner failed compiling Bun 1.4.2 before running
its variant because its compiler working directory equaled TMPDIR. The unchanged
baseline reproduced that EEXIST failure; separating the two directories passed.
The checked-in matrix already keeps them separate. A later mutation-selector
ambiguity also stopped the private runner; neither failure counted as a detected
mutation. Failed receipts remain under the private `remi-1170-admission-mutations`
20261010 `-a`/`-b`/`-c` directories. The earlier complete `-d` receipt has nine
variants; the review correction adds actual
replacement case/normalization aliases and the current-directory refresh guard
in `-e`/`-f`. The final `-f/combined-receipt.json` contains 22 independently
hashed failures at the earlier checkpoint. It excludes the initial case-fold variant whose assertion
witness did not match; removing both folds then caught the intended alias control.
The ASCII-only fix alone was not adopted.

Independent review then found a snapshot-lifetime race and four assertions whose
messages had only matched by substring. The final matrix is in
`/private/tmp/remi-1170-admission-20261010-g/receipt.json`; its mutation receipt
is `/private/tmp/remi-1170-admission-mutations-20261010-g/receipt.json`.
All 24 final failures match the exact `AssertionError` message, and the original
identity variants preserve current replacement guards to reach their own controls.
The earlier four misattributions are excluded from this final acceptance.
