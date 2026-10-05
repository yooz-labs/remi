# R5 shared/Worker focused verification

Production Worker implementation is commit40db59b3. Test-startup correction12527bd2
and subsequent pins leave production source byte-identical. No deployment,
credentials, model invocation, full monorepo suite or native/physical acceptance
was performed by this worker. The caller map and lifetime details are in
[relay-v2-push-worker.md](relay-v2-push-worker.md).

## Environment and gates

Frozen lockfile installation used `bun install --ignore-scripts --frozen-lockfile`.
Tests used disposable0700 HOME/state, pinned Bun1.4.2 and1.3.11 (including child
PATH), pinned Miniflare4.20260107.0/workerd1.20260107.1 and esbuild via
`E2E_BUNDLER=esbuild`. No dependency/runtime/compatibility-date upgrade occurred.
The actual owned APNs receiver measured HTTP/1.1, not production HTTP/2 or Apple.

All four package checks passed: `bun run typecheck`, `typecheck:web`,
`typecheck:web-tests`, `typecheck:signaling`. Installed local Biome1.9.4 reported
zero errors and the existing52 warnings; `typos` and `git diff --check` passed.

## Results and retained failures

- Earlier affected Worker/R2/legacy13-file gate:194pass/0fail/951assertions on BOTH
  runtimes. Final expanded14-file run:199pass/0fail/1021assertions on1.4.2;
  198pass/1fail/1019assertions on1.3.11, BEFORE the last retained-epoch test-only pin.
- That sole1.3.11 failure was the existing client-admission pipe-close case's
  FakeHost WebSocket upgrade, before its close assertions and before any new push
  path. The precisely selected isolated case passed1test/2assertions on BOTH.
  Its combined-run cause remains unexplained; no production fix, deadline increase
  or repeated combined/full retry is claimed.
- Exact final private mutation baseline AND restored source:52pass/0fail/439assertions
  across real gateway, builder, raw body reader and shared codec files on EACH Bun.
  These include concurrent nonce ownership, stale epoch, deadline, all14 reviewed
  weak encodings in both public fields, signed off-curve P256 and actual configured
  enrollment maximum1,000,000. The final production/shared source compared equal
  after restoration; only copied test updates remained dirty in the private clone.
- Final shared codec/vector/surface/domain/source-guard checks:29pass/0fail/529assertions
  on EACH Bun. The earlier four-message protocol/fixtures gate passed174/438 EACH.
  Independent Python verification passed all10 public synthetic cross-engine vectors.

Initial1.3.11 Miniflare startup failures were stdio ENOENT before business assertions.
Their receipts remain preserved. The test-only setup now configures an exact owned
loopback port/audience before its first runtime start, verifies the ready URL and
awaits disposal on failure. It does not retry or change production scheme policy.
An initial isolated selection used the wrong file and matched zero tests; this
selection error is not counted as a run of the case or a mutation kill.

The first pre-R5 legacy red fixture took the old Apple route with synthetic test
credentials rather than the owned receiver. Its original failed receipt is retained
and excluded from owned-network-only claims. The corrected fixture disables APNs
configuration before that old path can fetch. Re-execution against original red
source on BOTH Bun versions recorded five named assertion failures and owned
receiver counts `[0,0,0,0,0]`. No real identity/token/Apple credential was used.

## Assertion mutations

47 named final variants were assertion-killed on EACH runtime (94 valid kills).
There were no final surviving variants. One initial mutation of the payload guard
survived because the whole-inner test exercises a different guard; its receipt is
retained. A corrected-target first attempt failed by an uncaught business exception,
which is explicitly not counted as an assertion kill. An explicit positive boundary
expectation then killed the corrected whole-inner guard on BOTH. No timeout, startup,
syntax or import failure was counted as a kill.

Exact final variant names:

- `capture-no-implicit-enroll`
- `absence-verdict-after-proof`
- `capture-error-after-proof`
- `immutable-epoch-across-await`
- `no-late-epoch-recapture`
- `idempotent-enrollment-epoch`
- `consumption-sync-before-effect`
- `pending-error-uncertain`
- `post-effect-store-uncertain`
- `retained-exact-result`
- `exact-content-digest`
- `pending-concurrent-dedupe`
- `nonce-no-live-eviction`
- `nonce-capacity-refusal`
- `nonce-retention-expiry-plus60`
- `final-pending-ownership`
- `final-expiry-before-effect`
- `response-deadline-finite`
- `generic-no-unsigned-actions`
- `signed-single-environment`
- `fixed-invalid-token`
- `legacy-default-off`
- `legacy-mandatory-secret`
- `production-https-audience`
- `explicit-proof-audience`
- `durable-push_send_ip`
- `durable-push_send_rid`
- `durable-push_send_token`
- `durable-push_send_aggregate`
- `durable-push_attempt_ip`
- `durable-push_attempt_aggregate`
- `current-previous-cardinality`
- `no-previous-window-eviction`
- `final-apns-4096`
- `ttl-inclusive-boundary`
- `ttl-upper-boundary`
- `future-skew-inclusive-boundary`
- `future-skew-upper-boundary`
- `whole-inner-2048-inclusive`
- `body-byte-ceiling-before-parse`
- `body-fatal-utf8`
- `worker-weak-public-key-refusal`
- `worker-off-curve-point-refusal`
- `durable-budget-restart`
- `completed-outcome-sync-before-reply`
- `consume-record-before-effect`
- `retained-nonce-epoch-binding`

## Local receipts

Private markers `/private/tmp/remi-r5-worker-state-path` and
`/private/tmp/remi-r5-worker-mutants-path` identify owned logs, scripts and
`receipts.json`. The latter records each named failing assertion/profile and retained
invalid/surviving attempts. Corrected red counters are in
`corrected-red-counter-{142,1311}.log`. Failed combined1.3.11 and earlier startup
receipts are preserved rather than replaced by passes.

Owned Miniflare objects, receiver connections/timers and esbuild children were
awaited/disposed; final owned process census was empty. Shared/user daemons were
not stopped. Root owns merged-head full suites and final integration acceptance.

Exact focused command used for the expanded affected callers (with owned HOME and
`E2E_BUNDLER=esbuild` in the environment, and profile-pinned Bun/PATH):

```sh
bun test packages/signaling/tests/e2e/push.e2e.test.ts \
  packages/signaling/tests/secure-apns.test.ts \
  packages/signaling/tests/push-body.test.ts \
  packages/signaling/tests/e2e/client-admission.e2e.test.ts \
  packages/signaling/tests/e2e/room-protocol.e2e.test.ts \
  packages/signaling/tests/e2e/limits.e2e.test.ts \
  packages/signaling/tests/pin-worker-routes.test.ts \
  packages/signaling/tests/push-budget.test.ts \
  packages/signaling/tests/push-dismiss.test.ts \
  packages/signaling/tests/push-dyn-category.test.ts \
  packages/signaling/tests/push-kind.test.ts \
  packages/signaling/tests/apns.test.ts \
  packages/signaling/tests/front-door.test.ts \
  packages/signaling/tests/limits-config.test.ts
```

The corrected isolated selection is:

```sh
bun test packages/signaling/tests/e2e/client-admission.e2e.test.ts \
  -t 'the close code and reason the peer chose'
```
