# Bounded read-only screen qualification (#1608)

2026-10-22. Continuation of the [original characterization](terminal-screen-characterization.md).
The owner approved qualifying 1 MiB per session and 32 models/32 MiB per home after the original 256 KiB gate failed.
The original failure remains valid and preserved; the geometry, 32 KiB text and 64 KiB frame limits were not raised.

## Selected component and scope

Select exact `@xterm/headless` 6.0.0 behind `packages/daemon/src/terminal/screen.ts`, under [ADR0046](../.context/decisions/0046-bounded-read-only-terminal-screen.md).
The production CLI does not import or construct it yet.
This PR introduces no terminal route, registry message, capability, grant, view lease, home reservation or native pane.
It has no PTY input, process, file, URL, clipboard or network reference.
A caller supplies existing local geometry/output; a returned snapshot is a complete immutable monochrome viewport, never an ANSI tail or transcript.

The dependency's proposed buffer API requires `allowProposedApi`; the version and Unicode-6 table are pinned.
The upstream JavaScript is unchanged, SHA-256 `17a90b650cf6b77cce2b98c4063884d43545e4ce177a54b76ccfc906f1aacaed`.
The published tarball omits its license file: the Bun patch adds only the exact upstream MIT `LICENSE`, and the bundle-notices test constructs a bundle of the actual screen entrypoint.
This is a daemon dependency, not a native dependency or a change to the Apache/commercial package boundary.

## Admission and failure behavior

- Geometry: 2–240 columns, 1–60 rows; no scrollback. One column is unavailable because the pinned emulator clamps it to two.
- At most 64 KiB copied input and eight owned operations including the active write. Each parser slice is at most 2 KiB, with a yield between slices and a 250 ms write-callback deadline.
- Escape packets at most 128 bytes; known ignored OSC metadata at most 16 KiB. Unsupported controls/graphics, malformed UTF-8, cancelled metadata and misleading display controls retire the observer.
- Lifetime cumulative joining input at most 2 KiB, each visible cell at most 64 UTF-8 bytes, each buffer at most 32 KiB text. The cumulative bound covers strings retained in overwritten private line maps; REP is refused after any joining input because it could multiply that state.
- Per-slice terminal work is charged before emulator dispatch, including clears, scrolling, repeated modes and bounded REP. Numeric counts above 240 retire. Semicolon-only numeric SGR is accepted when it cannot conceal text; ambiguous color forms and concealment retire rather than expose hidden content.
- Snapshot JSON at most 64 KiB minus 1 KiB reserved for a later envelope. Callers share one frozen current snapshot; new output/geometry invalidates it. Partial escape packets and synchronized draws return no snapshot.

Overload or unsupported state clears owned work, settles pending writes, disposes the emulator and makes this observer unavailable.
It never drops a fragment and then presents the rest as a complete current screen, changes the agent's terminal or replays input.
Domain authority, transport/lease limits and the 32-model home reservation still belong to the later host integration.
The service must reserve one bounded outgoing slot before encoding; this qualification does not permit per-view unlimited serialized copies.

## Supported compiled executions

Each cell runs the final actual component through 11 real-PTY/geometry controls, 28 boundary/resource controls and three held-hook scenarios.
The first ten PTY controls keep their real child alive through parsing and a further 100 ms input observation; every normal observation records zero child input bytes.
The two deliberately wrong-write Mac controls each record one real input byte and fail the exact zero-input assertion.
No provider CLI, credentials, live hub, signing or deployment is used.
Linux executes in the pinned unprivileged Bun container on the supported ARM64/x64 targets; x64 is emulated on this Apple Silicon host.

The held scenarios construct the source `HookServer`, `AutoApproveGate`, session registry/binding/store, message API and actual input-answer handler.
An independent process answers the original held PermissionRequest with No after at least 128 KiB of accepted screen input progresses.
Both byte and maximum-clear loads must deliver a parsed deny in under 1,000 ms and write zero PTY bytes.
A deliberate 1,250 ms parent CPU block must exceed the same threshold while its independent answer is sent inside the block.

| Bun | Compiled execution | Largest measured retained delta (bytes) | No: byte / clear load (ms) | Blocking control (ms) |
|---|---|---:|---:|---:|
| 1.3.11 | darwin arm64 | 1,010,430 | 2.10 / 0.92 | 1248.13 |
| 1.3.11 | linux arm64 | 930,916 | 3.01 / 1.97 | 1251.61 |
| 1.3.11 | linux x64 | 924,865 | 9.74 / 12.57 | 1255.02 |
| 1.4.2 | darwin arm64 | 940,580 | 1.86 / 0.75 | 1251.29 |
| 1.4.2 | linux arm64 | 870,134 | 1.91 / 0.51 | 1251.12 |
| 1.4.2 | linux x64 | 982,772 | 11.98 / 6.59 | 1255.36 |

The six executions contain 66 PTY/geometry controls, 168 boundary/resource controls and 18 actual held-hook scenarios.
These are finite source/compiled component controls, not signed transport, native font/cell-width parity, OS resource isolation, live provider or deployed acceptance.

## Resource measurement and preserved failures

The 1 MiB gate uses the maximum complete post-GC JSC `heapSize` delta at settled maximum geometry, full pending input and drained input.
It retains normal and alternate 240×60 buffers, stale combined-string maps, four references sharing one immutable snapshot, one JSON projection and its UTF-8 bytes, and 1 KiB envelope allowance.
The maximum queue includes all 64 KiB/eight slots, including the in-flight operation.
`extraMemorySize` is recorded separately: it is already included in `heapSize`, as [Bun documents](https://bun.sh/reference/bun/jsc/HeapStats).
Independent 8 MiB buffer controls on both pins support that accounting; double-counting external memory is not used.

These deltas are measurements of retained allocations in finite workloads, not a portable allocator limit, total process peak/RSS or an OS-enforced 1 MiB ceiling.
The largest final delta leaves about 38 KiB below the gate; new dependency/runtime changes require fresh qualification.
The service-level 32 MiB quota is not implemented or proved by multiplying this finite observation.

Preserved failed/superseded controls:

1. V1 exceeded 1 MiB even before correcting its double-count of external storage. V2's draft assertion checked only pending input and missed a 1,050,913-byte all-phase peak; that result is a failure.
2. Reviewed V3 retained 1,059,366 bytes on compiled Mac 1.3.11. V4 tightened internal slices/joining input to 2 KiB with no budget, geometry, input queue, text or frame increase.
3. First Linux held-helper startup failed `uv_os_homedir` before load because UID 501 had no passwd entry. The same compiled helper passed under the pinned image's actual unprivileged `bun` account; final matrices use 1000:1000, without inherited credentials or changed model/latency gates.
4. A calibration assertion incorrectly required total heap growth to exceed an 8 MiB buffer despite unrelated GC. Linux x64 gained 8,388,733 external bytes and freed 1,008 core bytes. The corrected control checks the live external allocation separately; the model's full-heap 1,048,576-byte gate is unchanged. The earlier generic Mac assertion and quiet retry are retained too.
5. Review found four failures: mixed color concealment, resize/idle ordering, REP combining-state amplification and leading-zero modes. Real-object regressions gave 20 passes/four failures before correction, then 24 passes/zero failures afterward. A single fix-only delta found no remaining actionable issue. The driver subsequently tightened the one-column guard and internal constants without a third review round.
6. The first hosted full suite failed only the notice test: its expected-file lookup assumed root-level hoisting, while a fresh Bun install places the patched package in the daemon workspace. An unchanged fresh install reproduced the failure; the corrected test pins the actual bundled notice's SHA-256 and MIT declaration and passes on both Bun versions. Separately, the first local full suite used a 78-byte temporary root and hit existing Unix-socket path limits. The same two failing producer/host controls fail with that root and pass with a 26-byte owned root. Subsequent full-suite runs use short owned temporary roots; the production socket guard and screen implementation are unchanged.

## Receipts and reproduction

Private qualification sources, original failures, exact compiler/dependency hashes, binary/log receipts and the final manifest are retained at:

```text
/Volumes/S1/yooz/remi/artifacts/terminal-screen-20261022-bounded/
  PRE-REGISTERED.md
  candidate/{pty-probe,boundaries,held}.ts
  matrix-accepted/result.json
  mutations-result.json
  wrong-write-results.json
  manifest.json
```

Final screen SHA-256: `b15a3d016fd96a89b1dd650ec57ce269353b3d3fe74fa47f3fca5ebdb3aeea38`.
`matrix-accepted/result.json` pins every daemon/shared runtime source and every compiler, dependency and probe input used for its six executions; sources are rechecked unchanged after the matrix.
The retained `matrix.py` builds each profile with Bun 1.3.11 and 1.4.2 for `bun-darwin-arm64`, `bun-linux-arm64` and `bun-linux-x64`, then requires exact runtime/platform metadata and named gates.
Its Linux image is `oven/bun@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7` with no external networking, dropped capabilities, 512 MiB container memory and 64 processes.
That container limit is fixture containment, not a claimed per-screen memory limit.

Run the committed real-component regressions with `bun test packages/daemon/tests/terminal/screen.test.ts`.
The retained private mutation driver compiles isolated guard-removal copies on both Mac Bun pins; each must fail its named resource/control assertion, while the unchanged control passes.
No production source is modified by those negative controls.

## Next gate

B2 defines strict normalized-screen fields and shared conformance fixtures under the existing registry rules.
B3 must connect launch-time capture to the existing PTY owner, current grant/binding/runtime checks, bounded per-home reservations and the secure direct handler.
B4 must carry only those validated snapshots through the encrypted semantic relay and a real caller, retaining raw PTY/input/resize refusal.
Do not advertise `terminal_view` until those gates and a shipping caller pass; native rendering and signed/deployed acceptance remain separate.
