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
  symbol, or records `null` when unavailable. It reads no environment,
  arguments, memory or payload. `0` is retained without interpreting health.
- GitHub Actions gets static logging-test module/setup/open/read checkpoints,
  following the existing remote-new-client checkpoint pattern.
- A real FIFO-blocked child checks kernel sampling and actual emitted metadata.
  Two actual logging-test subprocesses pin the original 14 passing cases and
  verify checkpoint presence/absence for the selected environment.

The kernel documents `wchan` as a blocked-task kernel symbol, with availability
depending on kernel configuration:
<https://docs.kernel.org/filesystems/proc.html>.
It is not a native stack or a diagnosis of every sleeping task.

The test population, assertions, runtime pins, deadlines, ownership contracts,
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
