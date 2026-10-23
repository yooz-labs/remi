# Launch-time capture of the existing agent terminal (#1620)

B3b of [the #1595 plan](../.context/issue-1595-backend-plan.md) connects the
bounded screen model and shared reservations to the existing agent PTY.
It adds no terminal transport, capability advertisement or pane.
Input stays in chat and approval controls.

## Production caller and lifecycle

The neutral `cli.ts:createNewSession` obtains an unstarted PTY from the harness,
then calls `TerminalCaptureHost.prepare` before `session.start()`.
This applies to both harness launch paths without adding a harness import.
The host reserves one of the home's 32 fixed 1 MiB model slots before it
constructs any screen model.
A busy startup admission can retry asynchronously for at most 50 monotonic ms,
before spawn; uncertain reservation completion never retries.
Unavailable capture does not prevent the agent from starting.

`PTYSession.observeFromLaunch` admits one observer for its entire lifetime,
only while the PTY is still created; disposing it cannot admit a replacement.
The observer receives copied actual starting geometry before native spawn,
original output bytes, successful existing local geometry changes and exit.
Its handle exposes availability, running state and disposal, without PTY
input or resize methods.
Observer exceptions invalidate the handle and cannot interrupt the existing
raw/text callbacks or the original lifecycle.

The capture model is constructed at the observed launch geometry.
Predating sessions, unsupported geometry/output, overload, failed spawn and
lost accounting remain unavailable; there is no reconstruction from a suffix.
The context belongs to the exact capture record and its observation.
Revisions are monotonic safe integers, and borrowing waits for complete output.
One borrowed immutable viewport and its send projection can be held per model.
The caller must drop both before releasing that slot.
Borrow checks exact reservation ownership; a busy check permits no frame,
and lost or corrupt metadata retires capture without inventing accounting.

Exit, session closure, launch failure and global cleanup retire the observer
and drop screen content.
Model release waits for parser disposal and any borrowed frame to be released.
One nonblocking metadata cleanup transaction runs per scheduled tick, with
250 ms between retries; output callbacks perform no ledger filesystem work.
Shutdown stops retries and reports unconfirmed cleanup while preserving debt.
An ambiguous atomic release may already have committed, as described in
[the reservation contract](terminal-reservations.md).
This phase does not create view reservations or grant remote authority.

## Native fragmentation and ordering

The original maximum-text PTY workload failed: eight 1,024-byte native reads
exhausted the primitive's eight-operation queue at only 8,192 bytes.
The original receipt and retirement trace remain preserved.
The host now coalesces fragments in an owned buffer of at most 16 KiB.
Primitive-owned bytes plus the full ingress allocation stay within 64 KiB;
primitive operations plus the ingress slot stay within eight operations.
The primitive, text/frame limits and approved resource budget are unchanged.

Older buffered bytes are flushed before a local resize is observed.
Pending input prevents borrowing a stale screen under a newer revision.
The resource probe additionally holds a 16 KiB handoff allocation, charging
that transient copy conservatively alongside a complete borrowed snapshot,
strict encoded projection and the full primitive queue.

## Verification scope

The source suite constructs actual PTYs, the real screen model and ledger,
and the shipping CLI composition for both Claude and Codex with owned,
accountless consumers.
It checks launch bytes, redraw, alternate buffers, Unicode, actual kernel
geometry, failure isolation, quota refusal, lost metadata, borrowed disposal
and byte/resize order.
The ordering control briefly defers a real emulator write completion; it
neither substitutes output nor replaces the model.
Both signed WSS CLI peers observe no `terminal_view` capability and a refused
open request without a terminal response or acknowledgement.
Every measured child receives zero input bytes and is reaped.
These consumers do not establish real provider or installed-release acceptance.

Run the focused source gates with each supported Bun pin:

```sh
TMPDIR=/tmp bun --no-env-file test packages/daemon/tests/terminal \
  packages/daemon/tests/pty-session-write-serialization.test.ts \
  packages/daemon/tests/cli/session-phases/pty-session-setup.test.ts \
  packages/daemon/tests/harness/harness-boundary.test.ts \
  packages/daemon/tests/license-boundary.test.ts \
  packages/daemon/tests/integration/terminal-capture-cli.test.ts
```

The focused lane passed 112 tests on both Bun 1.3.11 and 1.4.2.
Root type checking, changed-file lint and spelling passed.
All six compiled executions passed the nine viewport scenarios, stock compiled
Claude lifetime/quota/refusal, conservative resource control and four held-No
scenarios (54 viewport scenarios, six stock CLI lifetimes and 24 held controls).

| Bun | Host | Conservative retained increment |
|---|---|---:|
| 1.3.11 | Mac ARM64 | 922,929 bytes |
| 1.3.11 | Linux ARM64 | 906,784 bytes |
| 1.3.11 | Linux x64 | 927,110 bytes |
| 1.4.2 | Mac ARM64 | 954,650 bytes |
| 1.4.2 | Linux ARM64 | 854,292 bytes |
| 1.4.2 | Linux x64 | 945,156 bytes |

The largest measured increment was 954,650 bytes against 1,048,576 allowed.
Normal No latency was 0.535–16.488 ms; blocking controls were 1,248.960–1,262.513 ms.
All six runs delivered the real deny and measured zero child input bytes.
Six independent guard removals failed their named assertion on both Mac pins:
native-fragment coalescing, single borrowed slot, borrowed retirement accounting,
exact ledger ownership, one lifetime observer and byte/resize order.
Actual one-byte wrong writes failed the zero-input oracle in each of the three
profiles on both Mac pins: 18 named negative controls total.

The private reproducible probes and receipts are retained under
`/Volumes/S1/yooz/remi/artifacts/terminal-capture-20261023/`.
`viewport.ts` exercises actual PTYs plus the stock compiled Claude CLI lifetime,
quota and unavailable route; the source CLI lane separately covers both harnesses.
`resource.ts` measures whole incremental retained state from preparation/native
spawn with full internal model capacity; that input is a resource control,
not viewport fidelity evidence.
`held.ts` constructs the real held hook, gate and answer handler with an
independent No client during maximum native text, redraw and blocked quota
cleanup, plus a discriminating 1,250 ms blocking control.
`qualify.py` freezes sources and records binary hashes and named negatives.
`qualification-resumed-result.json` records six cells, 18 negatives and the
unchanged final source hashes; `qualification/` retains binaries and every log.
The initial driver incorrectly expected the viewport/resource assertion wording
for the held wrong-write control; the held binary had correctly failed its own
zero-input assertion at one byte versus zero.
The corrected driver validated that receipt and the unchanged inputs, then ran
only the remaining pin; it did not rerun accepted cells.
`qualification-initial-result.json` and `qualify-initial.py` preserve the first run.
Linux containment uses the same pinned image as the reservation proof, UID 1000,
no network, dropped capabilities, 512 MiB and 128 tasks.
This is a finite retained-state qualification, not an OS memory ceiling.
No terminal content is added to production logs, replay, push or disk storage.
Existing independent PTY diagnostics retain their own behavior.

The initial ordering harness waited for a write completion after sending only
SGR attributes; the model deliberately filters attributes before the emulator,
so that completion could never occur.
The corrected control sends supported cursor commands through the real writer.
The failed harness receipt remains preserved.
The child geometry oracle queries its actual TTY descriptor with `stty size`:
Bun 1.3.11's `getWindowSize()` returns cached columns/rows and can race resize.

B3c must add signed WSS authority, exact original grant/attachment/binding/runtime
checks, monotonic leases and rate/send reservations before sending any frame.
B4 must qualify the encrypted semantic route and a real caller before capability
advertisement.
Native rendering, signed hardware and deployed acceptance remain separate.
