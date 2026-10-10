# Decoder admission proof (#1170)

This preserves the existing private pngjs 7.0.0 / jpeg-js 0.4.4 candidate.
No daemon dependency, handler or capability is selected. Header admission is
not pixel validation: the candidate must also fully decode and agree with the
admitted dimensions and RGBA length. Ten control groups alter actual owned PNG
and JPEG bytes, checking input/dimension bounds, PNG structure/animation/methods,
JPEG frames/tables/scans/ending and full-decoder CRC/entropy refusal.

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
Process CPU/memory/deadline budgets, cancellation/concurrency, actual held-approval
responsiveness, production-helper selection and upload authority remain later gates.
