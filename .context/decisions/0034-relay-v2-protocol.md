# ADR 0034: Relay protocol v2 (hardened handshake, counter-checked channel)

**Status:** accepted for implementation (phase R1 of epic #1195, issue #1196).
The independent cryptography review and the owner's read of this ADR are merge gates for R1, and either may change what follows.
**Date:** 2026-10-04
**Owner:** Yahya

The number 0034 is chosen on purpose: 0033 belongs to the Codex epic branch.

## Context

The relay audit of 2026-10-04 (`.context/relay-rebuild-plan-2026-10.md`, section 1) found that today's relay is a daemon half with no client, and that the half that exists is weak in ways that matter for a product whose first principle is that session data never reaches a server in the clear.
The facts that drive this decision, each traced to code in the plan:

- The handshake is plaintext, so the Worker sees both identity keys (`authenticator.ts`, `relay-crypto.ts`).
- Ciphertext nonces are 12 random bytes with no additional authenticated data, no counter and no replay window, so a relay can replay, reorder or drop ciphertext undetected (`encryptRelayPayload`, `decryptRelayPayload`).
- Trust on first use auto-accepts the first key presented when the daemon runs in that mode, so a 30-bit room code is the only gate.
- Sends are not ordered: `encryptRelayPayload(...).then(sendRelay)` lets a slow encryption overtake a fast one.
- The room is the code, so knowing a code is enough to displace a host.

Version 1 is the protocol those modules implement.
Its primitives are sound (ephemeral P-256 ECDH, Ed25519 signatures, HKDF-SHA256, AES-256-GCM) and the owner has decided to keep them.
Noise is not adopted (plan section 8, decision B).
The Worker enforces admission (plan section 8, decision A); that layer is phase R2, and this ADR defines only the message shapes it needs from `packages/shared`.

## Decision

Replace v1 with protocol version 2, implemented once as a library in `packages/shared/src/relay/` (Apache-2.0) and imported by the daemon, the Worker and the clients; the library imports nothing from them.
Version 2 hardens the audited design rather than replacing it:

1. The whole transcript (protocol version, mode, room id, both ephemeral keys, both nonces) is bound into the host signature, into the key derivation salt and, through the host signature, into the client signature.
2. The host proves its identity before the client reveals anything about its own identity.
3. A one-time pairing secret is mixed into the key derivation while pairing, and is never transmitted.
4. The client's identity proof travels inside the encrypted channel.
5. Both directions confirm the keys before the channel opens.
6. Every encrypted frame carries a strictly increasing counter that is also its AES-GCM nonce, and the channel header is authenticated.
7. Frames leave through one ordered queue.
8. Every failure closes the connection with one generic reason, and no plaintext fallback exists anywhere.

The rest of this document is the exact protocol.
Where it differs from plan section 3.3.1, the difference is listed under "Issues found while specifying" with the reason.

## 1. Primitives

Only these, all through WebCrypto (`crypto.subtle`) in the TypeScript implementation, and through CryptoKit in the Swift one:

| Use | Primitive | Encoding |
|---|---|---|
| Identity signatures | Ed25519 (RFC 8032) | public key 32 bytes raw, signature 64 bytes |
| Key agreement | ECDH on P-256 | public key 65 bytes, uncompressed SEC1 (`0x04 \|\| X \|\| Y`); shared secret is the 32-byte X coordinate |
| Key derivation | HKDF-SHA256 (RFC 5869), one Extract then one Expand per output | |
| Authenticated encryption | AES-256-GCM, 12-byte nonce, 16-byte tag, tag appended to the ciphertext | |
| Hashing | SHA-256 | |
| Admission ticket | HMAC-SHA256 | |

No new dependency is introduced.
The implementation never decides a curve, hash or cipher at run time: nothing is negotiated.

**How keys are made.**
Production ephemeral P-256 pairs come from the engine's own `generateKey` (the public point exported raw, the private key non-extractable), and production Ed25519 identities from `generateKey` (or from a key the caller imported from its own storage) wrapped by `signerFromKey`.
`signerFromKey` is async: it signs and verifies a 62-byte labeled probe once, so a private key that does not match the public key, or cannot sign, fails at construction with `BAD_SIGNATURE` instead of silently at the peer.
`generateIdentity` re-imports its PKCS8 export as non-extractable for the in-memory signer, so the extractable key `generateKey` made is not kept.
A persisted key is the engine's own export: PKCS8 for the private key (the form the v1 identity stores, `createIdentity` and `unlockIdentity` in `identity.ts`) together with the raw public key, so nothing in production asks an engine to derive a public key from a bare scalar or seed.
Building a key from a bare scalar (PKCS8 with no public half, then a JWK export) exists only in `deterministic.ts`, for tests, the vector generator and the verifiers' reproducibility.
Section 17 records why: that path fails on WebKit.

An ephemeral or push-seal P-256 private key is a 32-byte big-endian scalar `d` with `1 <= d < n`, where `n` is the group order `FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551`.
A generator that draws a scalar outside that range draws again.
An Ed25519 identity is a 32-byte seed.

## 2. Notation and encodings

- `||` is concatenation.
- `be16(n)`, `be64(n)` are unsigned big-endian integers of 2 and 8 bytes.
- `lp(x) = be16(len(x)) || x`, defined for `len(x) <= 65535`.
- `lps(a, b, c, ...) = lp(a) || lp(b) || lp(c) || ...`.
- A string given in quotes is its ASCII bytes with no terminator.
- `[x]` is the single byte `x`.
- `b64u(x)` is base64url (RFC 4648 section 5) without padding.
  A decoder accepts only the alphabet `A-Z a-z 0-9 - _`, rejects a length that is 1 modulo 4, and rejects any input whose canonical re-encoding differs (so non-zero trailing bits are rejected).

Constants:

| Name | Value |
|---|---|
| `V` | 2, the protocol version, the byte `0x02` wherever a byte is meant |
| `RID_LEN` | 16 |
| `MODE_PAIR`, `MODE_RESUME` | bytes `0x01`, `0x02`; the wire strings are `"pair"` and `"resume"` |
| `DIR_C2H`, `DIR_H2C` | bytes `0x01` (client to host), `0x02` (host to client) |
| `TYPE_AUTH`, `TYPE_READY`, `TYPE_DATA`, `TYPE_BYE` | bytes `0x01`, `0x02`, `0x03`, `0x04` |
| `MAX_COUNTER` | 2^40 = 1099511627776 |
| `MAX_PLAINTEXT` | 524288 (2^19) bytes per data frame |
| `BYE_FRAME` | `1 + 8 + 16` = 25 bytes, the length of a `TYPE_BYE` frame (no plaintext) and the smallest frame of any type |
| `MIN_FRAME` | `1 + 8 + 1 + 16` = 26 bytes, the smallest binary data frame (one byte of plaintext) |
| `MAX_FRAME` | `1 + 8 + MAX_PLAINTEXT + 16` = 524313 bytes, the largest binary data frame |
| `MAX_CONTROL_TEXT` | 512 bytes of UTF-8, the largest control frame (an ordinary frame is ASCII, so bytes and characters agree) |
| `MAX_DEVICE_NAME` | 64 bytes of UTF-8 |
| `HANDSHAKE_TIMEOUT_MS` | 30000 |
| `PAIR_CONFIRM_TIMEOUT_MS` | 120000 |
| `PAIRING_TTL_SECONDS` | 600 |
| `PAIRING_SKEW_SECONDS` | 60 |
| `MAX_PENDING_SENDS` | 64 |
| `MAX_PAIRING_OFFERS` | 8, how many live offers a host tries for one `auth` |
| `MAX_PUSH_PLAINTEXT` | 2048 bytes |
| `MAX_QUESTION_ID` | 64 bytes |
| `CLOSE_CODE`, `CLOSE_REASON` | 4400 and the string `"closed"`, the close of every failure |
| `CLOSE_NORMAL` | 1000, the close code of a deliberate local close (reason `"closed"`) |

The 1 MiB WebSocket message ceiling of Cloudflare Workers is the reason `MAX_FRAME` is half of it.
That ceiling is the documented figure and is unverified here; R2 must confirm it against the deployed runtime and lower `MAX_PLAINTEXT` if it is wrong.

**R2 finding (2026-10-04, read from Cloudflare's documentation, not measured on the deployed runtime).**
Cloudflare documents 32 MiB (33,554,432 bytes) for a WebSocket message received by a Worker or a Durable Object, since 2025-10-31; the figure was 1 MiB before, and a larger message closes the socket with code 1009 ([Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/), [changelog 2025-10-31](https://developers.cloudflare.com/changelog/post/2025-10-31-increased-websocket-message-size-limit/)).
`MAX_FRAME` (524,313 bytes) is below both figures, so `MAX_PLAINTEXT` stays 524288.
The Worker also refuses a text message above `MAX_CONTROL_TEXT` and a binary message above `MAX_FRAME` itself, by size only (`docs/relay-worker-v2.md`); a test through the real Durable Object relays `MAX_FRAME` bytes intact and refuses `MAX_FRAME + 1`.
Measuring it on the deployed Worker is left to the owner and is listed as unverified in `docs/relay-worker-deploy-runbook.md`.

## 3. Identities and the room id

- Machine identity `(M_sk, M_pk)`: Ed25519, owned by the hub.
- Device identity `(D_sk, D_pk)`: Ed25519, one per phone, held in the platform keychain.
- Room id `rid = SHA-256(M_pk)[0..16]`, the first 16 bytes.
  It is public and derivable from the pairing token.
  A client always derives `rid` from the machine key it trusts and never reads it from the wire.
- Ephemeral keys `(e_h, E_h)` host and `(e_c, E_c)` client: P-256, fresh for every connection, never stored.
- Nonces `n_c`, `n_h`: 32 random bytes each.
- `psk`: the 32-byte pairing secret, present only in pair mode.

## 4. The Worker admission layer (formats only)

The Worker layer is R2.
The signature formats are fixed here because the Worker and the clients must agree on them byte for byte.

The Worker sends each new socket a fresh 32-byte `nonce` from its own CSPRNG, valid for that socket and one use.

```
host_admission_input   = lps("remi-relay-v2 admit host",   rid, nonce)
client_admission_input = lps("remi-relay-v2 admit client", rid, nonce)
```

- A host answers `(M_pk, Ed25519(M_sk, host_admission_input))`.
  The Worker checks `SHA-256(M_pk)[0..16] == rid` and then the signature.
- A client answers `(D_pk, Ed25519(D_sk, client_admission_input))`.
  The Worker admits it when `D_pk` is in the room's enrolled set.
- During a pairing window the host has opened, a client may instead present, together with its signed `D_pk`, the admission ticket `A = HMAC-SHA256(key = psk, data = "remi-relay-v2 admit")`, 32 bytes.
  The host registered `SHA-256(A)` with the Worker with a time to live; the Worker compares `SHA-256(presented A)` to the registered value in constant time, admits on a match and deletes the registration (single use).
  The Worker never sees `psk`, and `A` does not reveal it.

An admission check passes only if the room id is exactly 16 bytes, the nonce exactly 32 bytes, the public key exactly 32 bytes and the signature exactly 64 bytes, as well as the signature verifying (and, for a host, the room id matching the key); any other length is a refusal even when the signature was made over those other bytes.
**The ticket `A` is an abuse-control token and nothing more.**
The Worker sees `A` (and the host's registered hash) in clear, so `A` must not be mistaken for a secret.
It does not weaken the end-to-end guarantee: `A` is an HMAC output and does not reveal `psk`, and the session keys need `psk` inside the key derivation AND the ephemeral secrets, so an observer or the Worker holding `A` can reach the handshake but cannot derive a key or pass the host's check of `auth`.
Its residual risk is a single-use race: whoever sees `A` first (the Worker, or a network observer if it travelled in clear) can present it before the legitimate phone and burn the registration, denying that phone the window until the host opens another.
That is denial of a ten-minute pairing, not a compromise, and the loser fails visibly.
R2 MUST compare the presented ticket's hash with the registered one in constant time and MUST burn the registration atomically with the check (section 19).

An admission signature binds role, room and nonce, so it cannot be replayed to another room, another role or another socket.
Admission is an access-control and abuse-control layer, not a confidentiality layer: nothing in the end-to-end protocol below depends on the Worker behaving.

## 5. The pairing token

`remi pair` (R3) prints, as a QR code and as a pasteable string, one token.
Binary layout:

```
offset  size  field
0       1     token_version = 0x02
1       1     flags: bit 0 set means seal_public_key is present; bits 1 to 7 MUST be zero
2       8     expires_at, be64, seconds since the Unix epoch
10      32    machine_public_key (M_pk)
42      32    pairing_secret (psk)
74      65    seal_public_key, P-256 uncompressed, present only when flag bit 0 is set
74|139  n     relay_url, UTF-8, the remainder of the token, 1 to 512 bytes
```

String form: `"remi-pair2:" || b64u(token bytes)`.
A token is at most 11 + 868 characters.

A decoder checks the following in this order and reports the first failure (code `TOKEN`, or `EXPIRED` where noted); an expired token whose url is also invalid is therefore `TOKEN`:

- a string without the prefix, or with a payload that is not canonical base64url;
- a token shorter than 75 bytes (the 74 fixed bytes before the optional seal key and at least one byte of url), with `token_version != 2`, or with any reserved flag bit (1 to 7) set;
- an `expires_at` that does not fit a safe integer (above 2^53 - 1), or a `relay_url` (the bytes after the fixed part and the seal key, if flagged) longer than 512 bytes;
- a `relay_url` that does not match, as a whole string (no trailing newline), `^(wss://[a-z0-9.-]+|ws://(localhost|127\.0\.0\.1))(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$` (no userinfo, no query, no fragment, no IPv6 literal, lowercase host; the pattern is ASCII, so any other byte is a refusal and no separate UTF-8 check is needed);
- `expires_at <= now` (code `EXPIRED`);
- `expires_at > now + PAIRING_TTL_SECONDS + PAIRING_SKEW_SECONDS`: a token that outlives the policy is malformed, not generous;
- a seal key that is not a valid P-256 point.

The 128-bit pairing secret of plan section 3.1 is 256 bits here; see "Issues found while specifying".
The optional `seal_public_key` is the daemon's key for sealing a lock-screen answer to the daemon (R6); the key to which the daemon seals pushes is the device's, and it travels from the device to the daemon inside the encrypted channel (R5), never in the QR.

Expiry and single use are enforced by the daemon (R3), which holds a `PairingOffer { secret, expiresAtMs, used }` per live token.
The library provides the pure checks: an offer is live when `used` is false and `now < expiresAtMs`, and a host machine ignores offers that are not live.

## 6. The handshake

Four plaintext-or-sealed control frames, in order, over one WebSocket whose other end is the Worker's pipe to the host.
`hello` and `hello_ack` are JSON text; `auth` and `ready` are JSON text carrying one AEAD ciphertext.

### 6.1 Wire form of control frames

Every control frame is a JSON object in this canonical compact form: no whitespace, the keys in the order shown, ASCII only, `v` a bare integer, every binary value `b64u(...)` of exactly the stated length.

```
hello      {"v":2,"t":"hello","m":"pair"|"resume","e":b64u(E_c),"n":b64u(n_c)}
hello_ack  {"v":2,"t":"hello_ack","e":b64u(E_h),"n":b64u(n_h),"s":b64u(sig_h)}
auth       {"v":2,"t":"auth","c":b64u(auth_ciphertext)}
ready      {"v":2,"t":"ready","c":b64u(ready_ciphertext)}
```

(The values appear as JSON strings; the above shows the structure.)

Lengths: `E_*` 65, `n_*` 32, `sig_h` 64, `auth_ciphertext` 112 to 176, `ready_ciphertext` 17.

A strict decoder applies these steps in order and stops at the first failure.
All failures are errors, and none is recovered from.

1. The frame is a text string, else `TYPE` (a binary frame where text is expected); it is at most `MAX_CONTROL_TEXT` bytes of UTF-8, else `OVERSIZE`.
2. It parses as JSON (RFC 8259: `NaN`, `Infinity`, comments and trailing commas are not JSON) and is an object with an integer `v`, else `MALFORMED`.
   An integer is a JSON number whose value is an integer: `3.0` is an integer and `true`, `"2"` and `2.5` are not.
   Numbers are read as IEEE-754 doubles, as `JSON.parse` reads them, so `1e400` (infinite) is not an integer and `3.0000000000000001` reads as 3; and when a key occurs twice the LAST occurrence is the one steps 2 to 6 see (step 7 then refuses the frame, which is not canonical).
3. `v == 2` by value, else `VERSION`.
   (So `3.0` is `VERSION`, and `2.0` passes this step and fails step 7.)
4. `t` is the type the receiver expects at this step of the handshake, else `TYPE` (an unknown type, a known type at the wrong step, a missing `t`, or a `t` that is not a string).
5. For `hello`, `m` is `"pair"` or `"resume"`, else `MODE` (including a missing `m` and a non-string `m`).
6. The object has exactly the expected keys, each value a string, each binary value canonical base64url of the stated length (`auth_ciphertext` within its range, every other value exactly), else `MALFORMED`.
7. The canonical text rebuilt by the encoder from the decoded values equals the received text character for character, else `MALFORMED`.
   This one comparison rejects duplicate keys, reordered keys, whitespace, alternative escapes and non-canonical numbers.

For `hello` and `hello_ack` the decoded ephemeral key must also begin with the byte `0x04` (an uncompressed point), else `MALFORMED`; that prefix check belongs to the decoder, whatever the platform's import accepts.
That the key is a point on the curve is checked when it is used for ECDH, and is `MALFORMED` too; the `ec_point` vectors cover it.

### 6.2 Transcript, signatures, key schedule

```
H1  = SHA-256( lps("remi-relay-v2 H1", rid, [V], [mode], E_c, n_c, E_h, n_h) )
sig_h = Ed25519(M_sk, lps("remi-relay-v2 host", H1))

Z   = ECDH(e_c, E_h) = ECDH(e_h, E_c)          (32 bytes)
ikm = Z || psk                                  (psk is empty in resume mode)
k_c2h = HKDF-SHA256(ikm, salt = H1, info = "remi-relay-v2 c2h", L = 32)
k_h2c = HKDF-SHA256(ikm, salt = H1, info = "remi-relay-v2 h2c", L = 32)

H2  = SHA-256( lps("remi-relay-v2 H2", H1, sig_h, D_pk, name) )
sig_c = Ed25519(D_sk, lps("remi-relay-v2 client", H2))
```

Every argument of `lps` is its own part, so the one-byte `[V]` and `[mode]` in `H1` each carry their own 2-byte length prefix (`0001 02`, `0001 01`), as does the label.
`sig_h` and `sig_c` are plain Ed25519 over the `lps`-wrapped bytes, with no extra hashing.
In §6.2 the HKDF `info` is the raw ASCII label (not length-prefixed), the salt is the 32-byte `H1`, and with an empty `psk` the input key material is just the 32 bytes of `Z`.
`mode` in `H1` is the byte `0x01` or `0x02`, the mode the client sent in `hello`.
`name` is the device name bytes (empty when absent).
Each HKDF call performs Extract with the given salt and `ikm` and then Expand with the given `info`; the two calls therefore share one pseudorandom key and differ only in `info`.

### 6.3 Message flow

1. **Client to host, `hello`.**
   The client draws `e_c` then `n_c` from its random source, and sends `hello` with its mode.
   In pair mode the client holds `psk` and the machine key from the token; in resume mode it holds the machine key it pinned when it paired.
2. **Host to client, `hello_ack`.**
   The host decodes `hello`.
   In pair mode it requires at least one live pairing offer, else it closes (`PAIRING`).
   It draws `e_h` then `n_h`, computes `H1` and `sig_h`, and sends `hello_ack`.
   It also computes `Z` and keeps it with `H1` and the transcript.
3. **Client verifies the host, then reveals its identity.**
   The client decodes `hello_ack`, computes `H1` from its own values (its own version constant and its own mode, never values read from the host's message, apart from `E_h` and `n_h`), and verifies `sig_h` under the machine key it trusts.
   On failure it closes and has sent nothing further: it has not signed anything with the device key and has not derived a key.
   On success it computes `Z` and the two keys, then `H2` and `sig_c`.
4. **Client to host, `auth`.**
   The plaintext is `D_pk (32) || sig_c (64) || name`, where `name` is 0 to 64 bytes of UTF-8 with no control characters (code points below U+0020 or equal to U+007F).
   It is sealed with `k_c2h` as a frame of type `TYPE_AUTH`, direction `DIR_C2H`, counter 0 (section 7).
5. **Host checks the client.**
   The host derives the keys and opens `auth`.
   - Resume mode: keys use an empty `psk`; if `auth` does not open, the failure is `DECRYPT`.
   - Pair mode: the host tries each live offer in order, deriving keys with that offer's secret; the first offer under which the tag verifies is the matching one.
     If none verifies, it closes (`PAIRING`).
     Which offers are tried: the live offers in the order of the policy's list, at most `MAX_PAIRING_OFFERS` of them.
     Once an offer's secret opens `auth` the search stops: a later failure (the name or the signature) is reported as that failure, and no other offer is tried.
     This is why a client with the wrong pairing secret fails here, with the same observable result as any other failure.
   The decoder has already bounded the `auth` ciphertext to 112 to 176 bytes, so the plaintext is 96 to 160 bytes: `D_pk` is its first 32 bytes, `sig_c` the next 64, and the rest is the name.
   The host then checks, in this order: the name (`NAME`), `sig_c` under `D_pk` over the host's own `H2` (`BAD_SIGNATURE`), and in resume mode that `D_pk` is enrolled (`UNKNOWN_DEVICE`).
   Enrollment is checked in resume mode only; in pair mode the library does not look at the enrolled set (re-pairing an enrolled device is the daemon's decision).
   In pair mode the library reports which offer matched; the daemon then shows the fingerprint (section 9) to the operator, enrolls `D_pk` and burns the offer.
   Only after that does the daemon ask the library for `ready`.
6. **Host to client, `ready`.**
   The plaintext is one byte, the mode the host processed (`0x01` pair, in which `D_pk` was enrolled by this handshake, or `0x02` resume).
   It is sealed with `k_h2c` as `TYPE_READY`, `DIR_H2C`, counter 0.
   The client opens it, requires the byte to equal the mode it asked for (`MODE_MISMATCH`), and only then constructs the data channel.
   The decryption of `ready` is the key confirmation in one direction; the decryption of `auth` is the confirmation in the other.

Deadlines, in milliseconds from the moment the first handshake message was handled (the client's `hello` is sent, the host's `hello` is received), enforced with the injected clock:

- The client's `hello_ack` handling, and the host's `auth` handling, must happen within `HANDSHAKE_TIMEOUT_MS`.
- `ready`, on both sides (the host's call to produce it, the client's handling of it), must happen within `HANDSHAKE_TIMEOUT_MS` in resume mode and within `PAIR_CONFIRM_TIMEOUT_MS` in pair mode, which leaves room for a human to confirm the fingerprint.
- A violation is `EXPIRED`.
- The boundary is inclusive: a step handled exactly `limit` milliseconds after the start is on time, and one millisecond later is `EXPIRED`.
- The check happens when the step is handled; the library has no timer.
  A handshake in which nothing arrives never calls a step, so the daemon must close an idle half-open connection itself (section 14).

Each step of the handshake is single use: the library hands back the next step from the one before, so a step cannot be taken out of order and no channel exists before key confirmation.
Calling a step twice, or after `abort`, is `STATE`.
A step that fails overwrites its secrets, and `abort` does the same for a handshake the caller abandons.

## 7. Encrypted frames and the data channel

```
nonce(c)      = 0x00000000 || be64(c)                              (12 bytes)
aad(t, d, c)  = "remi-relay-v2" || [V] || [t] || [d] || be64(c)    (24 bytes)
ct||tag       = AES-256-GCM(key_d, nonce(c), aad(t, d, c), plaintext)
```

`t` is the frame type, `d` the direction of the sender, `c` the counter.
Counter 0 is used once per direction, for `auth` (client to host) and `ready` (host to client).
Data counters start at 1 in each direction and the largest valid counter is `MAX_COUNTER`.

After the handshake there are two binary frame types, both WebSocket binary messages:

```
data  [TYPE_DATA] || be64(counter) || ct||tag     length 26 to MAX_FRAME, plaintext 1 to MAX_PLAINTEXT bytes
bye   [TYPE_BYE]  || be64(counter) || tag         length exactly 25 (BYE_FRAME), plaintext empty
```

A `bye` is the authenticated end of one direction.
It takes the next counter like any frame, is sealed with `t = TYPE_BYE` in the AAD (so a data frame cannot be made into a BYE or the reverse), and carries no plaintext: its ciphertext is the 16-byte tag alone.

Receiver, per direction, tracking `last` (0 after the handshake) and whether the peer has ended.
Checks run in this order and stop at the first failure; the first failure closes the channel for good:

1. The frame is binary, else `TYPE` (a text frame after the handshake, which includes a second `hello`).
2. Length at least `BYE_FRAME` (25), else `MALFORMED`.
3. Length at most `MAX_FRAME`, else `OVERSIZE`.
4. First byte is `TYPE_DATA` or `TYPE_BYE`, else `TYPE`.
5. For `TYPE_BYE` the length is exactly 25, for `TYPE_DATA` at least 26, else `MALFORMED`.
6. `counter <= MAX_COUNTER`, else `COUNTER_LIMIT`.
7. The peer has not already ended, else `ENDED`: a frame of either type after a BYE is refused and closes the channel.
8. `counter == last + 1`, else `COUNTER`: a repeat, a reorder and a gap are all this one failure.
9. The AEAD tag verifies under the receive key with `nonce(counter)` and `aad(type, peer direction, counter)`, else `DECRYPT`.
10. Only now is `last` set to `counter`; a `bye` marks the peer as ended and is delivered as the end marker (`null`), a `data` frame as its plaintext.

Sender: the plaintext is copied when `send` is called, so a caller that reuses its buffer changes nothing; the counter is assigned synchronously at the same moment, so counter order is call order.
The final counter, `MAX_COUNTER`, is kept for the BYE: a data `send` that would take it is refused with `COUNTER_LIMIT` and the channel stays open, so a sender that has used every data counter can still end cleanly; a sender whose next counter is already above `MAX_COUNTER` fails (`COUNTER_LIMIT`) and closes the channel.
Plaintext outside 1 to `MAX_PLAINTEXT` is refused before a counter is consumed (`OVERSIZE`, or `MALFORMED` for empty); more than `MAX_PENDING_SENDS` unsent frames refuses the new one before a counter is consumed (`QUEUE_FULL`).
**A refusal is not a failure.**
A send or `bye` refused with `ENDED`, `QUEUE_FULL`, `OVERSIZE`, an empty `MALFORMED` or a data `COUNTER_LIMIT` at the reserved counter emits nothing, consumes no counter, and leaves the channel open (the caller may reduce the message, wait, or end the stream); only a failure of the channel's own work (encryption or emission, any receive check, a counter already past the limit) closes it with the failure close.
`bye()` queues a BYE behind everything already queued, under the same counter, queue and limit rules, and ends the sending side the moment it is accepted: a later `send` or `bye` is refused with `ENDED` and nothing more is emitted, while the channel keeps reading until the peer ends or the transport closes.
A refused `bye` (`QUEUE_FULL`) does not end the sending side.
Encryption and emission run through one promise chain, so frame `n + 1` is not emitted before frame `n`, whatever the relative speed of their encryptions.
If encryption or emission of any frame fails, the channel closes with the failure close and every later send is refused (`CLOSED`): a frame is never skipped.
After the first failure every later receive is `CLOSED`.
Received frames are copied on arrival and processed through a second chain, so results are delivered in arrival order and a bad frame poisons the frames behind it.
A deliberate local close ends the channel with code `CLOSE_NORMAL` and the reason `"closed"`; it is not a failure.

**How the inbound stream ended.**
When the transport closes, whatever the close code, the caller tells the channel (`await transportClosed()`), and it says how the peer's stream ended.
**The library drains first.**
A WebSocket close event fires after the last message event, while that message's `receive()` may still be awaiting the engine; `transportClosed()` waits for every receive already queued before it reads the verdict, so a caller calls it in the close handler and need not await its receives first.
A receive in flight is delivered (or refused) as usual, and a receive started after the call is `CLOSED`.

| Verdict | Meaning |
|---|---|
| `clean` | The peer's BYE arrived before the close, so every frame the peer sent before it was seen in order (counters are strict) and the peer intended to end. |
| `unclean` | The transport closed with no BYE: the tail may be truncated. The peer may have crashed, or a relay dropped frames and the BYE and closed. This is also the verdict after this side's own `close()` or own BYE when no peer BYE has arrived: the verdict is about the INBOUND stream, so an own close with the peer's BYE already seen is `clean`. |
| `failed` | A check failed earlier; the channel was already closed. |

A receive after any close of the channel, a failure or a deliberate local close, is `CLOSED`; a receive after the peer's BYE is `ENDED` (once it passes the checks that precede it).
`transportClosed()` is idempotent, and concurrent calls agree.
A frame injected after the peer's BYE fails the channel (`ENDED`) but `peerEnded` stays true, so the verdict becomes `failed` while the peer did end its stream: a consumer reads `peerEnded` and the verdict together, and treats `peerEnded` with `failed` as an attack or a bug, not as a clean end.
The verdict is library behavior, not wire behavior, so the vector file carries no verdicts: the TypeScript tests exercise the channel and the Python verifier models the table above as a function of state (it models no timing, so the drain changes nothing there; the Swift verifier models no verdicts).

What this detects, exactly:

- A relay that drops the last frames of a stream **and** its BYE and then closes: `unclean`.
- A relay that closes with no BYE for any reason: `unclean`, which is also what a crashed peer looks like; the library does not guess which.
- A frame dropped, repeated or reordered before a delivered BYE: the counter check, as before.
- A forged close: a relay can close the transport at will, and the verdict is then `unclean`; it cannot make a close look `clean`, because that needs a BYE and only the key holder can make one.

What it does not detect:

- Delay: a frame, or the BYE, that arrives late is valid.
- A tail withheld while the transport stays open: no close is ever seen, so there is no verdict; deciding that silence is too long is a liveness question for the application (deadlines, acknowledgments).
- Whether the peer received anything: a BYE ends one direction and proves nothing about delivery in the other, and `bye()` resolves when the frame is emitted, not when it is received.
  Answers that must be known delivered still need an application acknowledgment.
- A peer that never sends a BYE: the verdict is `unclean` for every ending, so a consumer that does not use BYE gets no benefit.

There is no resumption.
A reconnect is a new handshake with fresh ephemeral keys and nonces; session state belongs to the application, not to the key.

## 8. Failure behavior

- Every parse or verification failure, whichever check produced it, closes the WebSocket with code `CLOSE_CODE` (4400) and reason `CLOSE_REASON` (`"closed"`), and nothing else is sent first.
  The typed error codes in this document exist for tests and for the local log, never for the wire.
- An unknown version, mode or message type closes.
- There is no plaintext fallback: no frame is ever accepted or sent unencrypted after `hello_ack`, and `hello` and `hello_ack` carry only public values.
- The close code and reason are constants of the module; no failure path chooses them.
- Key material is dropped when a handshake or channel ends, to the extent the platform allows.
  What the library does: production ephemeral keys are never present in JavaScript as bytes (the engine generates them and the private key is non-extractable), and with the test-only hook the scalar is overwritten as soon as the key is built (a test shows it); the raw channel keys are overwritten as soon as they are imported (a test shows it); a step that fails or is aborted overwrites the secrets it holds (not observable from outside, so no test shows it); a failed channel releases its `CryptoKey` references.
  A `CryptoKey` cannot be zeroed and JavaScript gives no guarantee about copies the engine made, so this is best effort and is claimed no further.

Error codes, which appear in tests and the local log only:

| Code | Meaning |
|---|---|
| `MALFORMED` | a frame or key that does not parse, has a wrong length or is not canonical |
| `VERSION` | a control frame whose `v` is an integer other than 2 |
| `TYPE` | a frame of the wrong type for the step (text where binary is expected and the reverse included) |
| `MODE` | a `hello` whose mode is not `pair` or `resume`, or a client configured with a pairing secret in the wrong mode |
| `MODE_MISMATCH` | a `ready` that opens but echoes another mode |
| `OVERSIZE` | a control frame or data frame over its limit, or a plaintext over its limit |
| `BAD_SIGNATURE` | an Ed25519 signature that does not verify |
| `DECRYPT` | an AEAD tag that does not verify, or a sealed value that cannot be opened |
| `COUNTER` | a data counter that is not exactly `last + 1` |
| `COUNTER_LIMIT` | a counter above `MAX_COUNTER`, received or about to be sent, or a data send refused one short because the last counter is kept for BYE |
| `UNKNOWN_DEVICE` | resume by a device key the host has not enrolled |
| `PAIRING` | pair mode with no live offer, or no live offer whose secret opens `auth` |
| `EXPIRED` | a handshake deadline passed, or a pairing token past its expiry |
| `STATE` | a step called twice or after `abort` |
| `NAME` | a device name that is too long, not UTF-8 or contains a control character |
| `TOKEN` | a pairing token that is malformed or outside the policy |
| `QUEUE_FULL` | more than `MAX_PENDING_SENDS` unsent frames |
| `CLOSED` | a send or receive on a channel that has closed |
| `ENDED` | a send or `bye` after this side's own BYE, or a frame of any type after the peer's BYE |
| `IO` | the transport or the engine failed while a frame was being sent, or anything that is not a `RelayError` was thrown inside a handshake step (an engine failure, a keychain signer, a policy callback): a step only ever throws `RelayError` |

## 9. Fingerprint shown to humans

```
fp = SHA-256( lps("remi-relay-v2 fingerprint", D_pk, M_pk) )
display = first 8 bytes of fp as 16 lowercase hex digits in four groups of four, joined by "-"
```

In pair mode both ends compute it from the same two public keys: the client after it has verified the host (it shows the fingerprint while it waits for `ready`), the host after it has verified `auth` and before it produces `ready`.
64 bits is enough because the attack the check catches is online and per attempt: someone holding the QR (a photo, a screen share) racing to pair a device of their own, whose fingerprint the legitimate user will see differs from the one on the legitimate phone.

## 10. Sealing a body to a device (push and, later, answers)

The shape of `sealed-answer.ts`, direction reversed for push.
`R` is the recipient's P-256 public key (65 bytes).

```
e, E = fresh P-256 pair; nonce = 12 random bytes
Z    = ECDH(e, R)
key  = HKDF-SHA256(Z, salt = E, info = lps("remi-relay-v2 seal", R), L = 32)
sealed = E (65) || nonce (12) || AES-256-GCM(key, nonce, aad, plaintext)
```

In this section the HKDF `info` is `lps("remi-relay-v2 seal", R)`, which is length-prefixed, unlike the raw labels of section 6.2.
For a push, `aad = rid || question_id` where `rid` is the 16 bytes above and `question_id` is 1 to 64 bytes of UTF-8 (the same string is the APNS collapse id).
Plaintext is 1 to `MAX_PUSH_PLAINTEXT` bytes; APNS allows 4096 bytes per payload in total, and R5 sets the exact budget.
On the sealing side a plaintext of 0 or more than `MAX_PUSH_PLAINTEXT` bytes, a `question_id` outside 1 to 64 bytes, a `rid` that is not 16 bytes and a recipient key that is not a valid point are refused (`MALFORMED`, `OVERSIZE` for the over-long plaintext); no vector covers the sealing side.
The opener rejects a sealed value shorter than `65 + 12 + 16 + 1` or longer than `65 + 12 + 16 + MAX_PUSH_PLAINTEXT`, imports `E` (which validates the point), derives the key and decrypts; any failure is `DECRYPT`.

The AAD makes a sealed push unusable for a different room or question.
Base-mode ECIES does not authenticate the sender; see "Issues found while specifying".

## 11. Metadata the Worker sees

Stated plainly, because the protocol hides content and does not hide this:

- The room id, and therefore which machine is being talked to.
- Every device public key `D_pk` that attempts admission, in clear: a stable pseudonym that links a phone's connections across time and networks.
- The host public key at admission.
- Both IP addresses, the time of every connection, and the size and timing of every frame.
- In clear on the wire: `hello`, `hello_ack` (ephemeral public keys, nonces, the mode, and the host signature), so the Worker learns when a pairing happens and which device pairs.
- During pairing, the ticket `A`.

The Worker does not see: any session id, any device name, any frame content, the pairing secret, the keys, or the fingerprint.
An active Worker (or any network position between the peers) can drop, delay, duplicate, reorder or inject frames, refuse service, admit or refuse devices, and close either socket.
Duplicates, reordering and injection are detected and close the channel; a delay is not detected; a drop followed by a later frame is detected as a gap; a drop of the tail together with its BYE followed by a close is reported as an unclean end (section 7), while a tail withheld with the socket left open is not detected by the library.
The 25-byte binary frame is a BYE, so the Worker can see when a stream ends cleanly, and that a side has no more to send.

## 12. Claims, and what demonstrates each

A claim appears here only with the evidence that shows it.
Test files are under `packages/shared/tests/relay/`; "vectors" means `vectors.test.ts` running the committed file, "Python" and "Swift" the two verifiers of section 13.
Every test was also checked by mutation: the mutated source was applied, the suite failed, the mutation was reverted (the results are in the pull request).

| Claim | Evidence |
|---|---|
| A replayed, reordered or dropped-then-continued frame, a truncated or extended frame, a flipped bit anywhere in a frame, a frame under another key, a reflected frame, counter 0 after the handshake, a counter above the limit with a valid tag and an oversized frame are each refused, and the channel then refuses everything (a valid frame after a failure included) | `channel.test.ts` (one test per case, a bit-by-bit test over a whole frame, 600 property cases); vectors `data_sequence` (which feed every frame after the first failure and require `CLOSED`) and `frame_length`; Python; Swift (which stops at the first failure) |
| A text frame after the handshake is refused | `channel.test.ts` only: a vector frame is a hex string, so no vector can carry a text frame |
| Every failure closes with one code and reason | `channel.test.ts` ("every failure closes with the same code and reason", "every RelayError code maps to the one wire close") |
| The stream's end is authenticated: a BYE is a counter-checked, AAD-typed, exactly 25-byte frame that only the key holder can make; a frame after it is refused; `transportClosed()` reports clean, unclean or failed as section 7 says; a tail dropped together with its BYE followed by a close is unclean | `channel.test.ts` ("authenticated end of stream (BYE)", 24 tests, including the drain cases), `envelope.test.ts`; vectors `data_sequence` (BYE cases) and `frame_length`; Python; Swift |
| A handshake step only ever throws a `RelayError`; a mismatched or non-signing identity key fails at construction; the signer's key is non-extractable | `handshake.test.ts` ("a step only ever throws a RelayError"), `primitives.test.ts` ("identity keys are checked and kept non-extractable") |
| What BYE does not detect: a tail withheld while the socket stays open, delay, delivery to the peer | `channel.test.ts` ("limits of the channel": two characterization tests), recorded so it cannot be forgotten |
| A slow encryption cannot let a later frame leave first; a failed frame is never skipped | `channel.test.ts` ("ordered sending") |
| The device key is never used before the host is verified, and the device identity and name are not on the wire in clear | `handshake.test.ts` ("the host is authenticated first", "not readable on the wire") |
| Every term of `H1` is bound: rid, mode, both ephemeral keys, both nonces | `handshake.test.ts` ("a host signature over a transcript that differs in any single term", "a relay that changes the hello in transit"); vectors `hello_ack_verify`; Python |
| Every term of `H2` is bound | `handshake.test.ts` ("the client signature covers every term of H2"); vectors `auth_check`; Python |
| The keys depend on the shared secret, the transcript, the pairing secret and the direction | `handshake.test.ts` ("key schedule"); vectors `auth_open`; Python; Swift |
| A wrong, missing or extra pairing secret fails at the host; a used, expired or absent offer does not pair; an `auth` replayed on a second connection fails | `handshake.test.ts` ("pairing offers", "wrong pairing secret", "replayed on a second connection"); vectors `auth_open` |
| The host checks the client signature, the device name, and in resume mode the enrollment | `handshake.test.ts` ("the host checks the client"); vectors `auth_check` |
| Key confirmation: a `ready` that does not open, or echoes another mode, yields no channel | `handshake.test.ts` ("key confirmation"); vectors `ready_open`; Python; Swift |
| Deadlines are enforced at their boundary, with the longer pairing window for `ready` | `handshake.test.ts` ("deadlines") |
| Control frames are decoded strictly: version, type, mode, shape, lengths, canonical form | `envelope.test.ts`; vectors `control_decode`; Python |
| Tokens, admission proofs and sealed pushes follow their formats and refuse every listed malformation | `pairing.test.ts`, `seal.test.ts` (including an independent Node implementation of the seal); vectors; Python; Swift (seal and admission) |
| The wire bytes are the specified bytes | vectors (regeneration pin and conformance); Python; Swift: three implementations, TypeScript, Python and CryptoKit, agree |
| No clock or platform random source is read inside the library, a run is a pure function of its inputs, and nothing outside the directory is imported | `source-guard.test.ts`; `handshake.test.ts` ("the same inputs always give byte-identical frames") |
| Random single-character mutations of any handshake frame in transit never produce a channel | `handshake.test.ts` (120 seeded cases) |
| The public `relayV2` surface is exactly the pinned list; no helper that builds a transcript, derives a key, frames bytes or builds a channel from raw keys is public | `public-surface.test.ts` |
| Production keys come from the engine, and the scalar-import key path is unreachable from a production default | `primitives.test.ts` ("production keys come from the engine"), `handshake.test.ts` ("the key hook"), `source-guard.test.ts` (the path is imported by `internal.ts` only); section 17 for why |
| Every v2 signed message is at least 54 bytes, begins with a zero byte and its own label, and no `.sign(` call in the library takes anything else | `signing-inputs.test.ts` (section 18) |
| The library, its production key path and the vectors run on Bun 1.4.2, Bun 1.3.11, workerd 1.20260107.1, WebKit (macOS 27.0.1) and a desktop Chromium; the scalar-import path fails on WebKit | The committed engine check (`scripts/relay-v2-engine-check/`, section 17): its results are recorded there, `engine-check.test.ts` runs it under Bun in the suite and against corrupted vectors, and R4 and R2 run it on their targets |

Not claimed, because no test shows it:

- **Forward secrecy.**
  The keys depend on the ephemeral shared secret (`handshake.test.ts`, key schedule), and the argument that this gives forward secrecy is the design's.
- **Metadata hiding.** Section 11 says what the Worker sees.
- **Constant-time behavior** of any comparison or of the platform's AEAD and signature code.
- **Zeroization** beyond the cases in section 8: with the test-only hook the ephemeral scalar is overwritten, and the raw channel keys are overwritten once imported; production ephemeral keys are never bytes in JavaScript.
- **Detection of delay, or of a tail withheld while the socket stays open** (sections 7 and 15.2).
- **Behavior on an iOS device's WKWebView, on an Android WebView, on Safari, or on Cloudflare's deployed Workers fleet.**
  Section 17 ran macOS 27.0.1's WebKit in a WKWebView, a local workerd and a desktop Chromium; R4 (on an iPhone and on the Android target) and R2 (against the deployed Worker) must run the committed engine check there (`scripts/relay-v2-engine-check/`).
  An Android System WebView older than the Chromium that added WebCrypto Ed25519 would throw on `generateIdentity`, `verifySignature` and admission signing, and the library fails closed (section 17.3).
- **That the Python and Swift agreement validates the design** (section 13).

## 13. Test vectors and independent verifiers

The generator `packages/shared/tests/relay/generate-vectors.ts` derives every value from fixed public seeds and writes `packages/shared/tests/fixtures/relay-v2/vectors.json`.
No key in that file is real: each is `SHA-256("remi-relay-v2 test vector " || label)` or a value computed from such seeds, and none has protected anything.
The format of the file is in section 16.

Three independent consumers check the same bytes:

1. The TypeScript implementation (`packages/shared/tests/relay/`).
2. A Python verifier, `scripts/verify-relay-v2-vectors.py`, written from this text alone.
3. A Swift CryptoKit verifier, `scripts/verify-relay-v2-vectors.swift`, for the primitives the iOS extension needs.

The web client (R4) adds a fourth consumer by importing the shared package.

**What the agreement shows, and what it does not.**
The TypeScript implementation (BoringSSL through WebCrypto), the Python verifier (OpenSSL) and the CryptoKit verifier are independent of one another, so their agreement on every byte shows two things: the primitives are used correctly (the HKDF inputs, the AEAD nonce and AAD, the ECDH output and the signature inputs mean the same thing in three crypto libraries), and the wire format of this ADR is unambiguously implementable (a reader of the text reaches the committed bytes, and section 15.4 lists where the first reader had to guess).
It does NOT show that the structural design is sound.
The Python author read the vector file, intermediate values included, and all three implementations follow the same ADR, so a flaw in the ADR's design (what is bound, what is authenticated, what an attacker can reorder) would be reproduced identically by all three.
That is the job of the independent cryptography review of this pull request (2026-10-04, a read-only adversarial reviewer on the strongest available model), which is the design check; this section's agreement is evidence of correct implementation and of an unambiguous text, not of security.

## 14. For implementers of R2 to R6

**The Worker (R2) must:**

- Issue a fresh 32-byte nonce per socket and accept each exactly once.
- Admit a host only on a valid host admission proof with `SHA-256(M_pk)[0..16] == rid`.
- Admit a client only on a valid client admission proof from an enrolled key, or during an open pairing window on a valid proof plus a ticket whose hash the host registered; compare the ticket hash in constant time (`admitTagMatches`) and delete the registration atomically with the check, so two concurrent presentations of one ticket admit at most one.
- Treat the ticket as Worker-visible and abuse-control only (section 4): never use it as a secret, never log it.
- Prefer a strict Ed25519 verifier and reject small-order public keys at admission (section 17.2).
- Change the enrolled set only on `enroll` and `revoke` messages from the authenticated host socket.
- Treat everything after admission as opaque bytes: forward text and binary frames between a client and the host, never parse them, never log their content, log sizes at most.
- Never accept a protocol version from a client or host; v2 is a path or a constant, not a negotiation.
- Verify the 1 MiB message limit and lower `MAX_PLAINTEXT` if it is wrong.

**The Worker must never:** hold, ask for or derive a pairing secret, a session key or a device private key; relay a frame that was not sent by the socket it arrived on; let a socket receive frames meant for another connection.

**The daemon (R3) must:**

- Create the machine identity once and keep it; derive `rid` from it.
- Keep a `PairingOffer` per live token.
  The step functions are `hostOnHello`, then `onAuth` on its result, then `ready` on that: mark the offer used and store the enrollment durably, and have the operator confirm the fingerprint, before calling `ready`, and call `abort` on every step a closing connection leaves unfinished.
- Close with the constants `CLOSE_CODE` and `CLOSE_REASON` when a handshake step throws, and on every WebSocket text frame after the handshake, whatever its content.
  A step only ever throws a `RelayError`: an engine failure, a keychain signer or a policy callback that throws is mapped to `IO`, so the daemon never meets a raw error from a step.
  A `Channel` closes itself through its `io` on every failure it counts (section 7), and a refused send (`ENDED`, `QUEUE_FULL`, `OVERSIZE`, empty, the reserved counter) is not a failure and must not close the connection: it would kill the read half that `bye()` keeps open.
- Bound concurrent half-open handshakes (each costs an ECDH and a signature before the peer has proved anything), and close a connection whose next handshake frame does not arrive in time: the library checks deadlines only when a step is handled and has no timer.
- Send `bye()` on every orderly close, call `await transportClosed()` in the socket's close handler (the library drains pending receives; the caller need not await them first) and treat `unclean` as "the tail may be truncated" (log it, and re-ask for anything not acknowledged); treat `peerEnded` together with `failed` as an attack or a bug (section 7).
- Define application-level acknowledgments inside the data channel for anything that must be known delivered (the answer to a prompt in particular): BYE ends a direction, it does not acknowledge receipt, and a tail withheld with the socket open is invisible to the library.
- Assert at startup that the library is configured for production: `random === systemRandom` AND `ephemeral === undefined` (no caller-supplied ephemeral hook), and refuse to start otherwise.
  A deterministic random source or a hook that returns a fixed pair would repeat ephemerals and with them the session key and nonce; the hook is the remaining way to do it.
- Hold at most `MAX_PAIRING_OFFERS` (8) live pairing offers at a time: a host tries only the first eight live offers, so the ninth secret would never match.
- Bound the work an unauthenticated `hello` can cause: in resume mode the host generates a key pair, does an ECDH and makes a signature before the client has proved anything (`hostOnHello`).
  Worker admission limits who reaches the host and the daemon must add a concurrency bound.
- Reject small-order device public keys at enrollment (section 17.2).
- Use `systemRandom` and `Date.now()` only at the edge, passing them into the library.

**The daemon must never:** reuse a `Channel` across connections; accept a pairing secret twice; send `ready` before the enrollment is stored; re-enter plaintext after a failure; log keys, secrets, plaintext or ciphertext.

**The clients (R4, R6) must:**

- Hold `D_sk` in the platform keychain and pass a signer into the library; never export it.
- Pin `M_pk` from the token and verify the token's expiry locally with the library.
- Display the fingerprint while waiting for `ready` in pair mode.
- Treat any close as final for that connection, and reconnect with a new handshake.

**The clients must never:** send `auth` before `hello_ack` has verified (the library makes this impossible, a client must not work around it); fall back to plaintext or to another version; trust a `rid` that came from the wire.

**R5 (push)** uses section 10 with the device's push key; the Notification Service Extension needs the private key in a shared keychain item and the verifier in section 13 shows CryptoKit can open the format.
R5 MUST carry the device push key from the device to the daemon over the authenticated channel and bind it to the enrolled device that sent it, and MUST NOT put a push key in the QR: the token's optional key is the daemon's answer-sealing key (deviation 7 in section 15.1), and a regression that moves a push key into the token would let anyone who sees the QR seal pushes to a device.

**R6 (answers)**: signed answers need question ids that are globally unique per prompt, a session nonce or an expiry, and single-accept by the daemon, because the channel cannot detect delay and a late or replayed answer is a valid frame.
The seal's AAD already binds `rid || question_id`.

**Exact list of v1 modules R3 deletes** (nothing is deleted in R1):

- `packages/daemon/src/remote/relay-adapter.ts`, `signaling-client.ts`, `code-store.ts`
- their tests: `packages/daemon/tests/relay-adapter-answer.test.ts`, `relay-adapter-auth.test.ts`, `relay-adapter-binding.test.ts`, `relay-client-to-daemon-conformance.test.ts`, `remote/code-store.test.ts`, `remote/relay-encryption.test.ts`, `remote/relay-route-message-seam-guard.test.ts`, `remote/signaling-client.test.ts`
- `packages/shared/src/relay-crypto.ts`, `packages/shared/tests/relay-crypto.test.ts`, and the `export * from './relay-crypto.ts'` line in `packages/shared/src/index.ts`
- `Authenticator.createChallengeWithRelayKex` and `Authenticator.verifyRelayKex` in `packages/daemon/src/auth/authenticator.ts`, with their cases in `packages/daemon/tests/authenticator.test.ts`
- the `relayEphemeralKey` and `relayKexSignature` fields of `AuthChallengeMessage` and `AuthResponseMessage`, and the `relayKex` parameters of `createAuthChallenge` and `createAuthResponse`, in `packages/shared/src/protocol.ts`
- the relay wiring and the `network.relay` configuration in `packages/daemon/src/cli.ts` and `packages/daemon/src/config/config.ts`

Not R3, listed so nobody deletes them early: `packages/shared/src/sealed-answer.ts`, `packages/daemon/src/auth/answer-key.ts`, `packages/daemon/tests/remote/sealed-answer-relay.test.ts` and `packages/web/src/lib/push-answer-relay.ts` belong to the v1 lock-screen answer path and are replaced in R6; the Worker's `code-generator.ts`, `connection-room.ts` and the `/answer/<code>` route are R2 and R7.

## 15. Issues found while specifying

This section is for the independent cryptography review and for the lead.
It lists every place this ADR departs from plan section 3.3.1 (or sections 3.1 and 3.5), every weakness found, and every ambiguity the specification had to resolve.
Nothing in this protocol silently differs from the plan.

### 15.1 Deviations from the plan, each with its reason

1. **`mode` is bound into `H1`.**
   Plan: `H1 = SHA-256(rid || v || E_c || n_c || E_h || n_h)`.
   Here the mode byte is part of the transcript.
   Without it a relay can flip `pair` to `resume` or back; the handshake still fails, but only one flight later, at the host's `auth` check, instead of at the client's check of `sig_h`.
   Binding every negotiated parameter into the signed transcript is the standard rule.
2. **`H1` carries a domain label and length prefixes.**
   Plan: plain concatenation of fixed-width fields, while the plan also says signatures cover a length-prefixed transcript.
   The fixed widths already make the plain form unambiguous; the label and prefixes add domain separation from every other hash in the system and keep the format safe if a field size ever changes.
3. **`H2` binds `D_pk` and the device name.**
   Plan: `H2 = SHA-256(H1 || sig_h)`.
   An Ed25519 signature does not commit to the signer's public key, so a signature over `H2` alone could in principle be presented under a different key; binding `D_pk` removes that.
   The name is shown to an operator in pair mode and is chosen by whoever holds the pairing secret, so it is signed too.
4. **The frame type byte is in the AAD.**
   Plan: `aad = "remi-relay-v2" || v || direction || counter`.
   `auth`, `ready` and data frames share one key per direction, and the type byte of a data frame is outside the ciphertext; authenticating it removes any reinterpretation of one frame type as another.
5. **The pairing secret is 32 bytes.**
   Plan section 3.1 says a "one-time 128-bit pairing secret"; section 3.3.1 and the R1 issue say 32 bytes.
   The plan contradicts itself.
   32 bytes is used: a QR has the room, and the secret is the only thing standing between a stranger and an enrollment.
6. **`ready` carries one mode byte, not `{ok, enrolled}`.**
   `ok` would always be true, because a failure closes the connection rather than answering, so a `not ok` reply would be a distinguishable oracle.
   `enrolled` is exactly "the mode was pair".
   The client compares the byte with the mode it asked for, which turns any mismatch into a typed failure.
7. **The token's optional key is the daemon's answer-sealing key, not a push key.**
   Plan section 3.1 puts "the daemon's push-sealing public key" in the QR; plan section 3.5 has the daemon seal each push to a key the DEVICE gives it.
   A daemon key in the QR can only serve the opposite direction (the phone sealing a lock-screen answer to the daemon, R6).
   The device's push key therefore travels from the device to the daemon inside the encrypted channel (R5).
   R5 and R6 must confirm this reading.
8. **The seal KDF binds the recipient key.**
   Plan: HKDF with the ephemeral public key as salt.
   Here `info = lps("remi-relay-v2 seal", R)` as well, which is the context binding HPKE uses, at the cost of one length-prefixed field.
9. **Handshake deadlines exist.**
   The plan has none.
   Without them a peer can keep a half-open host state, and the shared secret the host retains, alive forever.
   Pair mode gets a longer `ready` deadline because a human confirms the fingerprint in that window.
10. **Control frames are canonical JSON and the decoder compares the canonical text.**
    The plan says only "a versioned envelope".
    One equality check removes whole classes of parser differential (duplicate keys, key order, whitespace, number forms) between the TypeScript, Swift and Worker implementations.
11. **A host without a live pairing offer refuses a pair `hello`.**
    It would otherwise sign and derive for a request that can never succeed.
12. **The room id is never read from the wire.**
    The plan implies it; this ADR says it, because `rid` is bound into `H1` from the client's own trusted key.

### 15.2 Weaknesses and open points for the cryptography review

1. **Tail truncation: partly detected since the review (BYE).**
   Dropped frames followed by a later frame are a gap, and a cut-off frame fails its tag.
   A dropped suffix is detected only through the authenticated end of stream (section 7): a relay that drops the tail and the BYE and closes yields an `unclean` verdict, and cannot forge a BYE.
   Still not detected by the library: a tail withheld while the socket stays open, and anything about delivery to the peer; both need application acknowledgments and deadlines (section 14, R3 and R6).
   Tests record both the detected and the undetected cases.
2. **Delay is undetectable.**
   There are no timestamps.
   An answer that arrives late is a valid answer; R6's signed answers carry their own expiry and single-accept rule.
3. **The Worker sees a stable device pseudonym.**
   `D_pk` at admission links one phone's connections across time and networks.
   That is inherent to Worker-enforced admission (owner decision A) and is stated in section 11 rather than hidden.
4. **Pairing authenticates an unenrolled device by the pairing secret alone.**
   Anyone who photographs the QR within the 10-minute window can race to pair.
   The defenses are single use (the loser fails visibly, which is the useful signal), the short window, and the human fingerprint check on the host before `ready`.
   The library cannot enforce that check; the daemon must (section 14).
5. **Resume mode has no pairing secret.**
   Its security is the host's enrolled set plus `D_sk`; stealing `D_sk` allows impersonation until the device is revoked.
   The key lives in the platform keychain, and revocation is enforced both at the Worker and at the host.
6. **The host does an ECDH and a signature per unauthenticated `hello`.**
   That is an amplification a flood can use.
   Worker admission and a concurrency bound in the daemon (R3) are the mitigations; the library offers none beyond the deadlines.
7. **Ed25519 verification on non-canonical `S` and small-order keys, measured.**
   Section 17.2 records what five implementations do: all reject a non-canonical `S`, and all accept the small-order public keys.
   A malleated `sig_h` makes the client's `H2` differ from the host's, so the handshake fails closed, and signatures are never used as identifiers.
   Small-order keys are self-targeting in this trust model (section 17.2).
   Strict verifiers that also reject small-order public keys are recommended as defense in depth for the Worker and the clients.
8. **Constant-time comparison and zeroization are platform properties.**
   The library compares the admission-ticket hash with a XOR-accumulate loop; JavaScript engines give no guarantee for such a loop, and nothing relies on it alone: a hash of a secret does not help an attacker who learns a prefix.
   AEAD tag comparison is inside WebCrypto and is not verified here.
   Zeroing raw bytes is best effort (section 8).
9. **Timing is not uniform across failing checks.**
   The close reason is identical for every failure; the time between the last frame received and the close is not claimed to be.
10. **The 2^40 counter ceiling is a policy limit**, far below any AES-GCM limit for deterministic, never-repeating nonces; its job is to make exhaustion a defined failure.
11. **Forward secrecy is argued, not proven by tests.**
    The session keys are a function of the ephemeral shared secret `Z`, so a later theft of `M_sk`, `D_sk` or `psk` does not by itself recompute them.
    The tests show only that the derivation depends on `Z` and on every other input (a changed `Z` changes the keys); the argument that this yields forward secrecy is the design's, and no test demonstrates it end to end.
12. **The library cannot enforce the daemon's side of enrollment.**
    "Burn the offer and store the key before `ready`" is a contract in section 14, not something this package can check.
13. **Every session key rests on the injected random source.**
    Counters are the nonces, so two sessions that derived the same keys would reuse nonces.
    The keys are fresh unless both peers draw the same ephemeral scalar and both nonces, which only a broken random source does.
    `systemRandom` is `crypto.getRandomValues`, and the library never reads another source; the injected source of a test is deterministic by design and must never reach production, and R3 must assert at startup that it is `systemRandom` (section 14).
    Ephemeral keys no longer come from that source in production (the engine generates them), so only the nonces depend on it there.
14. **Building a key from a bare scalar fails on WebKit; production no longer does it (resolved by the review, section 17).**
    The first draft built every ephemeral key by importing a scalar as PKCS8 without the public half and asking the engine to derive the point.
    It worked on Bun, and was unverified elsewhere; the experiment of section 17 shows WebKit refuses it (`DataError`).
    Production ephemeral pairs now come from the engine's `generateKey` and identities from `generateKey` or an imported engine export; the scalar path is confined to `deterministic.ts` for tests and vectors.
15. **No version negotiation exists, by design.**
    A v1 frame fails as `TYPE` or `VERSION` and closes; a v2 endpoint never speaks v1.
    There is nothing to downgrade to.

### 15.3 Ambiguities in the plan that this ADR resolves

1. Which fields `H1` covers (mode added).
2. The pairing secret size (32 bytes).
3. How `prk = HKDF-Extract(salt = H1, ikm = Z || psk)` plus two `HKDF-Expand` calls maps to WebCrypto: one `deriveBits` call performs Extract then Expand, so two calls with the same salt and `ikm` and different `info` are exactly the plan's construction.
4. Whether counter `2^40` itself is valid ("above 2^40 closes"): it is valid, and `2^40 + 1` is not.
5. What `enrolled` means in `ready` (see 15.1, item 6).
6. The byte encoding of every control frame, the layout of the `auth` plaintext, and the AAD (the plan names the fields, not the bytes).
7. Whether `hello` carries `rid` (it does not).
8. The order of enrollment, fingerprint confirmation and `ready` in pair mode (confirmation, then enrollment and burn, then `ready`).
9. What a failure looks like on the wire (one close code and reason).

### 15.4 Ambiguities exposed by the independent Python verifier

`scripts/verify-relay-v2-vectors.py` was written by a separate agent that read only this ADR and the vector file, never the TypeScript.
It did read the vector file as well, so it was not blind to the recorded intermediate values (for example the signing inputs), and a reading that the vectors made obvious is marked as such in its report.
It matched every recorded value on its first run, including all negative cases, so nothing was found by a mismatch; it exposed the points below by having to choose.
Two reported readings differed from the reference implementation once the vectors were extended, and the ADR now states the intended one.
Each item names where this ADR was changed.

1. **Admission lengths** were unstated: a client proof over a 31-byte nonce verifies as a signature and was rejected only by an unwritten length rule. Section 4 now lists the lengths (a vector for a 15-byte room id was added).
2. **A binary frame where text is expected** was claimed by both step 1 and step 4 of section 6.1. Step 1 now says `TYPE`.
3. **Where the point check lives.** The `0x04` prefix belongs to the decoder and the on-curve check to ECDH. Python's `cryptography` accepts compressed points, so the platform is not a safe place to leave it. Section 6.1 says so.
4. **"Exactly the stated length"** contradicted the `auth` range. Step 6 now says so.
5. **Token versus frame error code.** The `MALFORMED` row of section 8 listed tokens; they are `TOKEN`.
6. **Token check order and "fixed part".** Section 5 now fixes the order (the bullet order) and the 75-byte minimum, adds the safe-integer rule for `expires_at`, and says the url pattern matches the whole string (Python's `$` also matches before a final newline; a vector pins it).
7. **`integer v`.** The reference was value-based (`3.0` is `VERSION`) and the verifier literal (`3.0` was `MALFORMED`). Section 6.1 now defines it by value and a vector pins it, together with `true`, `NaN` (not JSON) and a number `t` and `m`.
8. **`MAX_CONTROL_TEXT` units.** Characters, code points and UTF-16 units differ for non-ASCII text, and the reference counted UTF-16 units. It is now 512 bytes of UTF-8, in the implementation and in a vector (300 two-byte characters are `OVERSIZE`).
9. **Enrollment in pair mode** was unstated, and the pair-mode vectors listed the device as already enrolled. Section 6.3 says the library checks enrollment in resume mode only, and the pair vectors now carry an empty `enrolled` list.
10. **Device name rules.** A leading byte order mark is a character (the reference was stripping it by default and now keeps it, with a test), C1 controls are allowed, U+0020 is allowed and U+001F is not, and the empty name is allowed; vectors pin each. "Too long" cannot be reached through the handshake because the `auth` ciphertext range bounds the name at 64 bytes first.
11. **Ordering of the host's checks** (name, then signature, then enrollment) was untested because no vector had two defects. Two vectors do now. The order of data-frame checks 3 and 4 (`OVERSIZE` before `TYPE`) was thought unpinnable because a vector cannot carry a 512 KiB frame; the second round (below) showed a `frame_length` case carries one by length alone, and it now pins it.
12. **Deadlines.** Boundary inclusivity, the absence of a timer and the daemon's duty to close an idle connection are now stated in section 6.3 and section 14; the vectors do not cover deadlines, `handshake.test.ts` does.
13. **Pair offers.** Which offers are tried (the first live ones in policy order, at most eight) and what happens when an offer opens `auth` but a later check fails (that failure is reported, no other offer is tried) are now in section 6.3.
14. **Codes after a failure and on the sealing side.** Later receives are `CLOSED`; the sealing side's refusals have codes now (section 10) but no vectors.
15. **Easy to get wrong, now stated where they were only implied:** every `lps` argument is a part (the one-byte version and mode carry their own length prefix), the signatures are over the `lps` bytes, the HKDF `info` is raw in section 6.2 and length-prefixed in section 10, resume key material is `Z` alone, and the direction byte in the AAD is the sender's at both ends.
16. **Vectors that tested less than they claimed** (reported in the verifier's mutation run, 23 of 79 mutations of its own code survived): the unrelated-rule cases such as extra field, reordered keys and whitespace are all caught by the canonical comparison alone, which is by design (section 6.1 step 7) and the ADR now says the other rules are redundant for that purpose; positive coverage for `ws://localhost`, ports, paths, reserved flag bits, empty names and C1 characters was missing and was added; "host proof for another room" has two defects at once and is named that way, with the client-role twin isolating the signature binding.
17. **Section 16 wording.** Plain strings versus hex, the informational `session` field and the `enrolled` list are clarified.

The first verifier's author reported that it broke the "Python only through `uv`" rule twice, using the system `python3` to read the vector file's structure and to patch a scratch script outside the repository; no repository file was involved.

### 15.5 Second round: ambiguities exposed after BYE was added

After the independent review the spec gained BYE and the engine evidence.
A second fresh agent updated the Python verifier from the ADR and the vector file (it also read the previous verifier, which was itself written from the ADR; it never read the TypeScript or the Swift).
It implemented BYE from the ADR text alone before opening the old code, matched every BYE vector on the first try, and then reported the points below.
Each names where the ADR or the vectors changed.

1. **Refusal versus failure** (a contradiction between sections 14 and 7): section 14 said to close on every thrown `RelayError`, which would close a channel whose read half `bye()` is meant to keep open.
   Section 7 now separates a refusal (nothing emitted, no counter consumed, channel open) from a failure, and section 14 closes only on handshake-step errors and text frames.
2. **A sender with no counters left could not end cleanly** (a design gap): `bye()` takes a counter and the limit closed the channel.
   The final counter is now kept for the BYE (a sender-side rule, wire-invariant): data stops one short with the channel open, the BYE goes out at `MAX_COUNTER`.
   Tests and mutations pin it.
3. **The stream-end verdicts were underspecified and cannot be carried by the vectors.**
   Section 7 now says the verdict is about the inbound stream (so unclean after this side's own close or own BYE alone), that a receive after a close is `CLOSED` and after the peer's BYE `ENDED`, and that verdicts are library behavior the vectors do not carry.
4. **`minFrame` kept its name and value but the minimum of any frame became 25**, and the file carried neither `byeFrame` nor the type bytes: `constants` now carries `byeFrame`, `typeAuth`, `typeReady`, `typeData`, `typeBye`, `dirC2h`, `dirH2c`, and section 16 says which is the data minimum.
5. **"A frame after it is `ENDED`" was imprecise**: an earlier check of section 7 refuses a malformed frame first.
   Section 16 says so, and three vectors pin it (after a BYE: an unknown type is `TYPE`, a short BYE is `MALFORMED`, a counter above the limit is `COUNTER_LIMIT`).
6. **The check order was barely pinned.**
   Two-defect vectors now pin checks 4 and 5 before 6 (an unknown type, a 26-byte BYE and a 25-byte data frame, each with a counter above the limit) and a `frame_length` case pins `OVERSIZE` before `TYPE` (type 5, 524314 bytes).
7. **`direction` and `key` in `data_sequence`**: in the reflected cases `direction` is deliberately the wrong direction.
   Section 16 now says both are used exactly as given.
8. **`frame_length` filler**: every byte zero except the type and the counter field; check 1 is vacuous for bytes.
9. **Numbers and duplicate keys in step 2**: read as IEEE-754 doubles, and the last of a duplicated key wins; vectors pin `1e400`, a list and an object as `m`, and a duplicated mode whose first value is invalid.
10. **The order-2 count in section 17.2 was not reproducible without the messages**: the 16 messages are now named.
11. **Vectors that test less than they claim**: check 1 (a text frame) cannot be carried by a hex-string vector, so section 12 credits it to the TypeScript tests only; two cases were renamed for what they actually pin (a 25-byte data frame is too short for data; the BYE delivered twice pins `ENDED` before the counter check); and a valid frame after a failure is now an explicit case, which the runners feed and require to be refused.
12. **Mutations of the Python verifier's BYE logic** (42 breakages, 34 caught): the 8 survivors were the rules above that the vectors did not pin (`ENDED` before checks 2 to 6; check 4 before 3; check 1; check 6 before 5 and 4) plus three internal comparisons that are equivalent for a correct receiver.
    Items 5 and 6 add the vectors that close the first, second and fourth; check 1 is the third and stays TypeScript-only.

Not resolved by the extension, left for the cryptography review: Ed25519 verifier strictness on small-order public keys (section 17.2 measures it and recommends strict verifiers; no engine rejects them).

### 15.6 Delta review (round 2): what changed after the second review

The second review attacked the BYE surface and the engine evidence, reproduced the WebKit findings in its own WKWebView, and found the rework wire-invariant where it claimed.
It asked for nine things before R3 and R4 build on the library; all are applied, none changes a byte on the wire or `vectors.json`:

1. `transportClosed()` drains pending receives before the verdict (section 7); it was reading the verdict while a receive was still awaiting the engine.
2. The engine check is committed with runners and a README, and the vector test compares signatures by verification (sections 16 and 17.1, `scripts/relay-v2-engine-check/`).
3. The zeroization sentences say that production ephemeral keys are never bytes in JavaScript (sections 8 and 12).
4. Android WebView is named in every platform list, with the Ed25519 requirement and the R4 gate (sections 12, 17.1, 17.3, 19).
5. The R3 production assertion also requires `ephemeral === undefined`, a daemon holds at most eight live offers, the drain contract is stated, and a handshake step only ever throws `RelayError` (an engine failure, a keychain signer or a policy callback maps to `IO`) (sections 14 and 19).
6. `generateIdentity` keeps the in-memory signer's key non-extractable (section 1).
7. `signerFromKey` checks the key pair once at construction (section 1, `BAD_SIGNATURE`).
8. The verdict wording after an own close or own BYE says exactly when it is `unclean` and when `clean` (section 7).
9. A frame injected after a received BYE leaves `peerEnded` true with a `failed` verdict, and consumers are told to read both (section 7).

## 16. Vector file format

`vectors.json` is one JSON object.
Every byte value is a lowercase hex string; control frames and tokens are the exact text strings of sections 6.1 and 5; `deviceName`, `questionId`, `relayUrl` and every `name` are plain strings (a name is always UTF-8 when used as bytes); numbers are JSON numbers.
A verifier recomputes every value it can from the inputs and compares, and runs every negative case; reading a value from the file and trusting it proves nothing.

Top level: `format` (1), `protocol` (`"remi-relay-v2"`), `note`, `constants`, `identities`, `rid`, `ridDerivation`, `sessions`, `admission`, `pairingToken`, `seal`, `negative`.

- `constants`: `v`, `maxCounter`, `maxPlaintext`, `maxFrame`, `minFrame`, `maxControlText`, `maxDeviceName`, `handshakeTimeoutMs`, `pairConfirmTimeoutMs`, `pairingTtlSeconds`, `pairingSkewSeconds`, `maxPushPlaintext`, `closeCode`, `closeReason`, `byeFrame`, `typeAuth`, `typeReady`, `typeData`, `typeBye`, `dirC2h`, `dirH2c`: the values of section 2.  `minFrame` is the smallest DATA frame (26); the smallest frame of any type is `byeFrame` (25), the threshold of check 2 in section 7.
- `identities`: `machine`, `device`, `impostorMachine`, each `{ seed, publicKey }`; `seed` is the 32-byte Ed25519 seed (RFC 8032) and `publicKey` its public key.
- `rid` is section 3's room id of `identities.machine.publicKey`; `ridDerivation` is the same value computed separately and must equal it.

`sessions.pair` and `sessions.resume` are complete handshakes of the two modes, with these fields:

| Field | Meaning |
|---|---|
| `mode`, `psk`, `deviceName` | the mode, the 32-byte pairing secret (`null` in resume mode), the device name used (UTF-8) |
| `clientEphemeral`, `hostEphemeral` | `{ scalar, publicKey }`: the P-256 private scalar (32 bytes) and its 65-byte public key |
| `clientNonce`, `hostNonce` | `n_c`, `n_h` |
| `hello`, `helloAck` | the control frames of section 6.1 |
| `h1`, `hostSigningInput`, `hostSignature` | `H1`, `lps("remi-relay-v2 host", H1)`, `sig_h` |
| `z` | the 32-byte ECDH shared secret |
| `keys` | `{ c2h, h2c }`: `k_c2h`, `k_h2c` |
| `h2`, `clientSigningInput`, `clientSignature` | `H2`, `lps("remi-relay-v2 client", H2)`, `sig_c` |
| `authPlaintext`, `authNonce`, `authAad`, `authCiphertext`, `auth` | the `auth` plaintext, the 12-byte nonce, the 24-byte AAD, the ciphertext with tag, the control frame |
| `readyPlaintext`, `readyNonce`, `readyAad`, `readyCiphertext`, `ready` | the same for `ready` |
| `fingerprint` | section 9's display string for `D_pk` and `M_pk` |
| `data` | `{ c2h: [...], h2c: [...] }`, ten entries each: `{ counter, plaintext, nonce, aad, frame }` for counters 1 to 10; `frame` is the whole binary data frame |
| `bye` | `{ c2h, h2c }`, each `{ counter, nonce, aad, frame }` with counter 11: the BYE each side sends after its ten data frames; `frame` is the whole 25-byte binary frame |

A verifier checks that the ephemeral public keys follow from the scalars, that `z` follows from either side's scalar and the other's public key, that `h1`, `hostSignature`, `keys`, `h2`, `clientSignature`, the ciphertexts, the control frames, the nonces, the AADs, the fingerprint and every data frame follow from the inputs by sections 6, 7 and 9, and that every ciphertext opens to its plaintext.
Signatures are compared by verification, and byte for byte only where the implementation signs deterministically.
RFC 8032 signing is deterministic and Bun, workerd and OpenSSL follow it, so on those a recomputed `hostSignature` and `clientSignature` equal the file's; WebKit and CryptoKit sign with a random component (section 17.1), so there a verifier checks that the recorded signature verifies and takes the frames that contain a signature from the file.
Randomized signing is not a protocol property: `H2` binds `sig_h`, which only its host produces, and nothing hashes `sig_c`.

`admission`: `nonce`, `hostInput`, `hostSignature`, `clientInput`, `clientSignature` (section 4, for `identities.machine` and `identities.device` and the file's `rid`), `pairingSecret`, `ticket` (section 4's `A`), `ticketHash` (`SHA-256(A)`).

`pairingToken`: `nowSec`, `noSealKey` and `withSealKey`, each `{ text, relayUrl, machinePublicKey, secret, expiresAtSec, sealPublicKey }` (`sealPublicKey` is `null` when absent): `text` is section 5's string for those fields.

`seal`: `recipientScalar`, `recipientPublicKey`, `rid`, `questionId`, `aad`, `plaintext`, `ephemeralScalar`, `nonce`, `sealed`: section 10's output for a push with those inputs.

`negative` is a list of cases.
Every case has `kind`, `name` and `expect` (`"accept"` for a positive control, `"reject"` otherwise); a rejecting case has `code`, the error code of section 8 that the first failing check produces (except `admission_verify`, which only has a verdict).
Cases of kinds `hello_ack_verify`, `auth_open`, `auth_check` and `ready_open` also carry `session` (`"pair"` or `"resume"`), which names the session the case was derived from and is informational (a case's `helloAck` may come from another session than its `clientHello`): a verifier works from the fields below.
In `auth_check`, `enrolled` is what the host's enrolled set contains: in pair mode the device is not enrolled yet and the list is empty.

| `kind` | Fields | What a verifier does |
|---|---|---|
| `control_decode` | `frame` (`"hello"`, `"hello_ack"`, `"auth"` or `"ready"`), `text` | Applies the strict decoder of section 6.1, expecting that frame type, to `text` |
| `ec_point` | `publicKey` | Accepts only a valid uncompressed P-256 point |
| `hello_ack_verify` | `machinePublicKey`, `clientHello`, `helloAck` | Acts as the client of section 6.3 step 3: takes its mode, `E_c` and `n_c` from `clientHello`, the host values from `helloAck`, derives `rid` from `machinePublicKey`, computes `H1` and verifies `sig_h`; the failure is `BAD_SIGNATURE` |
| `auth_open` | `z`, `h1`, `psk` (the host's, or `null`), `auth`; optionally `senderPsk` | Derives the keys from `z`, `h1` and `psk` and opens `auth`; the failure is `PAIRING` when `psk` is not `null` and `DECRYPT` when it is.  When `senderPsk` is present (it may be `null`), the keys derived with it must open `auth`, which shows the case differs from a valid one only in the pairing secret |
| `auth_check` | `mode`, `z`, `h1`, `psk`, `hostSignature`, `auth`, `enrolled` (list of device public keys) | Opens `auth` (it must open), then applies section 6.3 step 5 in order: the name, `sig_c` over the recomputed `H2`, and in resume mode membership of `D_pk` in `enrolled` |
| `ready_open` | `mode`, `z`, `h1`, `psk`, `ready` | Derives the keys, decodes the control frame `ready`, opens it under `k_h2c` and requires the one-byte echo of `mode` |
| `data_sequence` | `key`, `direction`, `startRecv`, `frames`, `accepted` | Runs section 7's receiver over `frames` in order, expecting counter `startRecv` first, with `key` as the AEAD key and `direction` as the direction byte of the AAD (taken exactly as given: a reflected case sets it to the WRONG direction on purpose); `accepted` is how many frames (a BYE included) were accepted before the first failure and `code` is that failure's code; the first failure closes the receiver, so a verifier feeds every remaining frame too and requires each to be refused with `CLOSED`, whether or not it is valid.  A frame after a BYE is `ENDED` unless an earlier check of section 7 refuses it first. |
| `frame_length` | `type`, `length` | A frame of `length` bytes, every byte zero except the first (`type`) and the counter field (1): applies checks 2 to 6 of section 7 (check 1 is vacuous for bytes), with no counter order and no tag check |
| `token_decode` | `text`, `nowSec` | Decodes the token under section 5 with `nowSec` as the clock |
| `seal_open` | `recipientScalar`, `aad`, `sealed` | Opens `sealed` under section 10; every failure is `DECRYPT` |
| `admission_verify` | `role`, `publicKey`, `rid`, `nonce`, `signature` | Accepts exactly when section 4's check passes for that role |

## 17. Engines, key construction and Ed25519 behavior (a committed check, its results recorded here)

The independent review asked that the key path stop relying on one engine.
The library's production path was first built on an engine behavior (deriving a public key from a bare scalar or seed at import) that only Bun was known to support, and the web client runs this package in a WKWebView.
This section records what was run to find out, and what changed.
The check that produced it is committed (`scripts/relay-v2-engine-check/`), so it can be re-run on any target.

### 17.1 What ran

The check is committed, so every claim here can be re-run: `scripts/relay-v2-engine-check/` (its README has the exact `bun build --target=browser` commands and how to load the bundle in a web view).
`check.ts` has no `node:` import and no Bun API; it imports the library's internal barrel and `vectors.json`, and `run()` returns a report that the runners print.
Its groups are `base` (known answers of the primitives, the production key path, complete production handshakes in both modes with data and a BYE followed by a clean close), `jwk` (the committed vectors replayed through the step functions with every ephemeral key imported as a JWK whose public coordinates are supplied, the file's signatures replayed and verified on the engine, and every negative and control case run) and `scalar` (the same replay and known answers with keys built from a bare scalar or seed, informational).
A target passes when no `base` or `jwk` check fails.

| Engine | Version | Runner |
|---|---|---|
| Bun (JavaScriptCore, BoringSSL) | 1.4.2 and 1.3.11 | `bun scripts/relay-v2-engine-check/run-bun.ts` |
| workerd (the Cloudflare Workers runtime) | 1.20260107.1, through miniflare 4.20260107.0 (the lockfile's), compatibility date 2026-01-01 | `bun scripts/relay-v2-engine-check/run-workerd.ts`; local, no deployed Worker contacted |
| WebKit in a WKWebView | macOS 27.0.1 (26A434), WebKit.framework 22625.1.29.11.28 | `bun scripts/relay-v2-engine-check/run-webkit.ts` (a Swift host, `webkit-host.swift`, document origin `http://localhost/`, a secure context) |
| Chromium | Chrome for Testing 153.0.8010.12 (the headless shell of a Playwright cache on this Mac) | the same page bundle served from `http://127.0.0.1` and loaded with `--headless --dump-dom`; run once by hand, no committed runner |
| Python `cryptography` (OpenSSL), CryptoKit | 50.0.2; macOS 27.0.1 | the verifiers of section 13 and a measurement script |

Results of the committed check:

| Group | Bun 1.4.2 | Bun 1.3.11 | workerd | WebKit | Chromium 153 |
|---|---|---|---|---|---|
| `base` (15 checks) | 15 of 15 | 15 of 15 | 15 of 15 | 15 of 15 | 15 of 15 |
| `jwk` (24 checks) | 24 of 24 | 24 of 24 | 24 of 24 | 24 of 24 | 24 of 24 |
| `scalar` (informational) | 26 of 26 | 26 of 26 | 26 of 26 | 13 of 81 | 26 of 26 |

What WebKit showed, exactly:

1. **Importing a P-256 private key from PKCS8 without the public half fails**: `DataError: Data provided to an operation does not meet requirements`.
   This is the path the first draft used for every ephemeral key, and the review's concern was right.
   It now exists only in `deterministic.ts`; production uses `generateKey`, and every `base` and `jwk` check passes on WebKit.
   (The 68 failing `scalar` lines are every replay and case that builds a key from a scalar.)
2. **Ed25519 import from a PKCS8 seed works and derives the right public key** (it matches RFC 8032), so a persisted identity in the engine's PKCS8 form imports on WebKit; production still does not rely on the derivation, because the public key is stored next to the PKCS8.
3. **Ed25519 signing is randomized on WebKit** (and in CryptoKit): two signatures of one message differ, and each verifies on Bun, workerd, Python and CryptoKit.
   Determinism is not a protocol property (section 16), so the `jwk` group replays the file's recorded signatures and verifies each on the engine while every signing input is compared byte for byte.
4. Everything else passed: `generateKey` for P-256 and Ed25519, raw public export, PKCS8 export and import round trips, ECDH, HKDF, HMAC, AES-GCM with the counter nonce and AAD, strict base64url and the full handshake.

The `jwk` replay is how the vector checks are discharged on an engine that refuses scalar-built keys: the coordinates are computed in the check by a few lines of BigInt arithmetic, not by the engine, so it shows the protocol and verification run there and deliberately does not show scalar derivation.

What was NOT established:

- **An iOS device's WKWebView.**
  macOS 27.0.1's WebKit is the same code base as the WKWebView in iOS but not the iOS build.
  **Running the committed check on an iPhone is the owner's R4 check** (section 19).
- **An Android WebView** (section 17.3): not run.
- Safari as an application and Firefox were not run.
- The deployed Cloudflare fleet: workerd here is the open-source runtime at one version, run locally.
  R2 runs the Worker bundle (`entry-worker.ts`) as a throwaway Worker on the deployed runtime and reads its report.

### 17.2 Ed25519 verification, measured

The same cases were run on every implementation: a valid signature, a signature whose `S` was replaced by `S + L` (non-canonical), the all-identity "universal" signature (`R` the identity point, `S = 0`) under a small-order public key (the identity point), and the same shape under the order-2 point (valid for about half of all messages; the count in the table is over the 16 ASCII messages `message 0` to `message 15`).

| Implementation | Non-canonical `S` | Small-order public key (identity), any message | Order-2 key, accepted for N of 16 messages | Signing | 31-byte key |
|---|---|---|---|---|---|
| Bun 1.4.2 and 1.3.11 (BoringSSL) | rejected | accepted | 11 | deterministic | import throws |
| workerd 1.20260107.1 | rejected | accepted | 11 | deterministic | import throws |
| WebKit 22625.1.29 | rejected | accepted | 11 | randomized | import throws |
| Python `cryptography` 50.0.2 (OpenSSL) | rejected | accepted | 11 | deterministic | `ValueError` |
| CryptoKit (macOS 27.0.1) | rejected | accepted | 11 | randomized | throws |

Every implementation rejects a malleated `S`.
No implementation rejects small-order public keys: RFC 8032's verification equation does not forbid them.
A signature one engine produces (WebKit's randomized one) verifies on the others.

Consequences for this protocol:

- Malleation of `sig_h` changes only a value that `H2` binds, so a malleated signature fails the handshake and never succeeds as another.
- Small-order keys are self-targeting here.
  A small-order machine key belongs to whoever minted the token or registered the room; it lets that party sign as itself and the room id derives from the key, so no one else's room is affected.
  A small-order device key can only be enrolled by a party that holds the pairing secret or is already enrolled, so it adds no capability.
- Recommendation, as defense in depth and not as a requirement of the design: clients and the Worker should prefer a strict verifier that also rejects the eight small-order encodings, at admission, pairing and pinning.
  The library does not implement that check; R2 (admission) and R3 (enrollment) carry it (section 19).

### 17.3 Android WebView

remi targets Android through Capacitor, whose web layer is the Android System WebView, a Chromium.
`generateIdentity`, `verifySignature` and the admission signing use WebCrypto Ed25519, which Chromium added in version 137 (stated in the independent review of this phase from Chromium's release notes; I did not verify the release note).
An older System WebView has no Ed25519 in `crypto.subtle`: those calls throw, and the library fails closed (a handshake step maps the failure to `IO`), so the relay would be unusable there rather than unsafe.

What was run: the committed check on a desktop Chromium 153 passed every `base` and `jwk` check (section 17.1).
That shows the engine family works with this design; it does not show an Android WebView, which has a version of its own and ships through the Play Store independently of the OS.
The minimum WebView version the design needs is that of Ed25519 in `crypto.subtle`: expected 137 and unverified on a device.
R4 runs the committed check in the Android target's WebView (section 19) and decides what to do on a WebView without Ed25519.

## 18. Invariant: v2 signing inputs are disjoint from every other signed message

The v2 machine key is the Ed25519 identity the v1 Authenticator already keeps, and the v2 device key migrates from the v1 phone identity.
v1 direct authentication signs a BARE 32-byte challenge, the v1 relay key exchange signs `len:value` text beginning with a digit, and the iOS answer path signs `sid|qid|ans`.
A v2 signature must never be usable as any of those or the reverse.

That holds because every v2 signed message is `lps(label, ...)`:

- at least 54 bytes (the host transcript input is the shortest: 2 + 18 + 2 + 32), so it can never equal a 32-byte challenge;
- the first byte is zero (the high byte of a label length below 256), while the v1 key exchange input and the answer message begin with a printable ASCII byte;
- the first part is its own label (`remi-relay-v2 host`, `client`, `admit host`, `admit client`, `signer check`), distinct and none a prefix of another's length-prefixed form, so a signature over one input never verifies as another.

The fifth input is the probe `signerFromKey` signs once to prove a key pair matches: `lps("remi-relay-v2 signer check", 32 zero bytes)`, 62 bytes, whose signature never leaves the function.

The invariant is implicit in the construction.
`signing-inputs.test.ts` makes it explicit: it builds all five inputs and the real v1 `kexSigningInput` and challenge, asserts the three properties above, asserts that a signature over one input does not verify as another, and has a source guard requiring every `.sign(` call in the library to pass one of the five builders, so a future signed message with another shape fails the test.

## 19. Gates carried to later phases

The library cannot enforce these contracts; each is owned by a later phase.
The lead copies this table into the phase issues, and R7 (#1202) demonstrates every one in its end-to-end suite.
A row is closed only by the evidence named in its last column.

| Phase | Gate | Evidence that closes it |
|---|---|---|
| R2 (#1197) | Compare the registered admission-ticket hash in constant time (`admitTagMatches`) | The admission path calls `admitTagMatches`; a source guard bans `===` and `indexOf` on ticket hashes |
| R2 (#1197) | Burn the ticket registration atomically with the check (one Durable Object transaction) | A test presenting one ticket twice and concurrently admits exactly one socket |
| R2 (#1197) | Treat the ticket as Worker-visible and abuse-control only; never log it | Code review against section 4; the Worker's logs hold no ticket |
| R2 (#1197) | Confirm the Cloudflare WebSocket message ceiling (1 MiB is unverified) and lower `MAX_PLAINTEXT` if it is wrong | A test through the real Durable Object sends frames of `MAX_FRAME` and `MAX_FRAME + 1` bytes |
| R2 (#1197) | Limit hello floods: per-address and per-device-key rate limits and a cap on unadmitted sockets | A test that exceeds each limit and is refused |
| R2 (#1197) | Host and client admission checks exactly as section 4 (lengths, role binding, room-id hash, enrolled set changed only by the authenticated host) | The vector `admission_verify` cases pass in the Worker, and tests for each refusal |
| R2 (#1197) | Prefer a strict Ed25519 verifier: reject small-order public keys at admission | A test admitting the identity-point key is refused |
| R2 (#1197) | Run the committed engine check on the deployed Worker runtime | `entry-worker.ts` (bundled as in `scripts/relay-v2-engine-check/README.md`) deployed as a throwaway Worker returns a report whose `base` and `jwk` groups have no failure |
| R3 (#1198) | Burn the single-use pairing secret, confirm the fingerprint with the operator, store the enrollment durably, all BEFORE calling `ready`; enforce the ten-minute TTL | A real-daemon test in which `ready` is not sent until the enrollment is stored, and a second use of one secret is refused |
| R3 (#1198) | Send `bye()` on every orderly close, `await transportClosed()` in every socket close handler (the library drains pending receives, callers need not await them), act on `unclean`, and treat `peerEnded` with `failed` as an attack or a bug | A real-daemon test that drops the tail and the BYE and sees the unclean verdict, one that closes with a receive still in flight and sees the clean verdict, and one that injects a frame after a BYE |
| R3 (#1198) | Application acknowledgments for answers and anything that must be known delivered | A test in which a withheld acknowledgment is noticed by the application |
| R3 (#1198) | Assert at startup that `random === systemRandom` AND `ephemeral === undefined` | A test that a daemon built with another random source, or with an ephemeral hook, refuses to start |
| R3 (#1198) | Hold at most `MAX_PAIRING_OFFERS` (8) live offers | A test that a ninth live offer is refused by the daemon's offer store |
| R3 (#1198) | Bound concurrent unauthenticated hellos and close idle or half-open handshakes (the library has no timer); call `abort` on unfinished steps | Tests of the bound and of an idle handshake being closed |
| R3 (#1198) | Reject small-order device keys at enrollment | A test enrolling the identity-point key is refused |
| R3 (#1198) | Close with `FAILURE_CLOSE` when a handshake step throws (a step only ever throws a `RelayError`) and on every text frame after the handshake; do not close on a refused send | A test per path against the real adapter |
| R4 (#1199) | Run the committed engine check in a real WKWebView on an iPhone (the owner) | `scripts/relay-v2-engine-check/` (README: bundle `entry-page.ts`, load it, call `__run`) run on the device has no `base` or `jwk` failure, and its output is recorded in the issue |
| R4 (#1199) | Run the committed engine check on the Android target's WebView, and decide what the client does on a WebView without WebCrypto Ed25519 (the library fails closed) | The same check run on the Android target; its output and the minimum WebView version found are recorded in the issue |
| R4 (#1199) | Keep the device key in the platform keychain and persist it as the engine's PKCS8 export plus the raw public key; never import a bare scalar | A test and a code review of the identity store |
| R4 (#1199) | Pin `M_pk` from the token, check expiry locally, show the fingerprint while waiting for `ready`, treat any close as final for the connection | Client tests of each |
| R5 (#1200) | Carry the device push key over the authenticated channel and bind it to the enrolled device; never put a push key in the QR | A test that a push key sent by a device other than the enrolled one is refused, and that the token has no push key |
| R6 (#1201) | Answers: globally unique question ids per prompt, a session nonce or expiry, single-accept by the daemon (the channel cannot detect delay) | Tests of a replayed, a late and a duplicate answer, each refused |
| R7 (#1202) | The end-to-end suite demonstrates each row above against the real Durable Object, the real hub and a real client | The suite's report names the test for each row |

## Consequences

Easier: one audited, versioned wire contract that the daemon, the Worker and every client import or check against the same committed bytes; every failure is a typed error in tests and an identical close on the wire.

Harder: every failure looks the same to a user, so a revoked device and a network fault are indistinguishable at this layer (R4 decides the user experience); the daemon must implement enrollment ordering and confirmation correctly because the library only enforces what it can see; the Worker learns device public keys and pairing timing.

## Alternatives considered

- **The Noise protocol framework (for example `XXpsk3`):** a better-reviewed design for the same goals.
  Rejected by the owner (decision B) to keep the audited primitives and the WebCrypto and CryptoKit coverage already in hand; X25519 and ChaCha20-Poly1305 are not assumed on every target.
- **Random 96-bit nonces (as v1):** collision-safe at this volume, but they give no ordering, no replay detection and no way to detect a dropped frame.
  Counters make all three observable errors.
- **TLS or DTLS inside the relay:** a larger dependency surface and no WebCrypto path on iOS WKWebView.
- **Trust on first use:** deleted.
  A pairing secret and a human check replace it.

## Receipts

- Plan of record: `.context/relay-rebuild-plan-2026-10.md` sections 1 to 3.3.1, 6, 7, 8.
- v1 code read for this ADR: `packages/shared/src/relay-crypto.ts`, `packages/shared/src/sealed-answer.ts`, `packages/daemon/src/auth/authenticator.ts`.
- [ADR 0014](0014-two-sided-conformance-tests.md): the two-sided conformance pattern this phase follows for the wire.
- [ADR 0011](0011-verify-before-you-describe.md): every sentence here is meant to be true of the code R1 ships, and anything not verified is labeled unverified.
