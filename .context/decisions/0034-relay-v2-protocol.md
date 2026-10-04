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
| Identity signatures | Ed25519 (RFC 8032, deterministic) | public key 32 bytes raw, signature 64 bytes |
| Key agreement | ECDH on P-256 | public key 65 bytes, uncompressed SEC1 (`0x04 \|\| X \|\| Y`); shared secret is the 32-byte X coordinate |
| Key derivation | HKDF-SHA256 (RFC 5869), one Extract then one Expand per output | |
| Authenticated encryption | AES-256-GCM, 12-byte nonce, 16-byte tag, tag appended to the ciphertext | |
| Hashing | SHA-256 | |
| Admission ticket | HMAC-SHA256 | |

No new dependency is introduced.
The implementation never decides a curve, hash or cipher at run time: nothing is negotiated.

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
| `TYPE_AUTH`, `TYPE_READY`, `TYPE_DATA` | bytes `0x01`, `0x02`, `0x03` |
| `MAX_COUNTER` | 2^40 = 1099511627776 |
| `MAX_PLAINTEXT` | 524288 (2^19) bytes per data frame |
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

A data frame is a WebSocket binary message:

```
[TYPE_DATA] || be64(counter) || ct||tag          length 26 to MAX_FRAME
```

Plaintext length is 1 to `MAX_PLAINTEXT` bytes.

Receiver, per direction, tracking `last` (0 after the handshake).
Checks run in this order and stop at the first failure; the first failure closes the channel for good:

1. The frame is binary, else `TYPE` (a text frame after the handshake, which includes a second `hello`).
2. Length at least 26, else `MALFORMED`.
3. Length at most `MAX_FRAME`, else `OVERSIZE`.
4. First byte is `TYPE_DATA`, else `TYPE`.
5. `counter <= MAX_COUNTER`, else `COUNTER_LIMIT`.
6. `counter == last + 1`, else `COUNTER`: a repeat, a reorder and a gap are all this one failure.
7. The AEAD tag verifies under the receive key with `nonce(counter)` and `aad(TYPE_DATA, peer direction, counter)`, else `DECRYPT`.
8. Only now is `last` set to `counter` and the plaintext returned.

Sender: the plaintext is copied when `send` is called, so a caller that reuses its buffer changes nothing; the counter is assigned synchronously at the same moment, so counter order is call order; a sender whose next counter would exceed `MAX_COUNTER` closes the channel (`COUNTER_LIMIT`); plaintext outside 1 to `MAX_PLAINTEXT` is refused before a counter is consumed (`OVERSIZE`, or `MALFORMED` for empty); more than `MAX_PENDING_SENDS` unsent frames refuses the new one before a counter is consumed (`QUEUE_FULL`).
Encryption and emission run through one promise chain, so frame `n + 1` is not emitted before frame `n`, whatever the relative speed of their encryptions.
If encryption or emission of any frame fails, the channel closes with the failure close and every later send is refused (`CLOSED`): a frame is never skipped.
After the first failure every later receive is `CLOSED`.
Received frames are copied on arrival and processed through a second chain, so results are delivered in arrival order and a bad frame poisons the frames behind it.
A deliberate local close ends the channel with code `CLOSE_NORMAL` and the reason `"closed"`; it is not a failure.

There is no resumption.
A reconnect is a new handshake with fresh ephemeral keys and nonces; session state belongs to the application, not to the key.

## 8. Failure behavior

- Every parse or verification failure, whichever check produced it, closes the WebSocket with code `CLOSE_CODE` (4400) and reason `CLOSE_REASON` (`"closed"`), and nothing else is sent first.
  The typed error codes in this document exist for tests and for the local log, never for the wire.
- An unknown version, mode or message type closes.
- There is no plaintext fallback: no frame is ever accepted or sent unencrypted after `hello_ack`, and `hello` and `hello_ack` carry only public values.
- The close code and reason are constants of the module; no failure path chooses them.
- Key material is dropped when a handshake or channel ends, to the extent the platform allows.
  What the library does: the ephemeral scalar is overwritten as soon as the key is built (a test shows it); the raw channel keys are overwritten as soon as they are imported (a test shows it); a step that fails or is aborted overwrites the secrets it holds (not observable from outside, so no test shows it); a failed channel releases its `CryptoKey` references.
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
| `COUNTER_LIMIT` | a counter above `MAX_COUNTER`, received or about to be sent |
| `UNKNOWN_DEVICE` | resume by a device key the host has not enrolled |
| `PAIRING` | pair mode with no live offer, or no live offer whose secret opens `auth` |
| `EXPIRED` | a handshake deadline passed, or a pairing token past its expiry |
| `STATE` | a step called twice or after `abort` |
| `NAME` | a device name that is too long, not UTF-8 or contains a control character |
| `TOKEN` | a pairing token that is malformed or outside the policy |
| `QUEUE_FULL` | more than `MAX_PENDING_SENDS` unsent frames |
| `CLOSED` | a send or receive on a channel that has closed |
| `IO` | the transport or the engine failed while a frame was being sent |

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
Duplicates, reordering and injection are detected and close the channel; a delay is not detected; a drop followed by a later frame is detected as a gap; a drop of the tail followed by a close is not detected (see "Issues found while specifying").

## 12. Claims, and what demonstrates each

A claim appears here only with the evidence that shows it.
Test files are under `packages/shared/tests/relay/`; "vectors" means `vectors.test.ts` running the committed file, "Python" and "Swift" the two verifiers of section 13.
Every test was also checked by mutation: the mutated source was applied, the suite failed, the mutation was reverted (the results are in the pull request).

| Claim | Evidence |
|---|---|
| A replayed, reordered or dropped-then-continued frame, a truncated or extended frame, a flipped bit anywhere in a frame, a frame under another key, a reflected frame, counter 0 after the handshake, a counter above the limit with a valid tag, an oversized frame and a text frame after the handshake are each refused, and the channel then refuses everything | `channel.test.ts` (one test per case, a bit-by-bit test over a whole frame, 600 property cases); vectors `data_sequence` and `frame_length`; Python; Swift |
| Every failure closes with one code and reason | `channel.test.ts` ("every failure closes with the same code and reason", "every RelayError code maps to the one wire close") |
| A dropped tail is NOT detected | `channel.test.ts` ("a dropped tail is NOT detected"), recorded so it cannot be forgotten |
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

Not claimed, because no test shows it:

- **Forward secrecy.**
  The keys depend on the ephemeral shared secret (`handshake.test.ts`, key schedule), and the argument that this gives forward secrecy is the design's.
- **Metadata hiding.** Section 11 says what the Worker sees.
- **Constant-time behavior** of any comparison or of the platform's AEAD and signature code.
- **Zeroization** beyond the two cases in section 8 (the ephemeral scalar and the raw channel keys).
- **Detection of a delayed or tail-truncated stream** (section 15.2).
- **Behavior on engines other than Bun 1.4.2 and 1.3.11, CryptoKit and `cryptography`.**
  Safari, workerd and the Cloudflare runtime are unverified; R2 and R4 must run the vectors there.

## 13. Test vectors and independent verifiers

The generator `packages/shared/tests/relay/generate-vectors.ts` derives every value from fixed public seeds and writes `packages/shared/tests/fixtures/relay-v2/vectors.json`.
No key in that file is real: each is `SHA-256("remi-relay-v2 test vector " || label)` or a value computed from such seeds, and none has protected anything.
The format of the file is in section 16.

Three independent consumers check the same bytes:

1. The TypeScript implementation (`packages/shared/tests/relay/`).
2. A Python verifier, `scripts/verify-relay-v2-vectors.py`, written from this text alone.
3. A Swift CryptoKit verifier, `scripts/verify-relay-v2-vectors.swift`, for the primitives the iOS extension needs.

The web client (R4) adds a fourth consumer by importing the shared package.

## 14. For implementers of R2 to R6

**The Worker (R2) must:**

- Issue a fresh 32-byte nonce per socket and accept each exactly once.
- Admit a host only on a valid host admission proof with `SHA-256(M_pk)[0..16] == rid`.
- Admit a client only on a valid client admission proof from an enrolled key, or during an open pairing window on a valid proof plus a ticket whose hash the host registered; delete the registration on use.
- Change the enrolled set only on `enroll` and `revoke` messages from the authenticated host socket.
- Treat everything after admission as opaque bytes: forward text and binary frames between a client and the host, never parse them, never log their content, log sizes at most.
- Never accept a protocol version from a client or host; v2 is a path or a constant, not a negotiation.
- Verify the 1 MiB message limit and lower `MAX_PLAINTEXT` if it is wrong.

**The Worker must never:** hold, ask for or derive a pairing secret, a session key or a device private key; relay a frame that was not sent by the socket it arrived on; let a socket receive frames meant for another connection.

**The daemon (R3) must:**

- Create the machine identity once and keep it; derive `rid` from it.
- Keep a `PairingOffer` per live token.
  The step functions are `hostOnHello`, then `onAuth` on its result, then `ready` on that: mark the offer used and store the enrollment durably, and have the operator confirm the fingerprint, before calling `ready`, and call `abort` on every step a closing connection leaves unfinished.
- Close with the constants `CLOSE_CODE` and `CLOSE_REASON` on every thrown `RelayError`, and on every WebSocket text frame after the handshake, whatever its content.
- Bound concurrent half-open handshakes (each costs an ECDH and a signature before the peer has proved anything), and close a connection whose next handshake frame does not arrive in time: the library checks deadlines only when a step is handled and has no timer.
- Define application-level acknowledgments and an authenticated end-of-stream message inside the data channel, because the channel alone cannot tell a clean close from a truncation.
- Use `systemRandom` and `Date.now()` only at the edge, passing them into the library.

**The daemon must never:** reuse a `Channel` across connections; accept a pairing secret twice; send `ready` before the enrollment is stored; re-enter plaintext after a failure; log keys, secrets, plaintext or ciphertext.

**The clients (R4, R6) must:**

- Hold `D_sk` in the platform keychain and pass a signer into the library; never export it.
- Pin `M_pk` from the token and verify the token's expiry locally with the library.
- Display the fingerprint while waiting for `ready` in pair mode.
- Treat any close as final for that connection, and reconnect with a new handshake.

**The clients must never:** send `auth` before `hello_ack` has verified (the library makes this impossible, a client must not work around it); fall back to plaintext or to another version; trust a `rid` that came from the wire.

**R5 (push)** uses section 10 with the device's push key; the Notification Service Extension needs the private scalar in a shared keychain item and the verifier in section 13 shows CryptoKit can open the format.

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

1. **Tail truncation is not detectable at this layer.**
   A relay that drops the last frames and then closes the socket looks like a clean close.
   Dropped frames followed by a later frame are detected (gap), and a cut-off frame is detected (tag), but a dropped suffix is not.
   The consequence is concrete: a dropped final answer.
   Fix proposed: an authenticated end-of-stream and application acknowledgments inside the data channel (R3), or a counter-checked `TYPE_BYE` frame in this protocol if the review prefers it in the library.
   R1 implements neither, and a characterization test records the limit.
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
7. **Ed25519 verifiers differ on edge cases** (non-canonical `S`, small-order keys).
   A malleated `sig_h` makes the client's `H2` differ from the host's, so the handshake fails closed, and signatures are never used as identifiers.
   The review should still decide whether verifiers must reject non-canonical `S`.
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
    `systemRandom` is `crypto.getRandomValues`, and the library never reads another source; the injected source of a test is deterministic by design and must never reach production.
14. **An ephemeral key is built by importing its scalar as PKCS8 without the public half.**
    The library does this so that a run is reproducible from an injected source and the private key stays non-extractable.
    It works on Bun 1.4.2 and 1.3.11 (BoringSSL); it is unverified on WebKit (the iOS client) and on workerd.
    If a platform refuses it, the fix is to compute the public point from the scalar (a few lines of BigInt scalar multiplication) and import a JWK instead; R4 must run the vectors in a real WKWebView before relying on this.
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
11. **Ordering of the host's checks** (name, then signature, then enrollment) was untested because no vector had two defects. Two vectors do now. The order of data-frame checks 3 and 4 (`OVERSIZE` before `TYPE`) is still not pinned by a vector, because a vector cannot carry a 512 KiB frame.
12. **Deadlines.** Boundary inclusivity, the absence of a timer and the daemon's duty to close an idle connection are now stated in section 6.3 and section 14; the vectors do not cover deadlines, `handshake.test.ts` does.
13. **Pair offers.** Which offers are tried (the first live ones in policy order, at most eight) and what happens when an offer opens `auth` but a later check fails (that failure is reported, no other offer is tried) are now in section 6.3.
14. **Codes after a failure and on the sealing side.** Later receives are `CLOSED`; the sealing side's refusals have codes now (section 10) but no vectors.
15. **Easy to get wrong, now stated where they were only implied:** every `lps` argument is a part (the one-byte version and mode carry their own length prefix), the signatures are over the `lps` bytes, the HKDF `info` is raw in section 6.2 and length-prefixed in section 10, resume key material is `Z` alone, and the direction byte in the AAD is the sender's at both ends.
16. **Vectors that tested less than they claimed** (reported in the verifier's mutation run, 23 of 79 mutations of its own code survived): the unrelated-rule cases such as extra field, reordered keys and whitespace are all caught by the canonical comparison alone, which is by design (section 6.1 step 7) and the ADR now says the other rules are redundant for that purpose; positive coverage for `ws://localhost`, ports, paths, reserved flag bits, empty names and C1 characters was missing and was added; "host proof for another room" has two defects at once and is named that way, with the client-role twin isolating the signature binding.
17. **Section 16 wording.** Plain strings versus hex, the informational `session` field and the `enrolled` list are clarified.

Not resolved by the extension, left for the cryptography review: Ed25519 verifier strictness on non-canonical `S` and small-order keys (section 15.2, item 7); no vector exercises either.

The verifier also reported that its author broke the "Python only through `uv`" rule twice, using the system `python3` to read the vector file's structure and to patch a scratch script outside the repository; no repository file was involved.

## 16. Vector file format

`vectors.json` is one JSON object.
Every byte value is a lowercase hex string; control frames and tokens are the exact text strings of sections 6.1 and 5; `deviceName`, `questionId`, `relayUrl` and every `name` are plain strings (a name is always UTF-8 when used as bytes); numbers are JSON numbers.
A verifier recomputes every value it can from the inputs and compares, and runs every negative case; reading a value from the file and trusting it proves nothing.

Top level: `format` (1), `protocol` (`"remi-relay-v2"`), `note`, `constants`, `identities`, `rid`, `ridDerivation`, `sessions`, `admission`, `pairingToken`, `seal`, `negative`.

- `constants`: `v`, `maxCounter`, `maxPlaintext`, `maxFrame`, `minFrame`, `maxControlText`, `maxDeviceName`, `handshakeTimeoutMs`, `pairConfirmTimeoutMs`, `pairingTtlSeconds`, `pairingSkewSeconds`, `maxPushPlaintext`, `closeCode`, `closeReason`: the values of section 2.
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

A verifier checks that the ephemeral public keys follow from the scalars, that `z` follows from either side's scalar and the other's public key, that `h1`, `hostSignature`, `keys`, `h2`, `clientSignature`, the ciphertexts, the control frames, the nonces, the AADs, the fingerprint and every data frame follow from the inputs by sections 6, 7 and 9, and that every ciphertext opens to its plaintext.
Ed25519 signatures are deterministic, so `hostSignature` and `clientSignature` can be compared byte for byte as well as verified.

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
| `data_sequence` | `key`, `direction` (the sender's direction byte), `startRecv`, `frames`, and for `accept` or a rejection `accepted` | Runs section 7's receiver over `frames` in order with `last + 1 = startRecv`, with `key` as the key of the frames' direction; `accepted` is how many frames were accepted before the first failure, and `code` is that failure's code |
| `frame_length` | `length` | A data frame of that many bytes whose first byte is the data type and whose counter is 1: applies only checks 2 to 5 of section 7 (no tag check) |
| `token_decode` | `text`, `nowSec` | Decodes the token under section 5 with `nowSec` as the clock |
| `seal_open` | `recipientScalar`, `aad`, `sealed` | Opens `sealed` under section 10; every failure is `DECRYPT` |
| `admission_verify` | `role`, `publicKey`, `rid`, `nonce`, `signature` | Accepts exactly when section 4's check passes for that role |

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
