# #1224 outbound authority contention validation

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
