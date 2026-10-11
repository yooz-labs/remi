# File storage packaging spike (#1170)

This reproduces the existing T0 experiment from `docs/FILE-TUNNEL.md`.
The probe uses newly created temporary content files and closes its descriptors.
Its nonregular-file control also opens `/dev/null` for metadata inspection;
it reads no device bytes and creates no device.
The C source is embedded in the compiled executable, then materialized into
a private temporary directory for Bun's experimental C compiler.
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
No storage-load held-answer latency claim is made by this composition.

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
