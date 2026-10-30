# Signed direct terminal view service (#1643)

This branch implements the existing strict terminal open/read/close contract on
signed public WSS. The CLI composes the handler, but does not advertise
`terminal_view`. Encrypted relay adoption and a real shipping caller remain B4;
the existing native pane source stays available for that integration.
Input stays in chat and approval controls. This service has no terminal input,
resize, attachment, provider or account operation.

Admission captures the current original device key/grant epoch, exact Connection,
attachment token, ManagedSession, PTY, harness runtime, capture context and
Claude/Codex binding. Plain WS, local capability and proxy identity do not qualify.
The nonblocking original-grant lock encloses the final checks, borrow, strict
encoding and both ordered native writes: terminal frame, then receipt ping.
No await, retry or alternate authority occurs after effect entry.

Every response, including opened/unchanged/closed/refused, borrows the same real
model/view capacity. There is one record per reserved connection view; the shared
1/2/4/8 quotas remain. No phantom model, uncounted control-response pool or
parallel reply queue exists. If eligible capture/view/native capacity or current
authority is unavailable, optional silence leaves the caller's bounded timeout
to report it. The shared chat/approval connection stays available.

The home ledger reserves 4 MiB per complete stack, at most eight models and
32 MiB per home under [ADR0048](../.context/decisions/0048-terminal-stack-budget-and-policy.md).
The primitive's independent 1 MiB oracle and every other bound remain.
A known original-grant lock conflict before the protected callback may retain
one first-time read intent; an entered or uncertain operation is never replayed.
Maintenance skips a known busy grant tick without sending data. Close cancels
held reads even under grant pressure. A temporary unavailable borrow retains
an intent only while its original capture context remains current.
After a view borrows the model, its next turn follows already waiting views.
This reuses the existing admitted-record order and creates no extra queue.

One new explicit Open creates a collision-checked 16-byte opaque ID and five
monotonic minutes. Wall time formats expiresAt. Reads are spaced by 500 monotonic
ms per reserved connection view, including across a new Open, and use current
complete snapshots/revisions. No output history is retained.
A transition into closed/expired/refused receipt state consumes its existing view
for one logical second, starting at admission for an initial control record.
Transient busy, wrong-view and future-revision refusals leave an open lease
active. Logical expiry does not pretend that pending native bytes were disposed;
uncertain ownership can keep fixed charge after the receipt becomes inaccessible.

TLS ownership follows #1646: only an actual matching pong for a fresh native ping
ordered after the frame, plus open/zero plaintext buffering, can release it.
Socket-owned data routes native drain/pong/close even after the active Connection
map removes its entry. Domain ACK/pong, timers, logical disconnect and
foreign/stale/reentrant pongs establish no disposal or domain authority.
Close or uncertain native entry quarantines fixed charge without closing the
approval connection or replaying an operation.

A client can receive a response before its native receipt reaches the host.
Retain at most one first-time strict same-view read/close metadata intent while
that preceding frame or another view of the same model is pending. It contains
no screen, encoded response or raw body. Genuine disposal wakes eligible intents;
existing bounded maintenance handles parser readiness. Clear an intent before its
first attempt and on retirement; each effect rechecks all original authority,
lease and rate conditions. No operation that entered native send is replayed.
Additional pressure is omitted. A current owner Close replaces a held read and
marks the logical view closed before any future native effect; an already
scheduled read can emit no new snapshot after that Close. Already entered native
bytes cannot be retracted and retain their disposal accounting.

Original UTF8/JSON units reach strict ingress before generic ACK/deduplication.
The raw byte limit precedes decoding; malformed correlation retains only bounded
IDs/operation. This terminal-view service does not log or persist request/response
bodies, or add them to replay or push. The separate existing opt-in
`REMI_PTY_CAPTURE` diagnostic can write raw PTY output to its configured file;
this service does not disable that diagnostic. Current grant/binding/runtime/attachment or
capture loss retires the old view. No old incarnation follows a new grant.

## Develop integration (2026-10-30)

The [integration receipt](terminal-view-service-integration-qualification.json)
records local qualification after merging develop `7f5dd87a`
into the existing service branch without rewriting history. The single runner
conflict retains the current three isolated workers, five-minute target and
twenty-minute cohort caps, twenty-two-minute controller, ten-second cleanup
reserve and unchanged coverage/source/ownership/cleanup guards. An actual
before/after comparison preserves all 518 files in lanes 1/350/167 without
omissions or duplicates. The merged event golden set contains both new events;
its stale cardinality and unique-count assertions now require exactly 22.
Measurements pin integration tree `a8812f4fb03bd3e815fea691a447368400f59858` and exact
source manifest `85c4b21df442df772fb8b7d4d269e804d71bb52b7e90e29eae9c4afdee9ec505`; per-cell binary hashes are in the receipt.
The local merge commit is `13f38e37ae3459703faa9baaebd669291a197fc7`; later documentation changes do not
extend these results into hosted or deployed acceptance.

Both Bun pins pass 321 source cases (3,522/3,517 assertions), the focused CI
controls and fresh actual five-minute signed-WSS leases. All five TypeScript
configurations and static gates pass; lint retains zero errors/68 warnings.
All six supported compiled cells were rebuilt and rerun with fresh owned test
TLS material. Each passes four one-model profiles, two combined two-owner/eight-view
profiles, 30 reservation and five migration groups, and four held-No scenarios.
Maximum one-model retained increment is 1,465,480/4,194,304 bytes;
maximum combined sum is 2,517,770/8,388,608 bytes. Normal No is
0.697–52.437 ms against 1,000 ms; deliberate blocking is
1252.112–1286.605 ms and crosses that same gate. All 18
compiled input/parser negatives, both actual wrong-owner negatives and both
pins' original/restored runtime/grant-effect causal controls behave as required.
Actual PTY input remains zero; approved budgets and allowances remain unchanged.

The first merged source failure and interrupted preparation attempt remain
preserved; neither was regraded. A first copied causal-control harness omitted
an existing relative shared dependency and failed module loading before any
service case. Its failed manifest remains preserved; the corrected copy verifies
the actual shared package against measured source hashes before qualification.
The genuine old hosted soak remains bound to
head `760c8585` and base `ef6938e9`: 3,660,026 ms and 62 probes. It qualifies
no new merge. At this local qualification checkpoint, the branch had not been
pushed and no hosted run, fresh final-head 61-minute soak or final PR merge had
occurred. Those gates remain required after this checkpoint,
with the owner's reserved final merge decision. Review had already converged
through two rounds; this work performs narrow integration verification only.
`terminal_view` remains unadvertised and B4/caller/rendered/signed/deployed/provider
acceptance remains separate.

## Pre-integration expanded qualification (2026-10-24)

The [expanded receipt](terminal-view-service-expanded-qualification.json) records
320 passing source cases on each Mac Bun pin (3,509/3,504 parent
assertions), all five TypeScript configurations, lint (zero errors/68 baseline
warnings), exact CI spelling, whitespace and bundle notices. Both actual five-minute
signed-WSS lease controls retain validity through the unchanged runtime and expiry
fixture graph; the subsequent changes are functional tests and standalone proof
coordination, with no production/runtime change.

All six compiled Mac ARM64/Linux ARM64/Linux x64 executions on Bun 1.3.11 and
1.4.2 pass four one-model profiles, two combined two-owner/eight-view profiles,
30 reservation groups and five version-2 migration groups per cell. Maximum
one-model increment is 1,480,660/4,194,304 bytes; maximum
two-model sum is 3,066,909/8,388,608 bytes. Strict
profiles retain actual 64 KiB raw JSON/AST ingress alongside pending native output
and the full parser queue, including maximum-node refusal. All original allowances
and Linux containment limits remain unchanged. Exact unchanged dependency/binary
hashes retain the completed resource/quota measurements.

All six current held binaries pass four adjacent scenarios each in the same
process. Normal held-hook No latency is 0.569–16.104 ms against
1,000 ms; the deliberately blocked control is 1250.193–1274.728 ms
and crosses that same limit. All 18 compiled parser-overlap/actual-input negatives
fail their named oracle; two additional actual wrong-owner controls reject the
real parent PID in place of the real secondary producer. On both Mac pins,
removing the runtime or original-grant-effect guard fails its named component
control; original/restored source passes. Actual PTY input stays zero.

Each scenario now owns its awaited function lifetime; secondary state reads check
the actual spawned PID. Initial setup obtains both real grant/quota locks before
pausing the secondary actor, constructs the distinct native frame and waiting
intent, then resumes the actor before any measured load/No. A real contention
control proves that two reads arriving under a busy grant correctly occupy only
one intent; a batch alone cannot guarantee the two initial states. All eight
views and both owners remain charged, and the resumed actor must produce actual
snapshots during the original maximum load. No product queue/retry, workload,
deadline or allowance was expanded. Per-scenario metadata survives owned cleanup.

The old missing-state-path failure remains preserved and its precise cause is
unconfirmed: broad/narrow traces and the exact restored old binary passed. Current
qualification follows the explicit fixture ownership and setup changes; it does
not establish a runtime/JIT diagnosis. The [earlier checkpoint](terminal-view-service-progress.json)
remains a historical partial receipt, and no failed campaign is regraded.

The hosted checkpoint exposed five obsolete pre-service close assertions. Real
web conformance now checks ordered pong/liveness without terminal input, resize,
ACK or reply when no service is installed. Source CLI coverage checks unadvertised
capture and signed Open/Read/Close when its harness binding is resolved, while an
unresolved binding sends no screen and keeps the connection available. The five
old expectations fail on current source; the updated 47-case lane passes on both
pins. Full final-head hosted checks remain required; the old overall CI child
deadline failure is not diagnosed by those assertion fixes.

A separate wrapper test confused published TLS/health with installed shutdown
handling. Actual before-ready/ready/restored-before-ready controls fail/pass/fail
on both current and pre-service source. The test now observes real handler
installation before asking for graceful teardown, keeping the same deadlines and
endpoint-removal checks. This does not close [#1615](https://github.com/yooz-labs/remi/issues/1615)
or diagnose all its older failures. A local runner's noncanonical `/tmp` alias also
correctly failed descriptor/path guards; same-root alias/canonical/restored-alias
controls fail/pass/fail. The accepted source lane uses short canonical roots.

R1 findings are fixed; the single R2 has no Critical/Important findings. Later
fixture/test changes were driver verified, with no third review. Merge requires
all seven final-head hosted checks and the actual required relay soak; consult
PR #1655 for current merge state. B4 encrypted routing and a qualified production
caller precede capability advertisement. Rendered native, signed hardware,
deployed Worker and provider acceptance remain separate. #1595 stays open.

## Historical hosted suite budget correction

The final backend run passed the actual 61-minute relay gate, but its complete
Test cohort reached the old 20-minute child cap with 10,472 passing cases, no
failed cases and 25 unvisited files. Logged passing-case durations total
1,192.23 seconds; those remaining files took 37.02 seconds in the prior passing
run. This establishes active execution at the deadline, not a diagnosed hang.

The [CI correction receipt](terminal-view-service-ci-validation.json) records
allocation of the unused target-lane budget to the same complete shared-cache
cohort. The 22-minute controller ceiling, ten-second cleanup reserve, five-minute
target cap, 25-minute job bound, case/ownership checks and coverage threshold stay
unchanged. A real two-process controller regression fails with the old allocation,
passes with the correction and fails with restored old behavior. Both Bun pins
pass the focused CI controls; only an existing platform-specific test is skipped.
Backend runtime, all 320 selected source cases, actual lease dependencies and
compiled model/service qualification inputs remain unchanged. The next hosted
complete suite must finish and pass before merge; elapsed time alone is no waiver.

## Historical source qualification and failed 1 MiB gate

The [source receipt](terminal-view-service-source-qualification.json) records
261 passing cases on each Mac Bun pin (3,197/3,194 parent assertions), five
TypeScript configurations, lint (zero errors/68 unchanged warnings), exact
CItypos1.28.4, whitespace and bundle notices. Real private-CA signed WSS, identities,
registry/binding, launch-captured zero-input PTYs and actual native packets cover
both harness bindings, native/domain pong separation, native close after logical
removal, one held intent and original grant/binding/runtime/attachment retirement.
Three actual packet controls verify Close precedence over both a held read
and a queued native read, and preserve a second charged view during shared-model
pressure. The original controls reproduced both defects before their fixes.
Both refreshed source lease controls ran five actual monotonic minutes, then
refused the old ID and admitted a new explicit Open without clock injection.

The expanded staged test found an initial-Open race: maintenance could retire a
new receipt with expiry zero before its queued native job ran. A real incoming
request stalled275ms makes the existing250ms interval overdue before the0ms
job is created. The named regression fails with old code, passes with admission's
original one-second deadline, and fails with restored old behavior. Both real
five-minute lease controls and the complete source checks pass after the fix.

Full review also found that another Open reset the read timestamp while reusing
the same charged connection view. A real packet regression reproduces a second
snapshot inside500ms; preserving the timestamp now returns busy across that
new lease ID. The complete261-case source and actual five-minute lease controls
pass after the fix. Review clarified that transient refusals leave an open lease
active and that the separate opt-in raw PTY diagnostic can persist output.

A test initially assumed service-map removal synchronously removed its ledger
row. An actual unchanged cleanup probe observed a safe, settled, unborrowed row
queued for filesystem cleanup, then its later removal. The corrected assertion
waits for both map and physical ledger under its original deadline. Production
cleanup cadence and ownership guards stay unchanged.

An earlier runner made the existing browser producer's UNIX-socket path114bytes,
which correctly failed its104byte guard. Actual A/B/A controls preserve the
long-root failure, valid-short-root pass and restored-long-root failure. The full
source suite now uses a private short canonical TMPDIR and fresh private HOME.
The earlier Mac wrapper cleanup/reset failures remain preserved; their cause is
not claimed fixed. No source gate is waived by the older B1-only exception.

The first expanded resource matrix stopped at a failed gate. Mac ARM64 Bun1.3.11
passed Latin-1 and UTF16/escaped profiles at806,976 and834,650 bytes; Linux ARM64
Bun1.3.11 retained1,199,295 bytes against the unchanged1,048,576-byte limit.
The actual path holds four signed-WSS views, four first-time waiting read
intents, a native-pending frame and the full64KiB/eight-operation parser queue.
All original native-copy, fixture-pressure, TLS-working, envelope and ingress
allowances remain included. Two Mac causal controls reject overlapping parser
work and actual PTY input. The other cells and combined two-model/held-No tests
remain unaccepted. The failed matrix and separate allocation diagnostics stay
recorded; no baseline, allowance, limit or application capability was broadened.

A later diagnostic comparison covered all twelve platform/text combinations on
the review-fix source graph: eleven stayed below1MiB, while Linux ARM64
Bun1.3.11 Latin-1 retained1,198,091 bytes. The original capacity assertion still
throws, so that profile stops before the delivery verifier and qualifies no
release. The Mac diagnostic results were retained only after verifying unchanged
source/proof/engine/compiler/certificate inputs across a Docker restart. Runtime
small-memory and bytecode experiments also exceeded the limit; neither is an
adopted build or a budget change.

The owner subsequently approved 4 MiB for the complete stack with the same
32 MiB home cap, reducing model admission to eight. No failed 1 MiB profile is
regraded. Actual grant/quota contention controls reproduced premature retirement
or lost reads and now preserve only unentered bounded intents. A real two-peer
native-pong regression reproduced repeated-reader precedence:
old/fixed/restored-old fails/passes/fails. The waiting reader now receives the
next native response. Current expanded results are recorded above; the older
261-case receipt and failed campaigns remain historical evidence.
Finite retained state is not an OS/RSS ceiling.

The next hosted run completed the full remaining cohort in 1,249.40 seconds
with 10,581 passes, 38 skips and one failure in a diagnostic fixture. Its fixed
sleeps allowed output to arrive during an asynchronous process sample; the
resulting `quietMs: 0` was valid. The fixture now advances after observing two
actual quiet samples before its header and one afterward. The logger, 40 ms
thresholds, 2,000 ms child timeout and stream/topology assertions are unchanged.
Both pinned Bun versions must pass the CI controls; full hosted checks remain
required before merge. This does not change the backend qualification.
