# R5 daemon push transport component validation

This is component evidence, not release acceptance. The root-owned runtime/context,
CLI/config and dispatcher integration is separate. Signed hardware, deployed Worker,
production Apple delivery, and native notification/action acceptance remain owner R7 gates.

## Actual callers and API

`notifications/secure-push-transport.ts` constructs with a real machine `relayV2.Signer`,
a real `SecurePushStore`, and a configured canonical HTTPS origin. It selects neither
recipient nor URL from a response. The explicitly named `forOwnedLoopbackTest` factory
allows only an exact configured canonical `http://127.0.0.1` origin; normal construction
refuses HTTP. The factory is a network test seam, not an authority or crypto bypass.

`prepare(snapshot, metadata, payload, isCurrent)` copies the snapshot, payload and metadata
before awaiting. It binds the actual signer public key and derived room ID, device key,
push public key and version. It calls the actual codec for payload, content signing,
sealing, submit signing and proof validation. Content and request digests come from the
codec's validated `LP(label,32-byte digest)` signing input, without a duplicated tuple.
Actual store and synchronous context checks follow each asynchronous stage.

Preparation returns either `{outcome:'prepared', prepared}` or a fixed local refusal.
The frozen prepared capability exposes `carrier`, `contentDigest`, `requestDigest`,
`submitNonce`, and `expiresAt`. Its exact encoded request, snapshot and callback are
private in a per-transport WeakMap. Forged or foreign capabilities are refused. The
submit nonce is generated once; its TTL is at most 60 seconds and never exceeds the
captured content expiry. Concurrent or repeated `sendPrepared` calls share one finite
result, including uncertainty; they do not start another send loop.

`sendPrepared` invokes actual fetch inside the same synchronous
`SecurePushStore.withCurrentSubscription` callback as the current grant, enrollment,
subscription, context and absolute expiry check. It releases the file lock before awaiting
network I/O. Fetch refuses redirects. Each effect has an AbortController with a wait of
`min(12000ms, remaining submit expiry)`, cleared in `finally`. Responses have an independent
512-byte bound, fatal UTF8 decoding, and the actual shared typed outcome decoder.

Only a matching request digest and an explicitly retryable fixed RATE_LIMITED, CAPACITY
or STORE_ERROR refusal can retry, at most three attempts by default, with the same bytes
and original expiry. Accepted, final rejection, malformed/oversize/lost response,
uncertainty and digest mismatch do not retry or mint a nonce. Acceptance means the Worker
reported actual APNs acceptance, not device delivery. Delivery returns fixed
`accepted`, `rejected`, `uncertain`, or local `refused` outcomes with attempts.
Local refusal codes are AUTHORITY_CHANGED, NOT_CURRENT, EXPIRED, STORE_ERROR,
INVALID_CONTENT and NOT_PREPARED; no arbitrary remote body or exception string is logged.

The existing `notifications/push-client.ts` is explicitly plaintext compatibility only.
It requires `legacyEnabled === true` and a nonblank configured secret before reading its
authority directory or dialing. Every test supplies a private directory. Payload bytes
are fixed before `withLegacyPushEligibility`; actual fetch is invoked synchronously
inside that authorization lock, and awaited outside. Actual secure activation, raw legacy
enrollment, or corrupt state refuses. Removed rows do not undo activation. It emits no
token prefix, content or arbitrary receiver body. Errors are fixed LEGACY_PUSH_DISABLED,
SECRET_REQUIRED, INVALID_CONTENT, INVALID_URL, NOT_ELIGIBLE, REJECTED or UNCERTAIN
(all with the LEGACY_PUSH_ prefix). Root must explicitly forward any legacy configuration;
this change enables no legacy caller by default.

## Red evidence and corrections

The first 4fe0994e pins produced four real legacy guard expectation failures on both Buns.
The three absent-file assertions in that run are API-presence evidence only and are excluded
from behavioral red acceptance. The c260aa71 fail-closed constructor scaffold then produced
three named preparation/refusal outcome failures on both Buns before implementation.

An expanded receiver fixture initially passed a signed record to the strict unsigned-input
builder, which correctly refused the extra signature field before some expectations.
`transport-expanded-{142,1311}.log` preserves those invalid fixture attempts; they are not
passes or mutation kills. The corrected fixture explicitly extracts unsigned fields.
A temporary type-import formatter/TypeScript syntax mismatch was corrected to a normal
`import type` before the clean 902f95ea coverage checkpoint; no source behavior changed.

The final factory audit found its own comment broader than its check: it also accepted
canonical HTTPS through the normal constructor. a6ac9864 pins the named refusal on both
Buns; 09280fd4 narrows only the test factory. Production HTTPS policy and wire tuples are
unchanged. This is the only executable transport delta after the 73e5782c source checkpoint.

## Focused gates and boundaries

Run with a disposable 0700 HOME, REMI_QUESTION_TRACE=0, and E2E_BUNDLER=esbuild:

```sh
bun test packages/daemon/tests/push-client.test.ts \
  packages/daemon/tests/notifications/legacy-push-boundary.test.ts \
  tests/integration/secure-push-transport.test.ts \
  packages/daemon/tests/license-boundary.test.ts \
  packages/daemon/tests/notifications/secure-push-store.test.ts \
  packages/daemon/tests/auth/relay-enrollment-epoch.test.ts
node_modules/.bin/tsc --noEmit -p tests/integration/tsconfig.secure-push-transport.json
bun run typecheck
bun run typecheck:web
bun run typecheck:web-tests
bun run typecheck:signaling
node_modules/.bin/biome check .
typos
git diff --check
```

The real integration constructs the actual daemon transport/store, actual shared crypto,
real Worker and SQLite-backed Durable Object in Miniflare/workerd, actual APNs JWT, and
an owned network APNs receiver. The measured receiver protocol is HTTP/1.1, not production
HTTP/2. Other response pins use owned real HTTP receivers to exercise malformed, oversized,
uncertain, mismatched and retryable response boundaries; they do not claim real Worker
budget/restart coverage (that is in the separate Worker tests). Actual socket destruction
pins network loss. Actual signer completion delivery is delayed around real file mutations;
no crypto/store/policy implementation is replaced. The current-callback pin uses actual
QuestionStore membership/removal and does not claim the root runtime context is integrated.
A separate owned Bun child captures real legacy diagnostics and is awaited after exit.

The signature pin now explicitly counts two actual signatures (one per content/submit
tuple), and proves retries call neither signer again; its original ambiguous test title
was corrected without removing assertions.

Final focused run: 74 pass, 0 fail, 420 assertions across six files on EACH Bun
1.4.2 and 1.3.11. All four package typechecks and the scoped integration check pass.
Pinned Biome 1.9.4 reports 0 errors and the 52 existing warnings; typos/diff pass.
The final owned process audit is empty. The final test-factory mutation has its own
passing baseline/restoration; the preceding complete private two-file baseline and
restoration each pass 36 tests/212 assertions on both versions.
No full monorepo suite was run by this worker.

## Named private mutations

Twenty-one independent families fail by named expectations on each runtime, 42 accepted
assertion kills, with passing baselines and restored runs. No setup failure, business
exception or timeout is counted. Families:

- https-only, content-digest, metadata-copy, payload-copy, preparation-authority
- effect-authority, effect-current, effect-expiry, local-store-refusal
- body-byte-bound, response-digest, no-redirect-authority, response-deadline
- known-retry-budget, uncertainty-final, prepared-reuse
- legacy-default-off, legacy-secret, legacy-eligibility, legacy-no-private-logs
- test-factory-scope

Receipts are private temporary artifacts: `/private/tmp/remi-r5-transport-state-path`
identifies the focused/red logs; `/private/tmp/remi-r5-transport-mutants-path` identifies
`receipts.json`, each family/version log, baseline/restored logs and the clean private clone.
These markers are local and are not durable release receipts. Original invalid attempts
remain preserved separately. All tests use disposable synthetic identities and owned
listeners; no deployed endpoint, user state, model invocation, or credentials are used.
