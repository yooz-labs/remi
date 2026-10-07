# ADR 0037: Pairing by QR, approved at the terminal

**Status:** accepted (#1275, milestone "Native apps (X3-X4)")
**Date:** 2026-10-07
**Owner:** Yahya

## Context

A phone reaches a machine directly (a LAN or VPN address, `daemon.bind` set, authentication on).
Since #873 an unknown client key is never trusted on first use: the daemon verifies the client's signature, stores the key as pending for ten minutes, and the person approves it with `remi authorize <fingerprint>` after comparing fingerprints.
That is the right trust step, and too much typing for a first-time user: an address, a port, a fingerprint read off one screen and typed into another (#1275).

What must not change: a scan must never authorize a key by itself, the terminal stays the place a person approves, and nothing new is trusted because of where a connection comes from.

## Decision

1. **The pairing link.** `remi pair` shows a QR of `remi://pair#` plus the base64url (no padding) of a compact JSON object with exactly these fields, in this order: `v` (1), `name` (the machine's name, 1 to 64 characters, nothing `escapeUnsafeText` writes out), `host` (IPv4, IPv6 without brackets or zone, or a DNS name), `port`, `key` (the machine's Ed25519 public key, standard base64, the same text as `auth_challenge.serverPublicKey`), `nonce` (16 random bytes, base64url), `exp` (Unix seconds, five minutes after it is made) and `proto` (`PROTOCOL_VERSION`, ADR 0035).
   - `packages/shared/src/pairing.ts` encodes and decodes it. Decoding is strict: one canonical form (the bytes must re-encode to the same link), every field required, an unknown field or a version other than 1 refused by name, a two-minute allowance between the clocks, and a protocol version other than the client's refused.
   - The vectors in `packages/shared/tests/fixtures/pairing/vectors.json` (valid links, and refusals each with its error) are generated deterministically and are what every client, the Swift one included, must decode the same way.
   - The fragment is never sent anywhere by a URL handler, so a link opened by the phone's camera reaches only the app.
2. **What the phone does with it.** It connects to `host:port`, and before it signs anything it checks that `auth_challenge.serverPublicKey` is the link's `key` (the whole key, not the 16-character fingerprint). It answers the challenge as always, adding `pairingNonce` (the link's `nonce`) and `pairingLabel` (the name the person gave the phone, at most 64 characters) to `auth_response`. Neither is signed: the signature covers the challenge, as before. The trust step is the person comparing fingerprints, below.
3. **What the machine does with it.** After the signature verifies, a key that is already authorized authenticates as before. An unknown key with a `pairingNonce` claims the pairing:
   - pairing records live beside the pending keys, under the same interprocess lock, and hold the nonce's SHA-256, never the nonce; at most four are open; each expires five minutes after `remi pair` made it, and is never extended;
   - the first verified key to present a nonce claims it, and is registered as pending (the same pending store #873 uses). The same key presenting it again is the same claim. Any other key gets `PAIRING_USED`. A nonce the machine never made, one that expired, one whose `remi pair` was cancelled and one whose claim was rejected each get their own error (`PAIRING_UNKNOWN`, `PAIRING_EXPIRED`, `PAIRING_CANCELLED`, `PAIRING_REJECTED`); a nonce that is not 16 bytes is `PAIRING_MALFORMED`. None of these registers the key;
   - a claim that is still waiting for the person holds the reply for up to 20 seconds, checking for a decision: an approval in that time is answered with the ordinary success (the machine signs the challenge), a rejection with `PAIRING_REJECTED`, and otherwise `PAIRING_PENDING`. A phone retries after `PAIRING_PENDING`, so it learns of an approval at once and asks at most every 20 seconds while it waits.
4. **The terminal.** `remi pair` needs an interactive terminal (otherwise it says so and points at `remi keys` and `remi authorize`), a running hub (it offers to start one), authentication on, and a bind a phone can reach (not loopback; it says how to set `daemon.bind`). It picks the address to show (`--host` chooses one), makes the pairing record, prints the QR and a text fallback (machine name, address, the machine's fingerprint, the expiry and the link), and waits.
   When a key claims the code it shows that key's fingerprint and the label the phone sent, says to compare the fingerprint with the one on the phone, and asks yes or no.
   Yes approves through `authorizePendingKey`, the one path `remi authorize` uses, with the label as the key's label. No rejects: the claim is marked rejected and the pending key removed. Expiry or Ctrl-C cancels the record; a key that had claimed it stays an ordinary pending key, which `remi authorize` can still approve.
5. **What the hub records for `remi pair`.** `daemon-status.json` gains the hub's `bind` and whether authentication is on, so `remi pair` can refuse a hub no phone could reach instead of showing a code that will not work.

## What the QR does and does not protect

- It saves typing and ties a pending key to one scan. It authorizes nothing: approval is still a person comparing fingerprints at the machine.
- It holds no private key, capability, relay credential or anything that admits a key. A photo of it lets someone try to claim the code within five minutes; the claim shows that someone's fingerprint and label at the terminal, which do not match the phone's.
- The direct WebSocket is not encrypted by remi (ADR 0009): `pairingNonce` and the label travel in clear, as the rest of the session does. Someone on the network can see a nonce and race the phone to claim it; the single use, the five minutes and the fingerprint comparison are what stop that from becoming access. Use a trusted network, a VPN or an SSH tunnel.
- It has nothing to do with the relay: no relay is enabled or implied.

## Consequences

- The phone's first connection needs one scan and one "y" at the terminal; the manual flow (`remi keys`, `remi authorize`) stays.
- `auth_result` gains error codes a client shows one by one.
- A new dependency, `uqr` (MIT, no dependencies of its own), draws the QR in the terminal; its notice ships in `THIRD_PARTY_NOTICES` like every bundled package (#1131).
