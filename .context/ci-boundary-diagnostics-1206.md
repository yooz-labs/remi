# CI boundary diagnostics (#1206)

Main release merge `c7a0088c` has the same Git tree as reviewed release head
`1f7b3b42`. All ten PR checks passed, including the full server suite and an
actual 61-minute R7 soak. Main CI run `39416980173`, attempts 1 and 2, then
reached the unchanged 20-minute child deadline. No failing assertion appeared.
Both logs contain exactly the same 89-file prefix of the remaining lane and
stop at `packages/daemon/tests/cli/log-file.test.ts`, before its first result.
There is no third unchanged-run retry.

The final samples show a sleeping child with negligible CPU growth. Both
forwarding streams have equal read/completed byte counts, no pending writes
and no callback/drain wait. That distinguishes this observation from the
original high-CPU report in #1206, but does not identify its cause. The last
file header does not establish module-body or test-body entry.

Bounded local controls did not reproduce the stall. The focused Mac population
passed 27 tests. The emulated Linux x64 prefix crossed the boundary, with
documented tooling/source-mode and timing confounds. Exact-tree native Linux
ARM64 runner controls also crossed it; container network conditions caused
separate socket-fixture failures. Those partial, deliberately stopped controls
are not successful full-suite acceptance. Their original failures and receipts
remain under the release artifact root. Task containers and their internal
network were removed.

This change adds observation rather than a claimed root-cause correction:

- The existing quiet-period process sample reads a bounded kernel wait-channel
  symbol, or records `null` when unavailable. Its bounded `/proc/<pid>/stat`
  parser uses `comm` only to locate numeric fields and never emits the name; it
  reads no `argv`, environment, memory contents or payload. `0` is retained
  without interpreting health.
- GitHub Actions gets static logging-test module/setup/open/read checkpoints,
  following the existing remote-new-client checkpoint pattern.
- A real FIFO-blocked child checks kernel sampling and actual emitted metadata.
  Two actual logging-test subprocesses pin the original 14 passing cases and
  verify checkpoint presence/absence for the selected environment.

The kernel documents `wchan` as a blocked-task kernel symbol, with availability
depending on kernel configuration:
<https://docs.kernel.org/filesystems/proc.html>.
It is not a native stack or a diagnosis of every sleeping task.

The existing test population, assertions, runtime pins, deadlines, ownership contracts,
coverage union/threshold, classifiers and release guard remain in force.
Fresh exact-head hosted checks and one independent review gate this change.
If the stall recurs, preserve its new stage/wait evidence and investigate that
boundary. A green run alone does not establish the previous cause; keep #1206
open. Stable publication continues through the existing automation only after
the actual gates pass.

The patch targets the held main release. Its normal post-release sync carries
the accepted change back to develop. Native build 13's application source is
unchanged, and its separate owner compliance confirmation remains pending.

Local validation on the diagnostic patch: pinned Mac Bun 1.3.11 passed 27
cases with one new Linux-only configured skip across the two changed test
files. The real blocked-child case passed separately on native Linux ARM64
Bun 1.3.11 (seven assertions). Root TypeScript checking, Biome and diff
whitespace checks passed. Before the markers were added, the enabled real
logging-child control failed on the missing module-body stage while its
disabled control passed, preserving all 14 original cases.

One fresh-context single reviewer covers all applicable lenses (cap one).
There are at most two review rounds for this PR. This does not reopen the
completed reviews of release #1564 or native routing #1562.

Round 1 found that the new nested logging-test controls buffered their stages
until exit and lacked bounded child cleanup. The accepted fix uses the existing
`runChild` owner with a two-second child deadline and ten-second outer budget
for these new controls. Only the seven static stage names are forwarded live,
under a distinct `log-file-child-stage` prefix; nested test headers and other
child output stay captured so they cannot alter the outer file inventory.
A real child waits for a file written only by the checkpoint observer before
it can exit, proving live delivery while also checking that unknown and oversized
lines and a nested test header are not forwarded. Process lifecycle changes
make this a substantial fix, so round 2 reviews only this fix delta.

After the fix, pinned Mac Bun 1.3.11 passed 28 cases with the one Linux-only skip
(110 assertions) across the same two files. The original 14 logging cases remain
intact. This validation does not replace the required hosted run.

## Follow-up diagnostic experiment (#1206)

Main CI run `39512922076` on release head `40d8c5d4` failed on both attempts
at the unchanged 20-minute rest-lane deadline. Raw logs from both attempts show
the two nested logging controls and the live checkpoint-forwarding control
passing, with 46 `log-file-child-stage` records each. The later direct
`packages/daemon/tests/cli/log-file.test.ts` header appears with no direct
`log-file-stage` records. The final sample remains a quiet `ep_poll` process
with forwarded streams settled and no fail result lines. This places the
unresolved stall in the full rest-lane path before a direct checkpoint is
observed; it does not establish that module evaluation had not begun. In
particular, the module-body checkpoint itself synchronously writes to child
stderr, so a child-side write/flush stall remains a hypothesis alongside an
earlier import stall.

The isolated control previously omitted the lane's coverage and JUnit flags.
It now uses the exact flags and writes LCOV/JUnit outputs to a temporary
directory outside the checkout, verifies both reports, and removes them. These
reports are control evidence and never enter the lane coverage union or the
60% threshold. The pinned Mac Bun 1.3.11 control passed the 14 logging tests
with 39 expectations in 30 ms; that result does not establish Linux behavior.

The first quiet Linux sample now includes at most 32 task states/wait channels
and 8 current direct-child states/wait channels. Reads are capped, symbols are
filtered to short ASCII names, and parent/process-group checks bind the sample
to the owned child. Missing proc data is recorded as null and cannot change
the child result. The bounded `/proc/<pid>/stat` record includes a `comm` field;
the sampler uses its delimiter to reach the numeric fields, discards the name,
and never emits it. It does not read `argv`, `environ`, memory contents, or test
payload. A real nested FIFO control exercises the owned process and its direct
child; it remains Linux-only and still needs the hosted gate.

The rest-lane owner also creates a private 0700 temporary directory and an
exclusive 0600 no-follow stage file for the direct lane child. The logging test
appends only allowlisted stage names and its writer PID before the existing
stderr checkpoint, only when the writer's parent matches the wrapper PID.
Sampling accepts entries only for the current owned lane PID and reads at most
4 KiB / 64 lines. It exports no file path or raw line and removes the temporary
directory after child cleanup; cleanup failure emits a sanitized diagnostic.
Nested inherited-environment controls are rejected by PID/parent checks. The
controlled hold used to test a quiet module-body checkpoint runs only in the
focused diagnostic test; the production lane never sets that hold variable.
Both stage-file opens use nonblocking I/O and verify a regular-file descriptor;
FIFO replacement yields unavailable stage data instead of blocking. The
bounded control replaces the owned stage file with a real FIFO while running
the real logging test and checks the existing child deadline and cleanup. It
passed on Mac; the hosted Linux gate remains necessary.

The test inventory, target ownership, assertions, coverage union/threshold,
release guards, Bun pin, and 20-minute child/22-minute controller deadlines
remain unchanged. This patch adds diagnostic evidence only; #1206 remains open
and no root cause or corrective fix is claimed. The focused Mac run after the
patch passed 32 tests with one Linux-only skip and 157 expectations across
the same two files. The original 14 logging cases passed under both checkpoint
settings with exact coverage/JUnit flags; direct stage capture and owned cleanup
passed. The real quiet-stage control passes on Mac without procfs and still
needs the hosted Linux gate. The real stage-file FIFO replacement control also
passes on Mac. The real process-topology and independent-wchan control is
Linux-only and has not run on this host. No hosted rerun is included here.

## Linux control correction and remaining stall

Hosted run `39523033318` crossed the direct logging boundary with 46 direct
and 46 nested stages and completed the test population.
It failed two new Linux diagnostic controls, not the previous quiet deadline.
On actual Linux x64 Bun 1.3.11, `Dir.close()` returns synchronously;
calling `.catch()` on that return threw and discarded an otherwise valid topology.
Awaiting close inside try/catch retains best-effort cleanup on both API shapes.

The real FIFO control also exposed a separate nested-Bun startup race before
the one-time sample.
Its fixture now uses a positional-argument shell parent and direct `exec cat`
child on the same FIFO, retaining the two-second deadline and all assertions.
The independent kernel wait-channel oracle remains in place.
Pinned Linux controls passed 2/2 with 49 assertions and the FIFO control passed
10/10 repeats; the lead independently repeated red and green bundles.
The focused Mac population passed 32 tests with one Linux-only skip.

The original full-suite cause remains unresolved.
Phase-three run `39524111700` crossed logging but later reached the unchanged
20-minute deadline at a `transcript-watcher.test.ts` header, with eight quiet
samples, flat final CPU and settled forwarding streams.
The corrected diagnostic helper is included in the combined release candidate;
there is no unchanged rerun or waiver of the final release checks.
