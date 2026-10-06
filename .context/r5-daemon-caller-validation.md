# R5 daemon caller validation

This record describes source and local evidence for #1200. It does not establish
shipping native notification verification, signed-device delivery, a deployed
Worker, or complete R5/R7 acceptance. The relay remains opt-in.

## Reachable source path

The CLI constructs `SecurePushContexts` with lazy actual registry and neutral
harness validity readers. `createNewSession` begins a fresh runtime before the
message API or harness is built. Failed setup, actual session closure and process
cleanup invalidate the captured runtime before asynchronous disposal. Failed
cleanup retains the original setup error and removes its notifier/harness maps.

With relay enabled, the stable unlocked machine identity supplies the real signer.
The CLI constructs the durable `SecurePushStore`, production HTTPS-only transport
and `SecurePushService`. Hub-created children inherit explicit relay opt-in and
the configured signaling URL. The service reaches question, terminal notice,
turn-failure/recovery, turn-complete, foreign-session, harness-denied and subagent
notification callers. Secure fan-out occurs once outside the legacy-token loop.

Actual durable recipients and preferences select delivery. Preparation and the
final network invocation separately check grant, enrollment, subscription,
runtime, complete question meaning and the original deadline. A prepared context
has one cached delivery promise. Fan-out precedence is accepted, then uncertain,
then failed; uncertainty neither resends automatically nor answers a held hook.

Plaintext compatibility defaults off and requires both the explicit configuration
flag and a secret, plus the durable monotonic secure-activation guard at fetch.
Push diagnostics use fixed operation/outcome strings. Actual callback/store tests
check question/status details, tokens, client IDs and raw persistence errors.
This is a claim about the tested push paths, not every log in the daemon.

## Independent source CLI acceptance

At immutable 775215de, an owned source `--daemon --relay --auth` process ran an
executable synthetic Claude with isolated state and durable synthetic recipient
authority. A private CA was trusted only by that child via
`NODE_EXTRA_CA_CERTS`; TLS verification stayed enabled. The production transport
used a canonical HTTPS audience through an owned proxy to the real Workerd,
SQLite-backed room, actual authenticated host enrollment, APNs JWT generation and
an owned APNs receiver. No model, user identity or production credential was used.

Each Bun 1.4.2 and 1.3.11 run passed 20 concrete checks: initially one signed sealed
actionable request, successful actual content verification/decryption, the actual
child session binding, no local session/question IDs in outer request metadata,
and a still-pending held hook. Local unstick returned an empty response rather
than approval. Subsequent notice/dismiss effects brought the receiver total to
three, with three successful gateway replies and natural CLI exit zero. A
submitted command sentinel was absent from diagnostics. Owned process audits
ended with zero residuals (six and seven observed processes respectively).

Private receipts are under
`/private/tmp/remi-r5-authority-review.op8vw1_f/cli-https-jq68Ry/receipt.json` and
`cli-https-8vUBzr/receipt.json`. These local artifacts are not durable release
receipts. This exact source checkpoint precedes the corrections below.

After those corrections, exact f6e4a6d7 repeated the production-HTTPS fixture on
both actual runner and child runtimes. Each run passed 21 checks, adding an
assertion that the whole bounded actual command appears in the authenticated
signed body. The earlier hook, identity, ciphertext, unstick, natural-exit and
zero-owned-residual checks also pass. Receipts are `cli-https-d4BBJX/receipt.json`
and `cli-https-U1O8el/receipt.json` under the same private review directory.
The independent corrective source review found no remaining actionable finding
in its scope and produced 12 named assertion mutation kills across both runtimes,
with exact production bytes restored. Its fixed-source review receipt separately
records one excluded executable-path typo that ran no tests.

## Causal corrections after independent review

The reviewer used actual held hooks, durable stores, shared crypto and owned
network effects; each red below failed named assertions on both Bun versions.

- 6076cf89: two uncertainty result failures, 10 assertions. Source 0d3f9456
  preserves uncertainty in service and dispatcher results. Restored tests pass
  two cases/10 assertions; the actual socket-loss effect remains single and the
  held permission remains pending.
- 2e66171b: one complete Read ask failure, nine assertions. Source 998bc434
  builds secure display text before the legacy 200-character preview truncation.
  Oversize full meaning produces information without approval actions.
- 88fc8394: one distinct actual Claude turn failure, six assertions. Source
  7f99b4d0 preserves actual prompt/turn occurrence identity in internal context
  meaning, while retaining the collapse slot and duplicate cache. Restored pin
  passes one case/nine assertions. A separate actual Codex app-server/PTY test
  passes one case/two assertions for two distinct turn IDs and one duplicate.
- cca4ad98: one hidden Bash argument failure, seven assertions. Source 24ee6e94
  preserves the complete selected argument in question detail when the display
  summary omits its middle. The restored actual held Bash case passes all seven
  assertions and exposes no action when the full meaning cannot fit.
- 54186320: one actual foreign-session socket-loss diagnostic failure, 10
  assertions. The service already retained uncertainty, but this informational
  caller converted it to a boolean and logged definite failure. It now preserves
  accepted/uncertain/failed precedence in its fixed diagnostic. The real effect
  remains single, its verified payload remains informational, and the existing
  foreign-session rate limit prevents repetition. The whole event group passes
  12 cases/151 assertions on both versions after correction.

The corrected Read/uncertainty focused group passes 15 cases/108 assertions on
both versions. The complete-detail legacy/harness regression group passes 114
cases/648 assertions on both. The source launch characterization passes four
cases/42 assertions on Bun 1.4.2. Exact final caller/full-suite acceptance is
tracked separately after the current head is frozen.

Earlier incorrect test-name filters selected zero tests, and an initial Codex
fixture supplied `id` instead of the real `turnId` field. Their retained receipts
are excluded from behavioral red/pass claims. Original obsolete log expectations
were corrected explicitly to fixed diagnostics; assertions were not removed.

## Context and lifecycle evidence

At immutable 998bc434, independent context/service audit baselines pass 20 cases/
161 assertions on both versions. Final committed causal pins pass 23 cases/185
assertions. Twenty-two independent mutation families produce 44 named assertion
kills, with source restored and zero owned process residuals. They cover fresh
runtime identity, replacement/finish, immutable expiry, no renewal, full question
meaning, registry presence, absorbing dismiss, live capacity refusal, digest
binding, exact current recipient, cached delivery/uncertainty and fresh failure
after a prior dismissal. Later occurrence/command-detail source is outside this
audit's scope.

An initial finish-invalidation variant survived because entry removal already
invalidated the old context. The original survivor logs were preserved; a real
recapture-after-finish assertion then killed that same variant on both runtimes.
Ambiguous mutation setup attempts before source alteration are excluded.
Private marker `/private/tmp/remi-r5-context-audit-path` identifies the receipts.

Six real signer-completion delays exercise runtime retirement, registry
removal, option changes, reauthorization, subscription rotation and original
deadline expiry through actual service/dispatcher paths. Final runs pass six
cases/24 assertions on both versions. They delay return of an actual signature,
not a crypto, authority, hook or transport implementation.

Signed hardware, the production Apple HTTP/2 path, native verified action routing,
R6 sealed answers, deployed acceptance and the final shipping-client soak remain
pending. An APNs receiver acceptance is not evidence of device presentation.

## Fresh dependency declarations

The first fresh, frozen f6e4a6d7 checkout stopped at root typechecking, before any
full tests: the Worker test harness's `net.Server.once` declaration was missing.
The locked graph contains Node 24.10.6 and a nested Node 25.0.5 type package.
Their merged ambient declarations left the selected server's event base
unresolved. The original worktree's successful static check instead loaded an
ancestor type package outside the repository, so it is not fresh acceptance.

Declaring the already locked exact Node 24.10.6 types directly at the root makes
the compiler resolve all Node references to the repository's own Node 24
declarations. An independent clean counterfactual passes all four package type
checks and confirms only those declarations are loaded. Only the root manifest
and matching lock workspace declaration change; no package version or integrity
record changes, no cast bypasses the server's error handler, and no runtime code
changes. The failed fresh receipt remains at
`/private/tmp/remi-r5-daemon-combined-gates-path`; subsequent exact-head gates
must start from a new frozen checkout.
