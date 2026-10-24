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

## Current qualification checkpoint

The [progress receipt](terminal-view-service-progress.json) records 272 passing
source cases on each Mac Bun pin (3,252/3,249 parent assertions), all five TypeScript
configurations, lint (zero errors/68 baseline warnings), exact CI spelling,
whitespace and bundle notices. Both actual five-minute signed-WSS lease controls
remain valid for the unchanged runtime and expiry-fixture graph. The subsequent
changes affect only standalone proof setup/diagnostics, with fresh static checks.
Both Mac pins also pass the original/restored source guards; removing the runtime
or original-grant-effect guard fails its named real component control.

All six compiled Mac ARM64/Linux ARM64/Linux x64 executions on Bun 1.3.11 and
1.4.2 pass four one-model resource profiles, two combined two-owner/eight-view
profiles, 30 reservation groups and five policy-migration groups per cell.
Maximum one-model increment is 1,480,660/4,194,304 bytes;
maximum two-model sum is 3,066,909/8,388,608 bytes.
Strict profiles retain actual 64 KiB raw JSON/AST ingress alongside pending native
output and the full parser queue, including the maximum-node refusal path.
All original allowances and Linux containment limits remain unchanged. Exact
source/engine/compiler/certificate/binary hashes retain unchanged completed
resource/quota measurements; missing Linux Bun 1.4.2 cells were run separately.

The full compiled held-No campaign is **blocked**. Its latest Linux ARM64/Bun
1.3.11 run read a secondary-process state path that had disappeared during the
fixture lifecycle. The missing path differs from the retained current scenario's
directory, suggesting crossed scenario lifetime; the precise cause is unconfirmed.
All retained current-scenario children exited normally, and the independent No
child parsed deny promptly, but those observations do not qualify a failed cell.
Further whole-matrix retries stopped. The next step is a bounded lifecycle trace
that identifies the late state observer before changing cleanup behavior.

Earlier fixture failures remain failed: polling opportunities were confused with
wire throughput; setup assumed admission guaranteed an Open response; a one-shot
lock holder could fail under valid contention; tiny receiver windows delayed
post-measurement disposal. Actual controls support the narrow corrections.
Setup now permits bounded fresh Opens only after proving no view/effect and awaits
only pre-effect fixture lock acquisition. Receive capacity is restored only after
all resource/No observations. Product limits, authority and no-replay behavior
remain unchanged. Failed-run child diagnostics are retained.

R1 findings are fixed; the single R2 has no Critical/Important findings. This is a
partial checkpoint, not full service qualification. All six current held-No cells,
remaining compiled negatives, final-head hosted checks and the required relay soak
still gate merge. PR #1655 stays draft. B4 encrypted routing and a qualified
production caller precede capability advertisement. Rendered native, signed
hardware, deployed Worker and provider acceptance remain separate. #1595 stays open.

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
next native response. Current partial results are recorded above; the older
261-case receipt and failed campaigns remain historical evidence.
Finite retained state is not an OS/RSS ceiling.
