# Decoder admission and child lifetime proof (#1170)

This preserves the existing private pngjs 7.0.0 / jpeg-js 0.4.4 candidate.
No daemon dependency, handler or capability is selected. Header admission is
not pixel validation: the candidate must also fully decode and agree with the
admitted dimensions and RGBA length. Ten control groups alter actual owned PNG
and JPEG bytes, checking input/dimension bounds, PNG structure/animation/methods,
JPEG frames/tables/scans/ending and full-decoder CRC/entropy refusal.

Five additional groups construct real owned child processes. The worker fully
decodes the same PNG/JPEG pixels and returns only dimensions, byte count and hash.
Each controller permits one child, refuses saturation before spawning, limits
results to 4 KiB, and owns a maximum five-second wall deadline. Cancellation,
overflow, malformed/duplicate/mismatched results and child failure refuse; the
slot is released only after actual child exit. A cancelled result is discarded.
Successful decoding through the same controller follows the one-second busy
deadline, explicit cancellation, output/exit faults and result-race controls.
The 300 ms cold-start case checks reaping without a subsequent decode.
This is per-controller concurrency, not the later per-home reservation budget.

The first 300 ms busy-child readiness assertion failed on emulated Linux x64:
an unchanged child needed about 494 ms to start. The short whole-lifetime
deadline remains a separate control; the observed busy-child deadline is one
second. Each must return with its child reaped within two seconds. Explicit
cancellation is tested after the child records its actual CPU/result boundary.
The original failure is preserved; the controller's five-second maximum was
not increased. These are proof parameters, not a frozen production contract.

The PNG is the owned Remi icon from the earlier private candidate. The JPEG is
re-encoded from those same pixels using jpeg-js 0.4.4 at quality 85. `inputs.json`
pins both byte hashes and decoded dimensions/pixel hashes. The earlier JPEG
fixture and valid-sample receipts remain historical private evidence.

The synchronous interlaced branch of pngjs 7.0.0 calls `zlib.inflateSync` without
an output limit; this candidate refuses interlace before decode. This is a
candidate subset, not a production format contract. Malformed-header admission
does not prove bounded decoder allocations or complete format validity.

## Reproduce

Install the standalone pinned `package.json`/`bun.lock` in an owned directory,
then provide its `node_modules`. Do not add these candidates to daemon dependencies.
The matrix verifies both package versions, snapshots and hashes all dependency
files, embeds owned image inputs, and invokes the shared supported-host runner.
It builds/runs Apple Silicon Mac and Linux ARM64/x64 on both Bun versions,
with the same immutable-image handling, owned-container cleanup, deadline and
empty runtime working directory as the storage proof.
Linux Docker's 256 MiB limit is an execution fixture, not portable decoder
resource acceptance; Mac execution has no equivalent hard memory limit here.

```sh
uv run python scripts/tunnel-decoder-proof/matrix.py \
  --bun-1311 /path/to/bun-1.3.11 \
  --bun-current /path/to/current-bun \
  --node-modules /path/to/standalone/node_modules \
  --out /private/tmp/remi-decoder-proof-unique \
  --linux-arm64-image oven/bun:1.3.11 \
  --linux-x64-image oven/bun:1.3.11
```

Missing builds/executions or changed source/dependencies fail the matrix.
`--build-only` remains incomplete. Notices for the candidate packages are in
`THIRD-PARTY-LICENSES.txt`; compiled proofs remain private local artifacts.
Portable hard CPU/memory budgets, actual held-approval responsiveness,
production-helper selection and upload authority remain later gates. The wall
watchdog does not enforce a resident-memory ceiling or a kernel CPU budget.
The proof never constructs a permission gate and does not claim that coverage.
