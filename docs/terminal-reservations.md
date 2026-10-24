# Shared terminal model and view accounting (#1617)

This standalone B3a component implements the home quotas from the approved
[#1595 plan](../.context/issue-1595-backend-plan.md) and ADR0046/0047 and [ADR0048](../.context/decisions/0048-terminal-stack-budget-and-policy.md).
The original standalone phase added no production constructor or capture observer.
[B3b (#1620)](terminal-capture.md) now composes model reservations with launch-time
capture; secure terminal handlers, advertised capability and a pane remain pending.

## Counted resources

`TerminalReservations` admits at most eight model reservations per Remi home,
each charging the approved fixed 4 MiB complete-stack allowance (32 MiB total).
The primitive retains its independent 1 MiB qualification.
Only one model may represent a session in a home.
This counts reservations; it does not measure or impose an OS memory limit.
The future host must reserve before construction and preserve the qualified
model/send bounds from ADR0046.

View rows reference a model owned by the same process incarnation.
The same transaction applies one view per connection, two per device,
four per session and eight per home.
The ledger stores opaque IDs and process metadata only, not terminal content,
transfer artifacts, harness credentials or client-selected lease times.
It grants no device/session authority and establishes no lease freshness.

Each instance has a fresh random owner token plus its PID and hostname.
One instance cannot release another instance's model or view, even at the
same PID. A model cannot be released while its view rows remain.
The future host must dispose content/send slots before releasing their rows.
Atomic-write errors have uncertain completion: an admission may already have
charged a row whose ID was never returned, and a failed release may already
have committed its removal. Disposal-before-release keeps either outcome safe.
Unreturned charged rows remain until confirmed owned cleanup or process death.

Live owners do not expire by wall clock. The service must enforce monotonic
five-minute view expiry and release only after retiring its resources.
With an obtainable transaction lock, rows are reclaimed only when a same-host
PID returns ESRCH from signal 0.
Unknown hosts, other signal outcomes and PID reuse conservatively retain charge.
The captured owner cannot be reused after a process fork.

## Trusted private metadata

The existing Remi home must be an absolute canonical directory owned by the
current user, without group/world write access.
`terminal-view/` is private (0700); `reservations.json` is an atomic restricted
file (0600), bounded to 32 KiB, 16 rows and the existing strict JSON parser's
depth/node limits. Exact shapes, unique IDs, valid model references and every
quota are checked on reads. Bounded descriptor reads refuse symlinks,
hardlinks, unexpected modes/owners, unstable data and malformed/duplicate JSON.

The version-2 root pins the exact model count, per-model bytes and home bytes.
Both count and aggregate-byte limits precede admission. The same locked namespace
can transition a strictly valid version-1 ledger only when empty or when every
row belongs to this host and a kernel ESRCH proves its owner dead. Live, foreign,
unknown and reused-PID charges remain unchanged. Malformed or unknown-policy
state refuses admission. The archived actual version-1 reader/writer rejects
version 2, preventing mixed policies from silently sharing a home.

An exclusively created `.terminal-view-namespace` marker in Remi home binds
the namespace's device/inode. Either surviving piece prevents automatic
initialization after its counterpart disappears. Missing/incomplete/corrupt
existing state refuses admission; a failed initialization may require operator
repair after all owners have stopped. No repair command is implemented here.
Initialization does not change the parent home's mode.

Transactions reuse the existing nonblocking interprocess lock and restricted
atomic writer. An abandoned lock is deliberately not reclaimed automatically,
even after its owner is proved dead and the normal stale-age floor has elapsed.
Stop all Remi resource owners before operator inspection/repair; there is no
automated repair command in this phase. Reusing the older generic stale-recovery
path was rejected because two stale reclaimers can move a replacement owner
before detecting the mismatch. That pre-existing helper risk is tracked in
[#1619](https://github.com/yooz-labs/remi/issues/1619).
Directory, marker and ledger are checked again during each
operation. A busy lock returns `busy`; unreadable or unprovable state returns
payload-free `unavailable`. There is no filesystem lock or write on a PTY
output callback in this standalone component.

This is the existing trusted private namespace model, not descriptor-confined
storage or isolation from the same OS user. It cannot preserve accounting if
that user destroys all home metadata or replaces trusted ancestor paths during
a filesystem operation. Paths and terminal content are absent from its errors.

## Qualification and integration gate

The proof constructs this component against real private files and child
processes. It covers quotas, cross-process device admission, four live owners
competing for eight slots, exact owned release, death/reaping, nonblocking lock
contention and 18 corrupt/lost-state cases. Each child is reaped; failed owned
fixture directories are preserved. A separate killed-owner control waits a real
30 seconds, verifies that both young and old abandoned locks stay nonblocking
and unavailable, and models explicit repair only after its sole child owner is
proved absent/reaped and no resources are admitted. No authority service is
replaced by a mock.

Run `bun test packages/daemon/tests/terminal/reservations.test.ts` or
`bun run scripts/terminal-reservations-proof.ts`.
Compiled qualification invokes the same entry point with `--compiled` so its
children execute that exact compiled binary.
The original version-1 matrix passed all 30 groups on Mac ARM64, Linux ARM64 and Linux x64
under both Bun 1.3.11 and 1.4.2 (180 group executions). Ten independent guard
mutations failed their named assertion on both compiled Mac pins (20 negatives).
The original 29-group/18-mutation pass remains a predecessor receipt.

Private receipts are retained at
`/Volumes/S1/yooz/remi/artifacts/terminal-reservations-20261023/`:
`qualification-final-result.json` pins all daemon/shared runtime sources,
proof inputs and accepted binary hashes; `qualification-final/` holds every
compiled execution and mutation log. Source hashes were rechecked unchanged.
The Docker image is pinned to
`oven/bun@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7`,
with UID 1000, no network, dropped capabilities, 512 MiB memory and 128 tasks.
These are fixture containment limits, not product quotas.

The first compiler metadata check compared a short CLI revision string to
`Bun.revision`; the corrected driver queries the full revision directly.
The original 64-task Linux Bun 1.4.2 ARM64 run aborted. An identical-binary
control reproduced a cgroup limit event with a 64-task peak; at 128 tasks the
same binary passed all groups with a 68-task peak and no limit event.
The corrected six-cell matrix uses 128 tasks with all product quotas, the
512 MiB cap, assertions and nonblocking bounds preserved. No JIT setting or
shipping runtime behavior changed for that containment correction.

The initial harness inherited conflicting color environment variables, which
violated its empty-child-stderr oracle; children now use a minimal owned
environment. The next runs exposed a real nonblocking `busy` at concurrent
constructor admission. The process harness now retries only that startup
admission before allocating resources; the production component still makes
one attempt. These setup failures are retained, not counted as passes.

B3b composes launch-time observation and disposal with this ledger.
B3c must validate original signed WSS grant/attachment/binding/runtime authority,
monotonic leases, rate/send bounds and held-hook responsiveness before sending.
B4 qualifies the encrypted semantic route and a real caller before advertisement.
Native rendering, signed hardware and deployed acceptance remain separate.

The first crash control expected automatic dead-lock recovery and reproduced
permanent busy after the real age floor. The explicit operator-repair policy
above resolves that contract honestly; it does not relabel the failed automatic
recovery control as a pass. Atomic release completion wording was corrected
in the same review round.

The version-2 4 MiB/eight-model policy adds five actual migration groups, including
live legacy charges, a reaped legacy process, the empty transition, old-writer
refusal and unknown-policy refusal. Fresh source and all-six compiled controls
remain required for this revision; the version-1 receipts above are historical.
