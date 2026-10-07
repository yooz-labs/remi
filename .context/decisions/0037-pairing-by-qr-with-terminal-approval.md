# ADR 0037: Pairing by QR, approved at the terminal

**Status:** accepted (#1275, milestone "Native apps (X3-X4)")
**Date:** 2026-10-07
**Owner:** Yahya

## Context

A phone reaches a machine directly (a LAN or VPN address, `daemon.bind` set, authentication on).
Since #873 an unknown client key is never trusted on first use: the daemon verifies the client's signature, stores the key as pending for ten minutes, and the person approves it with `remi authorize <fingerprint>` after comparing fingerprints.
That is the right trust step, and too much typing for a first-time user: an address, a port, a fingerprint read off one screen and typed into another (#1275).

What must not change: a scan must never authorize a key by itself, the terminal stays the place a person approves, and nothing new is trusted because of where a connection comes from.

**No released app scans the code yet.**
The machine side ships here; the native app's scanner is being built against this ADR (packages/native).

## Decision

1. **The pairing link.** `remi pair` shows a QR of `remi://pair#` plus the base64url (no padding) of a JSON object with exactly these fields, in this order: `v` (1), `name`, `host`, `port`, `key`, `nonce`, `exp` and `proto`.
   - `name`: the machine's name, 1 to 64 Unicode code points (Swift: `unicodeScalars.count`), well-formed (no lone surrogate), with no control character, nothing `escapeUnsafeText` writes out (bidi, invisible and line-separator characters among them), and no `"` or `\`.
     So no character in a name needs a JSON escape.
   - `host`: an IPv4 address in dotted decimal; an IPv6 address in hexadecimal groups, without brackets, a zone or an IPv4 tail; or a DNS name whose labels are letters, digits and inner hyphens and whose last label is not all digits.
   - `port`: an integer from 1 to 65535.
   - `key`: the machine's Ed25519 public key, canonical standard base64 of the 32 bytes, the same text as `auth_challenge.serverPublicKey`.
   - `nonce`: 16 random bytes, canonical base64url without padding.
   - `exp`: Unix seconds, five minutes after the code was made.
   - `proto`: `PROTOCOL_VERSION` (ADR 0035).
   - **The canonical form** is the output of `JSON.stringify` on an object with those fields in that order: no whitespace, integers in plain decimal, strings with no escapes (the rules above leave nothing to escape). Then the UTF-8 bytes are encoded as base64url, with no padding and with zero trailing bits.
   - `packages/shared/src/pairing.ts` encodes and decodes it. Decoding is strict.
     - It accepts one canonical form: the bytes must re-encode to the same link, so padding, nonzero trailing bits, escapes, extra whitespace and other number spellings (`1.0`, `1e4`) are refused.
     - Every field is required. An unknown field, or a version other than 1, is refused by name.
     - The clocks may differ by two minutes: a code is expired once `exp` plus 120 seconds has passed, and refused as malformed when `exp` is more than seventeen minutes away.
     - A protocol version other than the client's is refused.
   - The vectors in `packages/shared/tests/fixtures/pairing/vectors.json` (valid links each with the key's fingerprint, and refusals each with its error) are generated deterministically, and every client, the Swift one included, must decode them the same way.
   - **The Swift payload merged before this ADR is superseded.**
     `PairingPayload.swift` (merged in #1277) reads `remi://pair?v=1&host=&port=&fingerprint=&iat=&exp=&nonce=`, and `MachineStore.swift` sends the nonce as a `pairing_nonce` query parameter on the WebSocket URL, which the daemon never reads.
     The format is the one above, and the nonce goes in `auth_response` (below). Aligning the app is #1283.
   - **What the link exposes.** A URL handler does not send the fragment to a server, but `remi://` is not an exclusive scheme on iOS: another installed app can register it and receive the link.
     That app learns what the QR shows anyone who sees it (the machine's address, its public key and a nonce valid for five minutes), which grants nothing by itself (below). The app is expected to scan in-app.
2. **What the phone does with it.**
   - It connects to `host:port` and, before it signs anything, checks that `auth_challenge.serverPublicKey` is the link's `key` (the whole key, not the 16-character fingerprint).
   - It answers the challenge as always, adding to `auth_response`:
     - `pairingNonce`: the link's `nonce`;
     - `pairingLabel`: the name the person gave the phone, held to the same rule as the machine's `name` (1 to 64 code points, plain text). Without one the key is labeled "paired device".
   - Neither field is signed: the signature covers the challenge, as before. The trust step is the person comparing fingerprints, below.
3. **What the machine does with it.** After the signature verifies, a key that is already authorized authenticates as before. An unknown key with a `pairingNonce` claims the pairing.
   - **Records.** Pairing records live beside the pending keys, under the same interprocess lock, and hold the nonce's SHA-256, never the nonce.
     - At most four are open at once. Each code expires five minutes after `remi pair` made it and is never extended.
     - The file holds at most sixteen records. At that cap, finished ones (decided, cancelled, or expired unclaimed) make room, oldest first. A record is dropped ten minutes after its code expires.
   - **The claim.** The first verified key to present a nonce claims it and is registered as pending (the same pending store #873 uses).
     - Four of the 32 pending slots are kept for pairing claims, so unknown keys filling the queue cannot keep a phone from claiming a code. Ordinary first connections get the other 28.
     - The same key presenting the code again is the same claim, and is pending again if its pending key expired.
   - **Refusals.** Each refusal has its own error, and none registers the key.
     - Any other key gets `PAIRING_USED`. It is counted on the record, with its fingerprint, for the terminal.
     - A nonce the machine never made gets `PAIRING_UNKNOWN`; one that expired, `PAIRING_EXPIRED`; one whose `remi pair` was cancelled, `PAIRING_CANCELLED`; one whose claim was rejected, `PAIRING_REJECTED`.
     - A nonce that is not 16 bytes, or a label that breaks the rule, is `PAIRING_MALFORMED`.
     - A full pending queue is `PENDING_QUEUE_FULL`, counted on the record while the code is open.
   - **The wait.** A claim waiting for the person holds the reply for up to 20 seconds, checking for a decision without taking the lock, so another process holding the lock cannot stall or fail it.
     - An approval in that time is answered with the ordinary success: the machine signs the challenge.
     - A rejection is answered `PAIRING_REJECTED`, a cancellation `PAIRING_CANCELLED`.
     - Otherwise, or as soon as the phone's connection closes, the answer is `PAIRING_PENDING`.
     - A phone retries after `PAIRING_PENDING`, so it learns of an approval at once and asks at most every 20 seconds while it waits.
     - `AUTH_STORE_ERROR` (a store the machine could not read) is also worth a retry.
   - **Logs.** The hub logs each claim attempt with the key's fingerprint and the outcome, never the nonce.
4. **The terminal.** `remi pair` checks its preconditions, shows the code, waits and asks.
   - **Preconditions.** Each refusal says what to do, and none makes a record.
     - It needs an interactive terminal; otherwise it exits 2 and points at `remi keys` and `remi authorize`.
     - It needs a running hub; it says to start one with `remi start`.
     - It needs authentication on.
     - It needs a bind a phone can reach. Loopback in any spelling is refused, and the message says how to set `daemon.bind`.
   - **The address.** For a wildcard bind it offers LAN addresses first, then Tailscale, then the rest, then virtual bridges (Docker and VM interfaces); link-local addresses are never offered.
     `--host` chooses one, but not a loopback or unspecified address. An IPv6 address is shown in brackets.
   - **Showing the code.** The host and name are checked before the record is made.
     It then prints the QR and a text fallback: the machine name, address, the machine's fingerprint, the expiry and the link. A terminal shorter than the QR gets a hint to enlarge the window.
   - **The question.** When a key claims the code, the terminal shows that key's fingerprint and the label the phone sent. It says to approve only if the phone shows the same fingerprint, and names other keys that tried the code, if any. Then it asks yes or no.
     - The answer is read only after the fingerprint is shown: anything typed while waiting (a stray `y`, a whole line) is read and dropped first.
     - **Yes** approves the fingerprint that was shown, with the label as the key's label, through `approvePairing`, which ends in the same commit `remi authorize` uses (resolve the exact pending key inside the lock, write the grant, then drop the candidate). If the key was authorized another way meanwhile, the terminal says so.
     - **No, or anything else** (an empty line, end of input) rejects: the claim is marked rejected and the pending key removed.
   - **Exit codes.**
     - While waiting, Ctrl-C, SIGTERM and SIGHUP cancel the code and exit 130, 143 and 129. A key that claimed the code stays an ordinary pending key, which `remi authorize` can still approve.
     - At the question, Ctrl-C or one of those signals rejects the phone and exits with the same code.
     - An expired code exits 1 and reports any claims a full queue refused. A run that ends any other way also cancels a code nobody decided.
5. **What the hub records for `remi pair`.** `daemon-status.json` gains the hub's `bind` and whether authentication is on, so `remi pair` can refuse a hub no phone could reach instead of showing a code that will not work.

## What the QR does and does not protect

- **What it does.** It saves typing and ties a pending key to one scan. It authorizes nothing: approval is still a person comparing fingerprints at the machine.
- **A photo of it.** It holds no private key, capability, relay credential or anything that admits a key.
  A photo of it lets someone try to claim the code within five minutes. That claim shows their key's fingerprint at the terminal, which does not match the phone's.
  The label is the claimant's own choice and can copy the phone's name; it proves nothing. Only the fingerprint is a check, which is why the terminal says to compare it.
- **Someone on the network.** The direct WebSocket is not encrypted by remi (ADR 0009): `pairingNonce` and the label travel in clear, as the rest of the session does.
  Someone on the network can see a nonce and race the phone to claim it. The single use, the five minutes and the fingerprint comparison are what stop that from becoming access.
  Use a trusted network, a VPN or an SSH tunnel.
- **Denial.** Anyone who sees the code can claim it first. The real phone then gets `PAIRING_USED`, and the terminal names the key that tried after the claim, so the person can answer no and run `remi pair` again.
  A host that can reach the hub can fill the 28 ordinary pending slots (the #873 exposure, reachable here because pairing needs a bind a phone can reach). The four kept slots leave claims room.
  A flood of claims could fill those too, and the terminal reports those refusals when the code expires. Denial costs a retry; it never grants access.
- **The relay.** Pairing does not enable or imply the relay.
  The relay adapter answers a challenge through the same `verifyResponse`, so a relay peer could present a nonce once a relay is enabled with an authenticator (`--permanent-code`). The same claim, fingerprint display and terminal approval apply.

## Consequences

- The phone's first connection needs one scan and one "y" at the terminal; the manual flow (`remi keys`, `remi authorize`) stays.
- `auth_result` gains error codes a client shows one by one.
- A new dependency, `uqr` (MIT, no dependencies of its own), draws the QR in the terminal; its notice ships in `THIRD_PARTY_NOTICES` like every bundled package (#1131).
- Four pending slots are no longer available to ordinary first connections (28 of 32).
