# R5 shared push codec and Worker boundary

This describes the source implementation on the R5 branch. It is not deployment,
handset delivery, native extension, signed entitlement or physical-device acceptance.
The daemon subscription/dispatch callers and native consumers integrate separately.

## Actual caller path

`packages/signaling/src/index.ts` admits only exact POST `/v2/push/<32 lowerhex rid>`
without query aliases. It reads at most 8192 UTF8 bytes before parsing, then asks the
real global limiter for a durable address/aggregate attempt verdict. The named room
constructs `PushGateway` in `connection-room.ts`; the gateway strictly decodes the
unchanged original body and checks the explicitly configured audience.

`packages/shared/src/relay/push.ts` supplies bounded duplicate-decoded-member
rejection, canonical public encodings and reviewed small-order key rejection,
content/submit signing tuples and strict typed results. Producers use fixed JSON
field order. Inner verification authenticates the original payload bytes. The outer proof binds
the fixed decoded metadata tuple and sealed-byte digest. Valid reordered, whitespace
or escaped field names are not rejected merely for their encoding.
The seal/open helpers require the actual machine signer, pinned recipient context,
explicit random source and caller time. The content opener verifies the machine
signature before interpreting the inner semantic payload.

The Worker cannot decrypt notification content. It checks the actual currently
enrolled device row and the machine submit proof; it cannot attest native Keychain
storage. It sees public keys, delivery token/environment, nonce/times/revision,
sealed bytes and network metadata. Nonce rows retain only digest, internal epoch,
retention deadline and fixed typed outcome. Budget keys hash addresses/tokens.

## Durable authority and effect order

A new enrollment gets a random 32-byte internal epoch. Idempotent enrollment keeps
the existing row. R2's configured enrollment limit remains supported, including
values above its default 64; R5 does not scan or migrate an entire room at startup.
A valid legacy `{at}` row receives an epoch lazily inside `transactionSync` when
first captured for push. An absent row is never enrolled by naming it in a push.
Revoke deletes the row and retires its matched sockets before waiting for sync.
Re-enrollment creates a fresh epoch, so an old awaited submission cannot revive.

The gateway captures the existing row before async proof or budget work, waits
for real `storage.sync()` and rechecks that same captured epoch. Absence, invalid
stored authority and failed initial sync do not expose enrollment-specific codes
before bounded machine-proof verification. Invalid signatures have the same fixed
verdict for present and absent rows; this does not claim equal timing.

After proof and durable send-budget approval, a synchronous transaction rereads
current authority and consumes an exact digest/epoch-bound pending nonce. Sync
completes before actual APNs JWT import/sign or fetch. Authority is rechecked after
sync and JWT awaits. Immediately before fetch, the same epoch, pending nonce
ownership and signed expiry are checked synchronously, with no intervening await.
No network operation runs inside `blockConcurrencyWhile`.

Nonce capacity is 4096 per room, with retention through submit expiry plus 60 seconds.
Capacity refuses rather than evicting live entries. The same exact request returns
its retained result or uncertain; different content with its nonce is refused.
Concurrent identical submissions initiate at most one effect. A pending record
survives the tested orderly workerd restart as uncertain. Physical crash durability
is not measured by that restart test.

`accepted` means the actual APNs endpoint returned success, not handset delivery.
Known pre-effect rejection may be persisted as fixed nonretryable refusal.
Lost/aborted responses, consumed-pending restart and post-effect persistence failure
are uncertain. They never authorize automatic resend, a replacement nonce, or
release of a held harness decision. A later revoke cannot undo an invoked fetch.

## Network payload and policy ceilings

`buildSecureApnsRequest` emits only `aps` and the six-field `remiPush` carrier.
Alerts contain generic fallback text, empty actions/category and mutable-content;
dismissals are quiet background notifications. The signed environment selects one
APNs host; no v2 environment fallback exists. Topic is Worker-owned. Final UTF8
JSON is checked against 4096 bytes; the maximum valid carrier framing fits below
that ceiling. An independent invalid typed-input test pins the final builder guard.

The response wait is bounded by the smaller of 10 seconds and positive remaining
signed submission expiry. An owned AbortController timer starts immediately before
fetch and is cleared afterward. Expiry is not extended while waiting. Raw APNs
response bodies and exceptions are never returned as push errors or logged here.

Separate durable fixed 60 second send policies are address 120, room 30, token-hash 10
and aggregate 600. Separate precrypto attempts are address 120 and aggregate 600.
Each mode retains at most 4096 current/previous-window records, refuses capacity
without partial increments, and reclaims only expired records. Fixed windows permit
boundary bursts. These are policy defaults, not measured throughput/capacity.
Push overrides may lower these ceilings; existing R2 admission configuration and
its documented in-memory lifetime remain unchanged.

Production requires explicit canonical HTTPS `PUSH_AUDIENCE`, without credentials,
path, query or fragment. It never infers authority from the request host.
APNs credentials remain owner-managed; agents did not configure or deploy them.
Legacy plaintext POST `/push` is default off and requires both exact
`LEGACY_PUSH_ENABLED=true` and configured `PUSH_SECRET` with its exact bearer.
Its historical per-isolate budgets and environment compatibility remain legacy.
There is no v2 shared secret.

## Focused verification and honest test seams

`packages/signaling/tests/e2e/push.e2e.test.ts` constructs real Miniflare/workerd,
SQLite Durable Objects, actual generated synthetic keys, shared signing/sealing,
JWT generation and an owned loopback HTTP/1.1 APNs receiver. Only the actual network
destination is replaced. The test-only audience exception permits only the exact
configured owned HTTP on 127.0.0.1 origin; a production-validator pin rejects HTTP.
The port is allocated before the first runtime start and its actual ready URL is
checked. There are no account credentials, production identities or model calls.

For interleaving pins, real storage.sync and JWT operations finish first; controlled
completion delivery then permits revoke/re-enroll. Injected completion errors are
I/O-boundary tests, not claims about a physical disk failure. Nonce/budget restart
pins dispose and reconstruct actual workerd over owned persisted SQLite state.
Low configured bounds exercise capacity and budgets without flood/load tests.

Run the real gateway and affected relay callers with an isolated private HOME,
pinned Bun and `E2E_BUNDLER=esbuild`:

```sh
bun test packages/signaling/tests/e2e/push.e2e.test.ts \
  packages/signaling/tests/secure-apns.test.ts \
  packages/signaling/tests/e2e/client-admission.e2e.test.ts \
  packages/signaling/tests/e2e/room-protocol.e2e.test.ts \
  packages/signaling/tests/e2e/limits.e2e.test.ts
python3 scripts/verify-push-vectors.py
```

The ten public synthetic cross-engine vectors include all six kinds, exact
noncanonical signed JSON, actionable choices, an open-app setMode question and
informational question content without action authority. Native display/category
and durable replay enforcement are separate required consumers; a codec/Worker
pass does not establish their acceptance. Full integration, deployed APNs,
provisioning and owner physical gates remain outstanding.
