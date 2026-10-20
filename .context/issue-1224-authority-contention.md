# #1224 authority contention validation

Source baseline: `1e96c688f89409043e17177c1914d8eec247de7e`.
First failing pin: `f60e0530` (`test: pin relay lock contention #1224`).
Implementation checkpoint: `6c8ef7dd6c1e1a4155c257d8d2ef3490bad4a325`.

## Production boundary

`HubRelay.sendRaw` and its queued encrypted-frame emitter call `current`, then
`SecurePushStore.isCurrentAuthority`. That check now uses
`IdentityStore.withAuthorizationEpochNonblocking` and
`withInterprocessFileLockNonblocking`: one complete restricted metadata candidate,
one atomic hard-link ownership attempt, the entire synchronous current-epoch and
enrollment decision under that owned lock, then owner-token-checked release.
Contention throws the existing `InterprocessFileLockError`; the boolean authority
API still reports false with its fault callback. Existing synchronous cancellation,
authenticated BYE, fault-versus-revocation logging and retirement are retained.
No authority cache, asynchronous retry, or captured epoch refresh was introduced.

Nonwaiting checks do not reclaim stale or unknown locks. Existing blocking writer
transactions retain their two-second wait and stale recovery. Admission capture
can still perform lazy durable migration under that writer lock. Actual secure
push/native-answer final effect transactions remain blocking and atomic. All
filesystem calls remain synchronous; this does not measure or guarantee disk I/O
latency, deployed Worker behavior, signed native devices, APNs or owner hardware.

## Measured controls

The pin starts the existing real `lock-holder-worker.ts` in an owned restricted
directory with a stripped environment, waits for actual acquisition, and verifies
the child PID owns the lock. It then uses a real resumed HubRelay, local R2
workerd and admitted encrypted client. The child stays alive, its lock metadata
and grant/enrollment files remain unchanged. Both the synchronous broadcast and
the next event-loop timer must settle below 500 ms. Only authenticated BYE can
reach the client after the refusal; no application DATA is delivered. After the
child exits, the same Dpk on a fresh READY channel receives a valid update.

The old source failed at the actual latency assertion: 2000.884 ms on Bun 1.4.2
and 2001.500 ms on Bun 1.3.11, versus the unchanged 500 ms bound. The fixed control
passes on both. Primitive/store tests cover complete 0600 owner metadata,
callback-error release, foreign-owner preservation, candidate cleanup, busy/
stale/malformed/symlink refusal, no old-record migration, independent same-key
grant and enrollment replacement, and a real waiting revoker excluded from the
nonwaiting callback's owned lock.

Focused gates on each Bun version: **225 passed, 3 explicit clock-probe skips,
0 failed, 6670 assertions across 28 files** (1.4.2: 73.90 s; 1.3.11: 74.95 s).
These include all `relay-r3*.test.ts`, daemon `remote` tests, authorization and
enrollment epoch tests, session-store, secure-push-store/transport and real
answer-effect authority tests. Root/web/web-tests/signaling and R3 integration
TypeScript gates passed. Full Biome passed with the same 52 warnings; typos passed.
Full suites and exact fresh-clone integration acceptance are owned separately by
the integration coordinator and are not claimed by this focused receipt.

Twelve causal mutation families each failed a runtime assertion on both Bun
versions (24 failures): restore blocking current checks; run a busy decision
unlocked; remove grant or enrollment epoch comparison; release before the
decision; treat a fault as current; release a foreign owner; migrate during the
current-only read; recover stale locks in nonwaiting mode; loosen owner metadata
permissions; leak a lock after callback failure; leak a candidate. The three
production source hashes were verified restored against `6c8ef7dd` afterward.

Local diagnostic artifacts are retained at
`/private/tmp/remi-1224-receipts.tt7zYd/`: `pin-old-{142,1311}.log`,
`focused-{142,1311}.log`, `mutations.json` and `mutant-*.log`. These are local
receipts, not required checkout inputs. Tests use the selected Bun executable via
`process.execPath`; no developer-specific executable path is committed.

## READY retirement follow-up

Independent review of `2e5176b9` found that the initial outbound fix left a
distinct incoming path: `Channel.receive` authenticated and consumed DATA, then
the READY wrapper returned silently when `current` refused a busy store.
The same bare return existed after session-list and native-answer awaits.
Connection queries could also temporarily hide, then revive, the same peer.

First three-trigger pin: `47dd8bf2`. Central lifecycle fix:
`6767d3f21cb027da6896d629ba5c08df51616051`. Post-await pin: `8a508921`.
`current` now initiates orderly retirement of a still-active READY peer whenever
its check fails. Cancellation is synchronous; closure is not awaited, so the
wrapper queue can drain the counterpart's authenticated BYE. Non-READY checks
and an existing transport close retain their previous behavior. Callers at the
incoming wrapper, both session-list awaits, the native-answer signature await,
the queued emitter and both public connection queries share this decision.

Real owned-writer pins independently exercise an encrypted Ping, connection
count, connection presence and an actual session-list response held until after
lock acquisition. The old source fails the missing-BYE runtime assertion on
both Bun versions while the holder is alive, the actual fault log is present,
and owner lock bytes and durable grant/enrollment files are unchanged.
The fixed pins require BYE within 500 ms, no DATA, a drained reply BYE, permanent
retirement after release and actual same-device fresh-READY Ping/Pong recovery.
The held local response proves the first refusal occurs after the await,
without replacing cryptography or its result.

The three-trigger old controls each report 0 passed / 3 failed (1.4.2: 8.14 s;
1.3.11: 8.48 s). The post-await old control fails on both versions (2.89/2.97 s)
and its fixed control passes with 24 assertions on each (2.85/2.86 s).
Four additional causal families fail at runtime on each version: omitted READY
retirement, admission of a store fault, restored blocking current reads and
delayed retirement. Both private production files are SHA256-checked restored.

Final focused controls, including all four new triggers, revocation, orderly
close, wrapper drain and actual encrypted DATA replay: 16 passed / 0 failed on
both Bun versions (25.05/25.11 s; 150/149 assertions across five files).
An initial 1.3.11 replay control failed on its already-characterized immediate
close reason loss; the corrected test requires the exact hub and first Worker
close records before allowing R3's pinned-runtime exception. The counter-removal
probe still fails on both runtimes. It does not relax replay admission or
change the sender's constant failure close.

Receipts: `/private/tmp/remi-1224-inbound-pin-root-{142,1311}.log`,
`/private/tmp/remi-1224-post-await-9mhmddgd/` and
`/private/tmp/remi-1224-ready-gates-yprz2_ah/` (`mutations.json`,
`restoration.json`, `replay-counter.json`, original failed control and
`restored-final-{142,1311}.log`). The scoped R3 TypeScript gate passes.
Full exact-head suites, the 61-minute soak and Linux CI are separate integration
gates; deployed Worker, Apple APNs and signed-device acceptance remain owner
gates. This receipt does not claim those outcomes.

## Linux reply-BYE control correction

Linux R7 run `37901644901` at `664f86fb` reported 272 passed, 4 skipped and
one failed assertion: the new connection-count pin logged delivery uncertainty.
The pin closed its client immediately after sending reply BYE. Bun 1.3.11 can
reset that connection and discard the just-sent frame (#1225), the same behavior
already documented by the existing R3 orderly-close tests.
The four new triggers now follow that existing control: send authenticated reply
BYE and leave the transport open until the hub's bounded two-second grace closes
it. The 500 ms retirement bound, clean-close/no-uncertainty assertions, owned
writer checks and fresh-channel recovery remain unchanged. No production code or
runtime exception changes. Independent read-only delta review found no findings.

A fresh private clone with this test correction passes the same five-file control
on both runtimes: 16 passed / 0 failed (Bun 1.4.2: 24.96 s, 150 assertions;
Bun 1.3.11: 24.91 s, 149 assertions). Scoped TypeScript, formatting and diff checks
pass. Receipts: `/private/tmp/remi-r7-close-correction-g_u2f88g/`.
The old-head Bun 1.4.2 full suite passed (7920 tests, 26 skips, 0 failures);
the coordinator was interrupted normally during the old-head 1.3.11 suite to
avoid running the hour gate on a superseded head. Neither is acceptance of the
new committed head. Fresh exact-head suites and Linux/hour gates follow this
correction separately.
