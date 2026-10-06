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
For a root-origin signaling URL, the CLI constructs the durable `SecurePushStore`,
production HTTPS-only transport and `SecurePushService`. A path prefix, query,
fragment or credentials refuses service initialization with a fixed notice; it
does not infer the signed push route by dropping those components. Interactive
relay prefixes still work. Hub-created children inherit explicit relay opt-in and
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

## Compatibility fixtures and diagnostic privacy

The fresh 8c9b6efa gate passed all four package type checks, both scoped
integration type checks, Biome, typos and diff checks. Its Bun 1.4.2 full suite
then reported 7,128 passes, 22 skips and 13 failures, with zero tracked process
residuals. Bun 1.3.11's full suite was not started after that failure.

Two failures were obsolete conformance counts after the four secure-push wire
messages were added. The corrected shipping web/direct-daemon fixture exercises
both register and unregister requests and correlated unsupported responses.
The other eleven failures waited for a removed diagnostic or assumed implicit
legacy push. Positive legacy fixtures now opt in explicitly and wait for the
real durable token store; they retain their push, chat, transcript and session
assertions. The real default-off case still supplies a secret and a token and
observes the notification sink while asserting zero network effects.

Those actual source-CLI checks exposed two separate privacy defects: an admitted
Stop callback logged completion text, and an admitted StopFailure callback
logged an arbitrary unknown error string. Test-only commits 2a97dffb and
1840fe01 each failed at the named no-content assertion on both pinned runners
and children, with valid hook responses, zero network effects and zero process
residuals. The correction 687a3381 records fixed operation text at those two
callbacks and preserves dispatch and notification content. It removes the old
log-only truncation helper and corrects the stale comment in the same change.

The restored Claude Stop, session-notifier and hook-bridge regression group
passes 145 cases/519 assertions on each runtime, with zero natural tracked
process residuals. This includes the two real source-CLI privacy cases; it
does not establish that every daemon diagnostic is content-free. Receipt marker:
`/private/tmp/remi-r5-diagnostic-privacy-path`. A new frozen daemon-only gate is
required after these corrections; native R5 and final R7 remain separate.

The frozen 0f0e5ea9 daemon gate then passed all static checks and Bun 1.4.2's
full suite: 7,145 passes, 22 skips, zero failures and zero tracked residuals.
Before starting Bun 1.3.11, a further real wrapper CLI pin exposed private
question text in the tracker's parked-subagent diagnostic. The waiting owned
gate runner was stopped after verifying its process birth and checkout; its
successful first-runtime receipt is preserved, but it is not final acceptance
of the later correction.

Test-only 17d661c1 drives the real wrapper, synthetic Claude executable,
HookServer and passthrough permission gate into the parked tracker path and
fails solely because the owned diagnostic log contains the private command.
Five actual tracker subprocess probes cover keeping and replacing pending
records, parked rendering, immediate orphan suppression and suppression after
a real debounce timer. Each confirms unchanged sink/render behavior before
checking diagnostic privacy. The corrected fixture has real offered options;
the initial optionless render probe incorrectly expected a hook merge and is
preserved as an excluded fixture failure. The corrected six named privacy
cases fail with 29 assertions on each runtime before the source correction.

Source d4d37620 replaces only the six content-bearing debug templates with
fixed operation text. State transitions, matching, timers and payloads are
unchanged. Six individual old-log restoration variants produce twelve named
privacy assertion kills across both runtimes; restored controls pass six
cases/29 assertions each and the exact corrected source is restored. The
broader tracker, hook bridge, actual Claude Stop/notifier and wrapper group
passes 225 cases/734 assertions on each runtime with zero natural tracked
process residuals. Marker `/private/tmp/remi-r5-tracker-privacy-path` identifies
the causal receipts; the regression receipts use the diagnostic privacy marker
above. Final frozen full-suite acceptance remains pending after this correction.

Independent review of the earlier 687a3381 callbacks and the shipping direct
client's correlated register/unregister refusal pins is clear. Its four source
families produce eight named assertion kills across both runtimes, with actual
CLI/direct-client baselines and restored controls passing four cases/15
assertions each. These receipts are separate from the tracker correction and
do not establish native or owner acceptance.

## Root-origin push routing correction

A fresh source review found that the CLI discarded a custom signaling path,
query or fragment before constructing the push audience. The interactive relay
preserved its prefix, while push silently posted to the origin root. Actual
source-CLI controls at cfd91fd8 reproduced the prefix, query and fragment cases
through owned TLS, the real SQLite Worker and an owned APNs receiver. Each
reached the held hook, verified the original signed content and exited naturally
before failing the named wrong-root assertion: three POSTs and no refusal notice.

Source 2c7ceb17 accepts only a raw HTTPS/WSS root authority with an optional root
slash. It refuses credentials, prefixes, dot segments, backslashes, whitespace,
queries and fragments before normalization, emits a fixed notice and creates no
push service. The interactive prefix route and signed push tuple are unchanged.
The first helper test run exposed a trailing-space omission in the new regex;
that receipt remains preserved. The corrected focused group passes 53 cases/232
assertions on both runtimes.

At final fixture head f0ef0235, both the root and independent reviewer ran all four
actual CLI modes on Bun 1.4.2 and 1.3.11, with the child using the same runtime.
Each root control passes 25 checks and receives three authenticated encrypted
notifications. Each unsupported form passes 17 checks, observes the fixed refusal,
posts nothing and receives no APNs effect. Every CLI exits zero. Root tracked
process receipts end naturally with zero residuals. The standalone fixture is
included in the scoped integration typecheck; its gateway observation waits for
both the APNs callback and gateway result before evaluating delivery.

Independent restoration of the old CLI derivation, with the fixed helper still
present, kills the named wrong-root prefix assertion on both runtimes after 23
behavior checks. Exact restoration passes the root and prefix controls again.
There is no setup exception or timeout counted as a mutation kill. Review is clear
within this component scope. Root receipts use `/private/tmp/remi-r5-route-root-path`;
the independent receipt is `/private/tmp/remi-r5-route-review.tGXQ8q/final-receipt.json`.

The previous frozen cfd91fd8 static checks and full Bun 1.4.2 run passed 7,151
cases with 22 skips, zero failures and zero tracked residuals. The waiting runner
was stopped only after verifying its PID, birth, command and cwd, before starting
Bun 1.3.11, because this new finding superseded that checkpoint.

Fresh frozen ac4e2d3d then passes all four package typechecks, both scoped
integration typechecks, Biome (52 existing warnings, zero errors), typos and diff
checks. Full Bun 1.4.2 and 1.3.11 each pass 7,173 cases, with 22 skips and zero
failures across 364 files (351.91 and 360.98 seconds respectively). Line coverage
is 91.68% and 91.69%. Tracked descendant audits observe 505 and 525 processes,
end with zero residuals, and separate exact-checkout command/cwd censuses find
none. The frozen checkout remains clean. Receipts use
`/private/tmp/remi-r5-daemon-route-gates-path`, including `audit-142.json` and
`audit-1311.json`. These complete the daemon component's local gates; native R5,
whole-phase integration and owner R7 acceptance remain separate.
