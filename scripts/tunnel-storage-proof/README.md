# File storage packaging spike (#1170)

This reproduces the existing T0 experiment from `docs/FILE-TUNNEL.md`.
The probe uses only newly created temporary files and closes its descriptors.
The C source is embedded in the compiled executable, then materialized into
a private temporary directory for Bun's experimental C compiler.
The native `openat` address is resolved explicitly; its variadic creation
call is made through a fixed C wrapper.

The seven existing primitive controls cover exclusive creation/publication,
same-descriptor inspection/read, invalid components, leaf/ancestor symlinks,
hardlinks and cleanup through a captured directory after path replacement.
This is a packaging experiment. Full race/credential/nonregular-file controls,
reservations, recovery and transfer lifecycle are subsequent T0a work.
No helper or decoder is selected for production by this spike.

## Run

Use the project's Bun 1.3.11 pin and the installed current Bun.
Supply existing Docker image references with suitable Linux runtimes; the
runner uses `--pull=never` and records the executable's actual architecture.
Linux execution requires Docker's platform-specific image inspection support.
The runner resolves a tag once to a local immutable image/index ID, inspects
the requested platform through that ID, then executes the same ID with the
explicit platform. Both the runnable ID and selected platform's ID are recorded.
With Docker's containerd store, a platform inspection can report a configuration
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

`--skip-mac-x64` records those executions as missing and exits 2.
It never makes a partial matrix pass. Mac x64 execution needs an Intel Mac
or an already configured Rosetta runtime; this tool installs neither.
On an Intel Mac, Mac ARM executions are recorded as unavailable; that run
can supply Mac x64 evidence but still has an incomplete matrix.
The scope of an 8/8 execution result is these seven primitive controls.
`--build-only` prepares all eight executables, records their hashes and exits 2
with every runtime execution explicitly unmeasured.

## Receipts

`receipt.json` records source and executable hashes, commands, exits and
the probe's reported Bun/platform/architecture. Each stage has a retained
log and a 120-second deadline. Docker writes this run's container ID into
a fresh cidfile; failure cleanup removes only that ID, never a name whose
creation failed. All other containers are untouched.
The child environment selects PATH, LANG and the private temporary directory;
it does not replace HOME or pass the parent's credential variables.

The output must report eight successful builds and eight matching runtime
executions before `complete` is true. A build alone proves no execution.
Missing or mismatched probe output fails the stage.
The runner records the compiler versions, checks the seven named controls,
and refuses to advance if its source changes during a run. Mac binaries run
from a newly created empty working directory to check their embedded source.
Compilation uses a captured source snapshot and a private working directory;
compiler caches stay beside the retained evidence, outside the checkout.
Missing or unreadable source invalidates the final receipt. A failed Docker
cleanup is recorded with the owned container name for a later retry.

API references: [Bun C compiler](https://bun.sh/docs/runtime/c-compiler)
and [Bun FFI](https://bun.sh/docs/runtime/ffi).
