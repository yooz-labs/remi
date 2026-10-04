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
| `MAX_FRAME` | `1 + 8 + MAX_PLAINTEXT + 16` = 524313 bytes, the largest binary data frame |
| `MAX_CONTROL_TEXT` | 512 characters, the largest control frame |
| `MAX_DEVICE_NAME` | 64 bytes of UTF-8 |
| `HANDSHAKE_TIMEOUT_MS` | 30000 |
| `PAIR_CONFIRM_TIMEOUT_MS` | 120000 |
| `PAIRING_TTL_SECONDS` | 600 |
| `PAIRING_SKEW_SECONDS` | 60 |
| `MAX_PENDING_SENDS` | 64 |
| `MAX_PUSH_PLAINTEXT` | 2048 bytes |
| `CLOSE_CODE`, `CLOSE_REASON` | 4400 and the string `"closed"` |

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

A decoder rejects (code `TOKEN`, or `EXPIRED` where noted):

- a string without the prefix, or with a payload that is not canonical base64url;
- a token shorter than the fixed part, with `token_version != 2`, with any reserved flag bit set, or with a `relay_url` length outside 1 to 512;
- a `relay_url` that does not match `^(wss://[a-z0-9.-]+|ws://(localhost|127\.0\.0\.1))(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$` (no userinfo, no query, no fragment, no IPv6 literal, lowercase host);
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

1. The text is a string of at most `MAX_CONTROL_TEXT` characters, else `OVERSIZE`.
2. It parses as JSON and is an object with an integer `v`, else `MALFORMED`.
3. `v == 2`, else `VERSION`.
4. `t` is the type the receiver expects at this step of the handshake, else `TYPE` (an unknown type, a known type at the wrong step, or a binary frame where text is expected).
5. For `hello`, `m` is `"pair"` or `"resume"`, else `MODE`.
6. The object has exactly the expected keys, each value a string, each binary value canonical base64url of exactly the stated length, else `MALFORMED`.
7. The canonical text rebuilt by the encoder from the decoded values equals the received text character for character, else `MALFORMED`.
   This one comparison rejects duplicate keys, reordered keys, whitespace, alternative escapes and non-canonical numbers.

`E_c` and `E_h` must also be valid P-256 points; the platform rejects an off-curve point at import and that is `MALFORMED`.

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
   - Resume mode: keys use an empty `psk`.
   - Pair mode: the host tries each live offer in order, deriving keys with that offer's secret; the first offer under which the tag verifies is the matching one.
     If none verifies, it closes (`PAIRING`).
     This is why a client with the wrong pairing secret fails here, with the same observable result as any other failure.
   It then checks, in this order: the plaintext length and layout (`MALFORMED`), the name (`NAME`), `sig_c` under `D_pk` over the host's own `H2` (`BAD_SIGNATURE`), and in resume mode that `D_pk` is enrolled (`UNKNOWN_DEVICE`).
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

State misuse (a transition called out of order, a state used twice) is `STATE`.

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

Sender: the counter is assigned synchronously when `send` is called, so counter order is call order; a sender whose next counter would exceed `MAX_COUNTER` closes the channel (`COUNTER_LIMIT`); plaintext outside 1 to `MAX_PLAINTEXT` is refused before a counter is consumed (`OVERSIZE`, or `MALFORMED` for empty); more than `MAX_PENDING_SENDS` unsent frames refuses the new one before a counter is consumed (`QUEUE_FULL`).
Encryption and emission run through one promise chain, so frame `n + 1` is not emitted before frame `n`, whatever the relative speed of their encryptions.
If encryption or emission of any frame fails, the channel closes: a frame is never skipped.
Received frames are processed through a second chain, so results are delivered in arrival order.

There is no resumption.
A reconnect is a new handshake with fresh ephemeral keys and nonces; session state belongs to the application, not to the key.

## 8. Failure behavior

- Every parse or verification failure, whichever check produced it, closes the WebSocket with code `CLOSE_CODE` (4400) and reason `CLOSE_REASON` (`"closed"`), and nothing else is sent first.
  The typed error codes in this document exist for tests and for the local log, never for the wire.
- An unknown version, mode or message type closes.
- There is no plaintext fallback: no frame is ever accepted or sent unencrypted after `hello_ack`, and `hello` and `hello_ack` carry only public values.
- The close code and reason are constants of the module; no failure path chooses them.
- Key material is dropped when a handshake or channel ends: raw secret bytes the library holds (ephemeral scalars, the shared secret, derived keys) are overwritten with zeros, and `CryptoKey` references are released.
  A `CryptoKey` cannot be zeroed and JavaScript gives no guarantee about copies the engine made, so this is best effort and is claimed no further.

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

For a push, `aad = rid || question_id` where `rid` is the 16 bytes above and `question_id` is 1 to 64 bytes of UTF-8 (the same string is the APNS collapse id).
Plaintext is 1 to `MAX_PUSH_PLAINTEXT` bytes; APNS allows 4096 bytes per payload in total, and R5 sets the exact budget.
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

## 12. Claims, and what each test demonstrates

This table is filled in when the tests exist (see the pull request for R1); it is part of the ADR so the claims stay checkable.
The properties are claimed only to the extent the named evidence shows them.

(Filled in by the final commit of R1.)

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
- Keep a `PairingOffer` per live token; mark it used before calling `hostReady`, and call `hostReady` only after the enrollment is durably stored and the operator has confirmed the fingerprint.
- Close with the constants `CLOSE_CODE` and `CLOSE_REASON` on every thrown `RelayError`, and on every WebSocket text frame after the handshake, whatever its content.
- Bound concurrent half-open handshakes (each costs an ECDH and a signature before the peer has proved anything).
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
13. **No version negotiation exists, by design.**
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

(Filled in after the verifier, written from this text alone, has run.)

## 16. Vector file format

(Filled in by the commit that adds the vectors.)

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
