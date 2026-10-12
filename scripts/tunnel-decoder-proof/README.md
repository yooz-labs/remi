# Decoder admission and child lifetime proof (#1170)

This preserves the existing private pngjs 7.0.0 / jpeg-js 0.4.4 candidate.
No daemon dependency, handler or capability is selected. Header admission is
not pixel validation: the candidate must also fully decode and agree with the
admitted dimensions and RGBA length. Ten control groups alter actual owned PNG
and JPEG bytes, checking input/dimension bounds, PNG structure/animation/methods,
JPEG frames/tables/scans/ending and full-decoder CRC/entropy refusal.

Three palette groups enforce PNG's normative PLTE rules before full decoding:
one palette, before the first IDAT, 1–256 entries in complete RGB triples, only
for color types 2/3/6, and an indexed palette no larger than its legal bit depth
allows. Indexed images require that palette. These are PNG format rules
([PLTE](https://www.w3.org/TR/png-3/#11PLTE) and
[chunk ordering](https://www.w3.org/TR/png-3/#5ChunkOrdering)), not a selected
resource policy. Valid-CRC byte mutations isolate each refusal. Legal suggested
palettes are attached to pinned pngjs truecolor encodings of the exact owned
icon pixels; tiny indexed encodings use two actual pixels from that icon.
Every legal case fully decodes, and results retain derived input/pixel hashes
separately from the unchanged original fixture hashes.

The unchanged admission accepted a 771-byte palette (257 entries) and duplicate
legal palettes; actual pngjs constructed 257/416 palette entries while preserving
the original icon pixels. The correction prevents that palette accumulation
path. Aggregate chunk/JPEG metadata counts, allocation/CPU budgets and a whole
process memory ceiling remain separate open gates.

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

The controller records each owned child's PID, exit code, signal and elapsed
time only after awaiting its exit (#1417). Proof receipts include that metadata
for the existing success, refusal, deadline, cancellation, output-fault and
result-race controls. Exit records never contain decoder input, output content
or stderr. An unexpected refusal assertion records the same bounded metadata
before failing. Recording a crash does not recover it or relax a threshold.

On macOS 27.0.1 (26A434), a retained Bun 1.3.11 worker produced 99/100 exact
CRC refusals in a bounded diagnostic; one launch exited 133/SIGTRAP in about
3.99 ms with no output. Its crash report stopped in
`pthread_jit_write_protect_np +388`, matching the failure class documented in
[Bun #42687](https://github.com/oven-sh/bun/issues/42687).
The retained Bun 1.4.2 control produced 100/100 exact refusals in that finite
diagnostic. Neither count establishes stability or a production failure rate.
Older matching reports coincide with the failed CRC and cancellation matrix
windows, but those receipts omitted child PIDs, so exact per-request linkage
remains unproved. Native startup availability and portable resource enforcement
remain adoption gates; there is no automatic retry or host security/signing change.
The standalone child interpreter policy below changes only disposable decoder
worker environments.

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

## Disposable worker interpreter policy (#1417)

`process.ts` uses one private environment builder for both one-shot and repeated
decoder children. It supplies only the existing PATH/LANG/TMPDIR whitelist plus
`BUN_JSC_useJIT=0`; it does not inherit parent tuning or application credentials,
modify the parent environment, or change constructor/outcomes/caps/deadlines.
The setting takes effect before child initialization. Retained workers on both
pinned Bun versions reported effective `useJIT=false`, and each interpreter and
default mode passed 100 actual serial CRC refusals in that finite diagnostic.
Those 402 diagnostic children were awaited and ESRCH-confirmed. These observations
do not establish general startup stability or repair the historical SIGTRAP.

One new controller-owned policy group runs before ordinary child lifecycle
controls. An actual child exits 23 before decoding if interpreter mode or parent
environment isolation is violated. Successful children fully decode the original
PNG once and JPEG repeatedly, with exact original pixel hashes. The parent sets
owned JSC tuning and an application sentinel, verifies both are excluded from the
worker and remain unchanged in the parent, then restores those fixture variables.
Receipts record actual bounded exit metadata and ESRCH; no decoder result or
readiness is substituted. Existing five-second maximum lifetime, 1000 ms held
response and two-second reap thresholds stay unchanged.

The default profile now has 19 groups, retaining its original 18; the held profile
has 22, retaining its original 21. Linux limits remain the original 256 MiB/32 PID
default and 512 MiB/64 PID held fixtures. Portable CPU/resident-memory enforcement,
production decoder selection and transfer authority remain separate gates.

`policy-mutations.py` reuses the shared strict compiled assertion predicate and
source-bound real support modules. Removing the shared interpreter setting must
fail the named parent assertion and also produce exactly one actual one-shot
child exit 23, no signal, a positive PID, finite elapsed time within 5000 ms and
awaited/reaped ESRCH metadata. Unrelated SIGTRAP, input faults, setup failures or
successful witness-looking output cannot be accepted. The existing base false
controls remain unchanged and are explicitly control-only. Both copied codec
trees retain exact pinned versions and full membership/file hashes.

Use an empty owned S1 `PYTHONPYCACHEPREFIX` and `PYTHONDONTWRITEBYTECODE=1` for all
Python loaders. New source/dependency snapshots, binaries, temporary files and
logs stay on S1. Run each profile with `--canary-only` on both Mac Buns before
the same immutable source is executed on all six supported platform/Bun cells.

```sh
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPYCACHEPREFIX=/Volumes/S1/yooz/remi/artifacts/decoder-policy-unique/pycache \
python3 scripts/tunnel-decoder-proof/approval-matrix.py \
  --bun-1311 /Volumes/S1/yooz/remi/cache/tools/bun-1.3.11-darwin-arm64 \
  --bun-current /opt/homebrew/Cellar/bun/1.4.2/bin/bun \
  --node-modules /path/to/pinned/standalone/node_modules \
  --out /Volumes/S1/yooz/remi/artifacts/decoder-policy-unique/held \
  --runtime-temp-base /Volumes/S1/yooz/remi/tmp/dwp \
  --linux-arm64-image oven/bun@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 \
  --linux-x64-image oven/bun@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 \
  --linux-memory-mib 512 --linux-pids-limit 64
```

Use `matrix.py` with 256 MiB/32 PIDs for the default profile. For each Mac Bun,
run `policy-mutations.py --mutation interpreter-policy --bun-label 1311` (or
`current`) with the same compiler/image/dependency/temporary flags, an immutable
repository `--source-root` snapshot and a fresh output directory. Final worker
option diagnostics are separate finite observations. No production caller or
helper is selected by these standalone proofs.

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
Portable hard CPU/memory budgets, production-helper selection and upload
authority remain later gates. The wall watchdog does not enforce a resident-memory
ceiling or a kernel CPU budget.

## Held-approval continuation

`approval-matrix.py` extends the 19 decoder groups (including the three palette
groups) with three source-backed
checks: PNG and JPEG decode load while a phone-shaped No answer reaches the
original held `PermissionRequest` HTTP response, plus a synchronous 1200 ms
parent-event-loop block that must make the independently measured deny exceed
1000 ms. Each ordinary answer must complete within 1000 ms on every supported
execution. The independent client child starts its original loopback HTTP hold
before readiness; it starts timing only when it sends No and stops after it
parses the original deny JSON.

The fixture constructs the real `HookServer`, `AutoApproveGate`,
`SessionRegistry`, `/bin/cat` `PTYSession`, message API, session stores and
`createInputHandlers`. An owned loopback adapter validates the expected session,
question and `No.value`, then calls the real `relayAnswer`. The hook body uses
the inert command `echo REMI_TUNNEL_APPROVAL_PROOF`; no Claude or real remote
request runs. Every case checks the delivered outcome, deny response, cleared
hold and card, empty `/bin/cat` output, same-value duplicate reporting without
a second resolution effect, and a conflicting answer reported as stale. This
matches `ResolvedAnswerCache`: a successful duplicate is acknowledged as
delivered; a conflicting or unknown answer remains stale. It then cancels
and reaps the repeated decoder child and decodes exact pixels through the same
controller.

The compiled entry repeats actual full PNG/JPEG decodes inside one owned child.
Before readiness, the child has decoded twice and the parent verifies exact
dimensions and pixel hash; the child continues decoding until parent
cancellation or its five-second deadline. This proves approval responsiveness
for this candidate fixture only. It does not establish production integration,
portable CPU or memory enforcement, decoder selection, or transfer authority.

Each approval result records the independent client's send and deny-parse Unix
timestamps with its monotonic latency. The blocking control also records the
parent block start, client send, end and monotonic duration. Linux runs record a
cgroup PID and memory sample while the card, decoder and client are live; macOS
reports those cgroup values as unavailable. Receipts list the owned PTY, client,
repeated-decoder and recovery-decoder PIDs and confirm each was reaped.

The `/bin/cat` PTY drain uses an inert marker line with a leading newline and a
trailing newline. The leading newline releases any earlier canonical input; the
trailing newline releases the marker line. The proof first records the actual
terminal-driver echo plus `/bin/cat` echo on that host, then compares output
after the answer against that observed pattern after both marker copies arrive
and the stream stays quiet for 75 ms (within a two-second barrier deadline).
This handles CR/LF and echo details from the real PTY
instead of assuming a fixed byte pattern. Receipts separate those deliberate
barrier bytes from zero answer-path bytes. A private control writes the No value
directly to an isolated inert `/bin/cat` PTY and proves the same output assertion
rejects it; no handler result or spy is substituted.

The approval matrix snapshots all files, directories and hashes under
`packages/daemon/src`, `packages/shared/src` and the decoder proof scripts,
plus root `tsconfig.json` and package metadata. Candidate codec dependency trees
are captured separately. It compiles from that snapshot and refuses an added,
deleted or changed entry before a build and after every execution. The optional
`--invalidation-control` runs four owned-copy controls: add a source-tree file,
add a nested entry, add a candidate-dependency file, and replace an explicitly
captured metadata file with a symlink to identical bytes. Each change must be
rejected before the guarded command launches, and the owned snapshot is restored
before compilation continues.

The extra client and decoder processes need a 512 MiB Linux Docker fixture and
a 64 PID cap for this proof. Use `--linux-memory-mib 512 --linux-pids-limit
64`; the shared runner defaults remain 256 MiB and 32 PIDs for the existing
decoder and storage matrices. Both overrides are approval-fixture capacity, not
portable resource acceptance.

The shared runner can take `--runtime-temp-base` when its artifact path would
make a Unix-domain socket path too long on macOS. It creates one short owned
scratch directory there, records it in the receipt and removes it after the
child processes exit. The option has no default and does not change the storage
or decoder runner defaults.

Run the local Apple Silicon canary first, then the full six-build/six-execution
matrix (both Bun versions across Apple Silicon Mac, Linux ARM64 and Linux x64):

```sh
uv run python scripts/tunnel-decoder-proof/approval-matrix.py \
  --canary-only --invalidation-control \
  --bun-1311 /path/to/bun-1.3.11 \
  --bun-current /path/to/current-bun \
  --node-modules /path/to/standalone/node_modules \
  --out /Volumes/S1/yooz/remi/artifacts/2026-10-11-sprint/decoder-approval-canary \
  --runtime-temp-base /Volumes/S1/yooz/remi/tmp \
  --linux-arm64-image oven/bun:1.3.11 \
  --linux-x64-image oven/bun:1.3.11 \
  --linux-memory-mib 512 --linux-pids-limit 64

uv run python scripts/tunnel-decoder-proof/approval-matrix.py \
  --invalidation-control \
  --bun-1311 /path/to/bun-1.3.11 \
  --bun-current /path/to/current-bun \
  --node-modules /path/to/standalone/node_modules \
  --out /Volumes/S1/yooz/remi/artifacts/2026-10-11-sprint/decoder-approval-full \
  --runtime-temp-base /Volumes/S1/yooz/remi/tmp \
  --linux-arm64-image oven/bun:1.3.11 \
  --linux-x64-image oven/bun:1.3.11 \
  --linux-memory-mib 512 --linux-pids-limit 64
```
