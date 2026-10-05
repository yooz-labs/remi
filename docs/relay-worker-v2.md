# Relay Worker v2

What the Cloudflare Worker in `packages/signaling` does after R2 (issue #1197), and what it does not.
Every sentence here is meant to be true of the code that ships (ADR 0011); anything not verified against a deployed Worker is labeled unverified.
The cryptographic protocol that runs through the Worker is [ADR 0034](../.context/decisions/0034-relay-v2-protocol.md).
This document is the layer below it: the Worker's own routes, messages, limits and state.

## Status

- The Worker is **not deployed by this change**.
  No agent holds Cloudflare credentials and none contacted a Cloudflare account; the owner deploys, from [the runbook](relay-worker-deploy-runbook.md).
- **No shipped client speaks it.**
  The daemon's `RelayAdapter` still speaks the v1 protocol that this Worker no longer serves (its `/connect/<code>` route is gone), and the relay is off by default.
  R3 (daemon) and R4 (client) are the first real endpoints; until then the only endpoints are the fake host and fake client of `packages/signaling/tests/e2e`, which use the real relay library from `packages/shared`.
- Everything below was exercised against the real Durable Object running in workerd through the Miniflare library, from `bun test`.
  That is the open-source runtime, locally; it is not the deployed Cloudflare fleet.

## What the Worker is

A courier.
It admits sockets, pairs a client with the host's pipe, and forwards bytes it never parses.
With conforming v2 endpoints, session payloads (including session ids) and device names are encrypted, and private keys and the pairing secret never reach it.
It sees public keys, admission metadata and the plaintext `hello` / `hello_ack` handshake listed under "What the Worker sees".
The separate legacy `POST /push` route still receives plaintext notification data; the v2 confidentiality claim does not cover it.
Nothing in the end-to-end protocol depends on the Worker behaving (ADR 0034 section 4).

## Topology

One Durable Object per machine, named by the **room id**: the first 16 bytes of SHA-256 of the machine's Ed25519 public key, as 32 lowercase hex digits in the path.
The room has no time-to-live and no code.
It lives while the host's control socket does, and a room with no sockets costs nothing but its stored enrolled keys.

| Route (WebSocket upgrade) | Who | How many |
|---|---|---|
| `GET /v2/host/<rid>` | the machine's control socket | one; a new admitted one replaces the old |
| `GET /v2/client/<rid>` | an enrolled device, or one pairing with a ticket | one live per device key, up to a cap |
| `GET /v2/pipe/<rid>/<cid>` | the host's socket for one client connection | one per client |

The version is part of the path and is never negotiated.
`<cid>` is the connection id the Worker gave the client (16 random bytes, 32 hex digits) and announced to the host.
Anything else (another version, upper-case hex, a trailing slash) is a 404 before any room is touched.

The host keeps one control socket and opens one pipe socket per client the Worker announces.
A pipe is exactly one client socket and one pipe socket; the end-to-end handshake of ADR 0034 section 6 runs inside it.

## Admission

Every socket is admitted before anything else happens.
The Worker sends each new socket, as its first message, a fresh 32-byte nonce from its own CSPRNG, valid for that socket and **one** use.
The endpoint answers with one `admit` message carrying its public key and an Ed25519 signature over `(role, room id, nonce)` (ADR 0034 section 4; the formats live in `packages/shared/src/relay/pairing.ts`).

| Socket | Admitted when |
|---|---|
| host control, pipe | `SHA-256(key)[0..16]` is the room id, the key is not a small-order key, and the signature verifies for the host role in this room over this socket's nonce |
| client, resume | the key is in the room's enrolled set, is not a small-order key, and the signature verifies for the client role |
| client, pairing | the client presents the ticket `A` whose hash the host registered for a live pairing window, the key is not a small-order key, the signature verifies, and the window is burned in the same storage transaction |

- **Every refusal is the same close** (code 4400, reason `closed`), so a refusal says nothing about which check failed.
  A stranger, a revoked device, a replayed admission, a wrong role, a wrong room, a small-order key and an oversized message are indistinguishable on the wire.
  What a client can tell apart is an HTTP-level refusal before the WebSocket exists (429 for a limit, 404 for a bad route, 426 for no upgrade).
- **Cheap checks run before the signature.**
  A device key that is not enrolled and presents no ticket is refused without a signature check.
- **The nonce is spent by the first attempt**, whatever its outcome, and an admission is accepted once per socket.
  A recorded admission replayed on another socket fails because that socket's nonce differs.
- **Small-order Ed25519 keys are refused** at admission and at enrollment (`isSmallOrderPublicKey`, ADR 0034 section 17.2).
  RFC 8032 verification accepts the all-identity signature under such a key for any message, and every engine measured accepts it, so without this check the identity point would pass a host proof whose room id is its own hash.

### The admission ticket

**The ticket `A` is Worker-visible and an abuse-control token only.**
The Worker sees `A` in clear when a client presents it, and the hash `SHA-256(A)` the host registered, so `A` must never be mistaken for a secret and the code never logs it.
`A` is an HMAC output and does not reveal the pairing secret, and the session keys need that secret inside the key derivation, so seeing `A` cannot yield a key.
What it can do is let whoever sees it first race the legitimate phone and burn the window: a denial of one ten-minute pairing, never a compromise.

- The host registers `SHA-256(A)` with a lifetime of 1 to 600 seconds over its control socket (`pairing`); at most eight windows are live (`MAX_PAIRING_OFFERS`).
- A presented ticket is compared with **every** live window through `admitTagMatches` (a constant-time comparison of `SHA-256(ticket)` with the registered hash), with no early exit.
  A source test bans `===`, `indexOf` and the like on any line of `admission.ts` or `connection-room.ts` that touches a ticket or a hash.
- The window is burned only after the signature verified, the per-device budget passed and client capacity was reserved, so a bad signature or a full room cannot burn it.
  A newer connection of an already-connected device uses that device's existing slot, and concurrent admissions reserve slots before awaiting the burn.
- The burn is one storage transaction that names the window by an internal handle, so two sockets presenting one ticket in the same moment admit at most one (a test presents it from four sockets at once).
- A window is single use whether or not the pairing then completes: the loser fails visibly and the host opens another.

## After admission

When the host's pipe socket and a client socket are paired, the Worker sends `open` to both.
From the next message on it forwards every text and binary message between exactly those two sockets, unparsed and unlogged, and sends nothing of its own.
It never relays a message that did not arrive on one of the two sockets, and a socket never receives anything meant for another connection.

The Worker looks at size only: text above `MAX_CONTROL_TEXT` (512 bytes) and binary above `MAX_FRAME` (524,313 bytes) close the sender, because the receiving library would refuse them as OVERSIZE.
When either socket closes, the other is closed with the same code and reason where a socket may legally send them, and with the generic close otherwise.
The edge answers the literal text `ping` with `pong` on every socket without waking the object; a `ping` is therefore never forwarded.

## Messages

Worker to endpoint (the codec is in `packages/shared/src/relay/worker-wire.ts`; all are JSON text):

| Message | When |
|---|---|
| `{"t":"nonce","n":"<b64u 32 bytes>"}` | first message on every socket |
| `{"t":"admitted"}` | to the host control socket, admitted |
| `{"t":"admitted","up":true\|false}` | to a client, admitted; `up` says whether the host is connected |
| `{"t":"host","up":true\|false}` | to a client that has not got its pipe: the host came or went |
| `{"t":"open"}` | to a client and a pipe: the pipe is formed |
| `{"t":"connected","c":"<cid>"}` | to the host: a client waits for a pipe |
| `{"t":"gone","c":"<cid>"}` | to the host: a client that was waiting for a pipe went away first |
| `{"t":"ack","r":"enroll\|revoke\|pairing","ok":true\|false}` | to the host: the outcome of its command |

Endpoint to Worker:

| Message | From | Effect |
|---|---|---|
| `{"t":"admit","k":"<b64u key>","s":"<b64u signature>"[,"a":"<b64u ticket>"]}` | any new socket | admission, once |
| `{"t":"enroll","k":"<b64u device key>"}` | host control only | add a device key (at most 64; not a small-order key) |
| `{"t":"revoke","k":"<b64u device key>"}` | host control only | remove it and close that device's live connections |
| `{"t":"pairing","h":"<b64u SHA-256(A)>","ttl":1..600}` | host control only | open a pairing window |

Anything else, from a socket that has not been admitted or from the host, closes the socket.
A client must wait for `open` before it says anything: a client that speaks earlier is closed.
The enrolled set changes only on `enroll` and `revoke` from the admitted host control socket; the same text sent by a client or a pipe is only forwarded.

### Client states

`new` (nonce sent) -> `auth` (checking) -> `wait` (host not connected) or `pend` (host told, pipe not yet open) -> `open`.
A host that registers again moves every `wait` client to `pend`, tells it (`host` up) and announces it to the host; a host that leaves moves every `pend` client back to `wait`.
A newer admission of a device key closes the older connection of that key, so a zombie socket cannot lock a phone out, and a device holds one live connection.

## State

Stored in Durable Object storage: `dev:<hex device key>` (an enrolled public key and the time) and `pw` (the live pairing windows: an internal handle, `b64u(SHA-256(A))`, an expiry).
Kept in socket attachments, so they survive hibernation: role, stage, deadline, room id, connection id and, for an admitted client, its device key; the nonce while the socket is new.
Kept in memory only: the per-device admission counters (they reset if the object restarts) and capacity reservations for active admission handlers.
Awaiting handlers keep the object active; completed admissions are represented by socket attachments, and every success or failure releases its reservation.
Closing a socket clears its attachment before the close handshake finishes, so a retiring socket holds no slot.
Nothing else.
A socket whose attachment this code does not understand (one the pre-R2 Worker left behind) is closed on its first message.

## Limits

Every number is an **unmeasured default** chosen to bound abuse, not derived from traffic.
Each can be overridden by a Worker variable of the same name (a positive integer up to 1,000,000; anything else falls back to the default); the tests run the real limiter with small values, never a flood.

| Variable | Default | Bounds |
|---|---|---|
| `LIMIT_WINDOW_MS` | 60000 | the window of every budget below |
| `LIMIT_IP_CLIENT` | 10 | client upgrades per address per window (the old `/connect` limit was 10) |
| `LIMIT_IP_HOST` | 6 | host control upgrades per address per window |
| `LIMIT_IP_PIPE` | 60 | pipe upgrades per address per window |
| `LIMIT_RID` | 240 | upgrades for one room per window, from every address together |
| `LIMIT_DEVICE_ADMITS` | 10 | verified admissions of one device key in one room per window |
| `MAX_PENDING_CLIENT` | 8 | unadmitted client sockets a room holds at once |
| `MAX_PENDING_HOST` | 8 | unadmitted host-side sockets (control and pipe) a room holds at once |
| `MAX_CLIENTS` | 16 | admitted clients a room holds at once |
| `MAX_ENROLLED` | 64 | device keys one machine may enroll |
| `ADMIT_TIMEOUT_MS` | 10000 | how long a socket may stay unadmitted |
| `PIPE_TIMEOUT_MS` | 15000 | how long an admitted client waits for its pipe |
| `WAIT_TIMEOUT_MS` | 600000 | how long an admitted client waits for a host that is not connected |

- The per-address and per-room budgets are counted by one **global limiter Durable Object** (`GlobalLimiter`) that every isolate asks, so a count is global across isolates.
  The limiter that came before was in the memory of one isolate and skipped the check when the client address header was missing; this one counts a request with no address under the shared key `unknown`, and it **fails closed**: a request that cannot be counted is refused with 503.
- The per-device budget counts **verified** admissions only, so bad signatures under someone else's key cannot spend that device's budget.
- Neither a stranger's unadmitted socket nor a refusal at the front holds anything past its deadline.
- The unadmitted cap protects the host from work; it does not make a room immune to a denial of service: see "Known limits".

## What the Worker sees

Stated plainly, as ADR 0034 section 11 does, because the protocol hides content and does not hide this:

- The room id of every connection, so which machine is being talked to, and the route class of each socket (host, client, pipe).
- Every device public key that attempts admission, in clear (a stable pseudonym that links a phone's connections across time and networks), and the host's public key at every host and pipe admission.
- During pairing, the ticket `A` and the registered hash.
- The enrolled set (stored) and every `enroll` and `revoke`, with its time.
- Both IP addresses of a pipe, the time of every connection, whether the host is connected, how many clients wait, and the size and timing of every message.
- In clear inside the pipe: `hello` and `hello_ack` (ephemeral public keys, nonces, the mode and the host signature), so it learns when a pairing happens.
- The **length** of the sealed `auth` and of every frame.
  The sealed `auth` is 112 to 176 bytes, so the Worker can tell the device name's length (0 to 64 bytes) to within a byte even though it never sees the name.
- The 25-byte frame that is a BYE, so it can see when a stream ends cleanly.
- The close code and reason each side sends.

With conforming v2 endpoints it does not see plaintext session payloads or device names, private identity keys, derived session keys or the pairing secret.
It sees the public keys and handshake content listed above, and can derive a public fingerprint from the machine public key.
This describes the v2 relay path; the legacy `POST /push` path still receives plaintext notification data, including session ids.
An active Worker can drop, delay, duplicate, reorder or inject frames, refuse service, admit or refuse devices and close sockets; the library detects what it can (ADR 0034 sections 7 and 11).

## What stays and what changes

Deleted from the Worker: the code-named room (`/connect/<code>`, the 30-bit code as room name and secret), `/answer/<code>` and the offer, answer and ice-candidate forwarding, the code generator and the old signaling message types, and the Worker variables `MAX_CONNECTIONS_PER_ROOM`, `CONNECTION_TIMEOUT_MS` and `CODE_LENGTH` (the rooms have no time-to-live).

Changed: the room (one per machine, admission, no TTL, edge ping), a global limiter object (new class `GlobalLimiter`, migration `v4`), the per-address upgrade limit (now through that object).

**Unchanged: the legacy `POST /push`.**
It stays until push privacy (R5) ships and old app builds update (plan section 3.5, owner decision D).
Exactly what stays: the route, the `Authorization: Bearer <PUSH_SECRET>` check (only when `PUSH_SECRET` is set; with none, a request is accepted), the plaintext body shape, the per-isolate rate limiters (authenticated, unauthenticated and dismiss budgets), the APNS forwarding and its `tokenInvalid` reply.
`/health` and the CORS preflight are unchanged too (`tests/pin-worker-routes.test.ts` pins them).
**Not part of this change: per-machine authentication of `/push`.**
It needs a signed message the ADR does not define; see the pull request for the options.

## Known limits

- **A stranger who knows a room id can hold the unadmitted slots.**
  The room id is not a secret (it is derivable from the pairing token).
  Strangers can keep `MAX_PENDING_HOST` host-side sockets or `MAX_PENDING_CLIENT` client sockets unadmitted for `ADMIT_TIMEOUT_MS` each (10 seconds by default), bounded by the per-address and per-room budgets, and in that time the real host (or a real client) is refused at the upgrade with a 429 and must retry.
  Host control and pipe sockets share the host-side cap, so unauthenticated pipe sockets can also block a host control upgrade for that interval.
  That is an availability attack on one room; it costs the host nothing, because only admitted sockets reach it.
  Distinct addresses multiply it.
  Not mitigated beyond the budgets; not measured.
- Per-device counters are in memory and reset if the object restarts; the global limiter's counters reset the same way, and one object serves all keys (Cloudflare documents a soft limit of 1,000 requests per second per object).
- A stolen device key can kick the legitimate phone (a newer admission supersedes the older), but a stolen device key can impersonate the phone anyway; revocation is the remedy (ADR 0034 section 15.2, item 5).
- Rooms are created by any valid host proof, so a flood of fresh machine keys creates rooms; each costs a Durable Object and, once it enrolls or opens a window, a few stored rows, with no garbage collection.
  The per-address host budget (`LIMIT_IP_HOST`) is the only bound.
- Refusal reasons are not hidden at the HTTP layer: 429 and 503 are distinguishable from a close.
- Admission signatures are checked with the platform's Ed25519 verifier (workerd's here); ADR 0034 section 17.2 measured that it accepts small-order keys, which is why the Worker refuses them itself.

## Verified and unverified

Verified by tests that run the real Worker and Durable Object in workerd under `bun test`: everything in "Admission", "After admission" and "State", the limits at the values the tests set, frames of `MAX_FRAME` crossing and one byte more refused, a session far older than ten minutes alive, revocation closing a live session, real hibernation (the object rebuilt after about eleven idle seconds while sockets stayed open), and the Worker never holding a sentinel plaintext, the pairing secret or a device name.
The initial R2 tests ran on Bun 1.4.2 and 1.3.11; the review corrections and their regression tests ran on Bun 1.4.2.
A rerun of the review corrections on Bun 1.3.11 remains unverified.

**Unverified (the owner deploys):**

- Everything on the deployed Cloudflare runtime: the real hibernation threshold, alarm precision, billing of idle hibernating sockets and of the limiter object, and the behavior of the `GlobalLimiter` under real traffic.
- The WebSocket message ceiling.
  Cloudflare documents **32 MiB** for a message received by a Worker or Durable Object since 2025-10-31 (1 MiB before), and closes a larger message with code 1009 ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/), [changelog](https://developers.cloudflare.com/changelog/post/2025-10-31-increased-websocket-message-size-limit/)).
  `MAX_FRAME` (524,313 bytes) is below even the old figure, so `MAX_PLAINTEXT` is unchanged; this was read from the documentation, not measured on the deployed runtime.
- `wrangler deploy` itself and its bundle: the tests bundle with `Bun.build`, and `E2E_BUNDLER=esbuild bun test packages/signaling/tests/e2e` runs the suite against an esbuild 0.27.0 bundle (the bundler wrangler 4.58.0 uses, without wrangler's own steps), which passed; nothing was deployed or dry-run.
- That the migration `v4` applies on the first deploy (migrations are not exercised by the tests).
- The relay engine check on the deployed runtime (ADR 0034 section 19): a step in the runbook.
