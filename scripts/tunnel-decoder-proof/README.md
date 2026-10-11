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
Portable hard CPU/memory budgets, production-helper selection and upload
authority remain later gates. The wall watchdog does not enforce a resident-memory
ceiling or a kernel CPU budget.

## Held-approval continuation

`approval-matrix.py` extends the original 15 groups with three source-backed
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
`--invalidation-control` exercises source, entry and dependency additions in
the owned snapshot and confirms the next command is not launched.

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
