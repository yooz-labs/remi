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
The receipt reports actual alias modes, rather than assuming every filesystem
provides them. ASCII case aliases also refuse lexically before native opens.
The corpus confirms a sibling prefix remains readable.
Replacement checkpoints run after actual native opens and perform real renames;
they do not substitute filesystem calls or metadata.

This is a packaging/admission experiment. Private-copy validation, detected
growth/truncation/mutation, reservations, recovery and transfer lifecycle remain
subsequent work. Name revalidation is not an atomic snapshot and does not prove
that every concurrent edit was detected. Bun's compiler/FFI APIs remain candidate
mechanisms; no production helper has been selected.
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
The scope of a 6/6 execution result is seven primitive and nine admission controls.
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
The runner records the compiler versions, checks all sixteen named controls,
and refuses to advance if its source changes during a run. Mac binaries run
from a newly created empty working directory to check their embedded source.
Compilation uses a captured source snapshot and a private working directory;
compiler caches stay beside the retained evidence, outside the checkout.
Missing or unreadable source invalidates the final receipt. A failed Docker
cleanup is recorded with the owned container name for a later retry.

API references: [Bun C compiler](https://bun.sh/docs/runtime/c-compiler)
and [Bun FFI](https://bun.sh/docs/runtime/ffi).

## Admission checkpoint (2026-10-10)

All six supported compiled executions passed the sixteen controls on Bun 1.3.11
and 1.4.2: Apple Silicon Mac natively, Linux ARM64 in Docker's VM, Linux x64 under
Docker Desktop emulation. Eleven private guard variants on compiled Mac ARM each
failed their expected assertion on both Bun gates (22/22): hidden components,
credential path, credential directory/root identity, regular-file type,
link count, initial size, name identity, no-follow flags, credential case folding
and current configured-directory refresh. Mutation execution
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
verified named failures. It excludes the initial case-fold variant whose assertion
witness did not match; removing both folds then caught the intended alias control.
The ASCII-only fix alone was not adopted.
