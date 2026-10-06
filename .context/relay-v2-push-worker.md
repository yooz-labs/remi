# R5 shared push codec and Worker boundary

This describes the source implementation on the R5 branch. It is not deployment,
handset delivery, native extension, signed entitlement or physical-device acceptance.
The daemon subscription/dispatch callers and native consumers integrate separately.

## Actual caller path

`packages/signaling/src/index.ts` admits only POST `/v2/push/<32 lowerhex rid>`
without query aliases, and only after the deployment bearer is checked: the request
must carry `Authorization: Bearer <PUSH_SECRET>`, compared in constant time over
SHA-256 digests (`bearer.ts`) before the path, the body or any budget is touched. An
unset or blank `PUSH_SECRET` refuses every request, a refusal is the fixed typed
`UNAUTHORIZED` result with HTTP 401, and the bearer is not forwarded to the room.
The Worker then reads at most 8192 UTF8 bytes before parsing and asks the real global
limiter for a durable address/aggregate attempt verdict. The named room constructs
`PushGateway` in `connection-room.ts`; the gateway strictly decodes the unchanged
original body and checks the explicitly configured audience.

The daemon's `SecurePushTransport` sends the same bearer from `--push-secret` /
`REMI_PUSH_SECRET` on every attempt. With no secret configured `cli.ts` builds no
secure push service and logs one line (never the value).

`packages/shared/src/relay/push.ts` supplies bounded duplicate-decoded-member
rejection, canonical public encodings and reviewed small-order key rejection,
content/submit signing tuples and strict typed results. Producers use fixed JSON
field order. Inner verification authenticates the original payload bytes. The outer proof binds
the fixed decoded submit tuple (below) and the sealed-byte digest. Valid reordered, whitespace
or escaped field names are not rejected merely for their encoding.
The seal/open helpers require the actual machine signer, pinned recipient context,
explicit random source and caller time. The content opener verifies the machine
signature before interpreting the inner semantic payload.

## What the Worker sees

The Worker cannot decrypt notification content. It checks the actual currently enrolled
device row and the machine submit proof; it cannot attest native Keychain storage.

In each submit body (every field below is signed by the machine key):

- the room id `rid` and `machinePublicKey` (the room id is its hash), and the
  `devicePublicKey` the submit names (checked against the enrolled row);
- the delivery `token` and its `environment` (`production` or `sandbox`), and the
  `audience` (the Worker's own origin);
- `collapseId`, an opaque random 16 byte id that becomes `apns-collapse-id` and is the
  sealed content's AAD;
- `pushClass`, `alert` or `background`: it picks the APNs push type and priority and
  nothing else, so it separates a dismissal from every other event;
- `nonce`, `issuedAt` and `expiresAt` (the submit is valid for at most 60 seconds);
- `storeUntil`, which becomes `apns-expiration`: the content expiry, never earlier than
  `expiresAt` and at most 3600 seconds after `issuedAt`. It reveals the content lifetime,
  which separates informational events (at most 300 seconds) from questions and
  dismissals (at most 3600 seconds);
- `sealed`, opaque bytes (an ephemeral public key, a nonce and AES-GCM ciphertext) whose
  length is visible;
- the signature, and the derived `requestDigest` it returns.

In the request: the bearer (verified, never stored or forwarded), the caller's address
(only a hash is counted, in budget keys), and size and timing.

What it stores: the enrolled device rows (public key, enrollment time, an internal random
epoch), nonce rows (digest, epoch, retention deadline, fixed typed outcome) and budget
counters keyed by hashes of the address, room and token. No notification content.

What it sends to Apple: the token, topic, a provider JWT, `apns-collapse-id`,
`apns-push-type`, `apns-priority`, `apns-expiration` and the body described below: of the
submit fields above Apple receives the token, the collapse id, the push class (as headers), the
expiry and the carrier's room id and sealed bytes, not the public keys, nonce or signature.

What it never sees: the event kind, the key version, the revision, the push key, the
question or session id, any title, body or option label, and any private key. The
collapse id still links an alert, its re-pushes and its dismissal to one another, and the
token links every push to one device; the `pushClass` and `storeUntil` visibility above
is deliberate.

Nonce rows retain only digest, internal epoch, retention deadline and fixed typed
outcome. Budget keys hash addresses/tokens.

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

Everything that can fail before Apple runs before the nonce is consumed: missing APNs
credentials, the provider JWT import and signing (local work, not a network effect) and
the request build. Each failure is reported as what it is (`APNS_UNAVAILABLE`, retryable,
or `OVERSIZE`) and leaves no pending nonce. Then the send budget is charged, and a
synchronous transaction rereads current authority and consumes an exact digest/epoch-bound
pending nonce. Sync completes before the receiver is invoked. Authority is rechecked
after sync. Immediately before fetch, the same epoch, pending nonce ownership and signed
expiry are checked synchronously, with no intervening await. No network operation runs
inside `blockConcurrencyWhile`.

Nonce capacity is 4096 per room, with retention through submit expiry plus 60 seconds.
Capacity refuses rather than evicting live entries. Only an original submission that remains unexpired may consult its retained result
or uncertain outcome. The extra 60 seconds of retention prevents nonce reuse; it
does not extend eligibility or provide a separate status route, and `storeUntil` does not
extend it either. Different content with its nonce is refused.
Concurrent identical submissions initiate at most one effect. A pending record
survives the tested orderly workerd restart as uncertain. Physical crash durability
is not measured by that restart test.

`accepted` means the actual APNs endpoint returned success, not handset delivery.
Known pre-effect rejection may be persisted as fixed nonretryable refusal.
Lost/aborted responses, consumed-pending restart and post-effect persistence failure
are uncertain. They never authorize automatic resend, a replacement nonce, or
release of a held harness decision. A later revoke cannot undo an invoked fetch.

What Apple's answer means:

| Apple | Worker result | The same signed bytes |
|---|---|---|
| 2xx | `accepted` (retained) | served from the retained result |
| reason `BadDeviceToken`, `Unregistered` or `DeviceTokenNotForTopic` | `INVALID_TOKEN`, not retryable (retained) | served from the retained result |
| 429, any 5xx, or 403 `ExpiredProviderToken` | `APNS_UNAVAILABLE`, retryable; the pending nonce is released (an expired token also mints a fresh JWT) | can succeed on a later attempt while the submit is valid |
| any other refusal (bad topic, bad payload, invalid provider token) | `APNS_REJECTED`, not retryable (retained) | served from the retained result |
| no usable answer (timeout, drop) | `uncertain` | never resent |

The daemon retries only the reasons the Worker marks retryable and only the same signed
bytes while the submit is valid: a budget refusal waits for the `Retry-After` the Worker
sent (the seconds until the next fixed window), anything else backs off exponentially, and
a wait the submit cannot outlive ends the delivery with the Worker's verdict.

## Network payload and policy ceilings

`buildSecureApnsRequest` emits only `aps` and the four-field `remiPush` carrier
`{v, rid, collapseId, sealed}`. Alerts contain generic fallback text, empty actions/category and
mutable-content; dismissals (`pushClass` `background`) are quiet background notifications at
priority 5. The carrier names only what the extension needs before it can decrypt; the key
version and kind are checked from the signed tuple after decryption. The signed environment
selects one APNs host; no v2 environment fallback exists. Topic is Worker-owned. Final UTF8
JSON is checked against 4096 bytes; the maximum valid carrier framing fits below
that ceiling. An independent invalid typed-input test pins the final builder guard.

The response wait is bounded by the smaller of 10 seconds and positive remaining
signed submission expiry. An owned AbortController timer starts immediately before
fetch and is cleared afterward. Expiry is not extended while waiting. Raw APNs
response bodies and exceptions are never returned as push errors or logged here.

Separate durable fixed 60 second send policies are address 120, room 30 (alerts), room
300 (background pushes, counted apart so a burst of alerts cannot leave answered cards on
lock screens, #723), token-hash 10 and aggregate 600; the address, token and aggregate
policies are shared by both classes. Separate precrypto attempts are address 120 and
aggregate 600. Each mode retains at most 4096 current/previous-window records, refuses
capacity without partial increments, and reclaims only expired records. A rate-limit or
capacity refusal returns `Retry-After`, the seconds until the next window. Fixed windows permit boundary bursts.
These are policy defaults, not measured throughput/capacity.
Push overrides may lower these ceilings; existing R2 admission configuration and
its documented in-memory lifetime remain unchanged.

Production requires explicit canonical HTTPS `PUSH_AUDIENCE`, without credentials,
path, query or fragment. It never infers authority from the request host. While it is
unset or invalid every v2 push answers `WRONG_AUDIENCE`.
APNs credentials remain owner-managed; agents did not configure or deploy them.

Legacy plaintext POST `/push` is ON by default until the R7 gate (owner decision, #1200):
it is disabled only by an explicit false `LEGACY_PUSH_ENABLED` (`false`, `0`, `no` or `off`,
trimmed, any case) and always requires the `PUSH_SECRET` bearer, compared in constant time;
an unset or blank secret refuses everything. Its historical per-isolate budgets and
environment compatibility remain legacy. The v2 route shares only that bearer secret with
it. Removal criteria are in `docs/relay-worker-deploy-runbook.md`.

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
  packages/signaling/tests/bearer.test.ts \
  packages/signaling/tests/e2e/client-admission.e2e.test.ts \
  packages/signaling/tests/e2e/room-protocol.e2e.test.ts \
  packages/signaling/tests/e2e/limits.e2e.test.ts
uv run --with cryptography python scripts/verify-push-vectors.py
```

The ten public synthetic cross-engine vectors include all six kinds, exact
noncanonical signed JSON, actionable choices, an open-app setMode question and
informational question content without action authority. Each case's `submit` shows
exactly the fields listed under "What the Worker sees". Native display/category
and durable replay enforcement are separate required consumers; a codec/Worker
pass does not establish their acceptance. Full integration, deployed APNs,
provisioning and owner physical gates remain outstanding.
