# Remi reference: transport, authentication and pairing

Moved verbatim out of `AGENTS.md` to keep it under the instruction-size limit; `AGENTS.md` keeps the summary and the standing invariants. Repository-root links are prefixed with `../../` so they resolve from this file.

## Transport Options

| Method | When to use |
|---|---|
| Direct connection | Default WS over a private network/tunnel, or optional HTTPS/WSS ([setup](../../docs/DIRECT-TLS.md)) |
| Signaling relay | V2 hub daemon and web client in source, off by default; deployed/signed R7 acceptance pending |

**Direct connection now requires setting `daemon.bind` (#880).** The default is
`127.0.0.1`, so a stock daemon accepts only loopback: SSH tunnels work with
the default WS listener, but **LAN direct, Tailscale direct (100.x) and mDNS
discovery all stop** until the user opts in. mDNS does not even advertise on a
loopback bind (`cli.ts` skips the publisher), so the daemon does not fail — it
disappears, which is the confusing half.

Optional `[daemon.tls]` configures the public listener with certificate/key PEM
files, resolved relative to the config file. Startup fails without plaintext
fallback if the configured material or required local capability is unavailable.
All three adapter construction paths share that loaded TLS policy. Local CLI and
relay-child clients resolve the same home's capability-protected loopback control
endpoint; public status/list/registry ports stay public. Off-machine CLI targets
receive no local capability. Legacy mDNS is suppressed and direct v1 pairing
refuses a verified same-PID TLS endpoint; native endpoint/secure QR and remote CLI WSS
adoption remain pending. A tunnel to the TLS public port still needs a WSS-capable
client. Browser discovery/reconnect preserves an existing WSS URL and its actual
certificate hostname; it never changes that connection to WS.

Do NOT recommend `tailscale serve` as the workaround. It is a same-host reverse
proxy, so every tailnet peer arrives as `127.0.0.1` and loses its actual
peer address. #873 requires identity or a real local capability even on loopback;
keep the documented direct setup. Recommend an SSH tunnel, or an explicit `bind` plus
`--auth`.

**The v2 relay daemon is hub-owned and off by default (R3, #1198).**
`remi serve --relay` or `network.relay = true` opts the hub in; `--no-relay` wins.
Authentication must remain enabled. Session daemons do not register a relay.
`HubRelay` owns Worker control, encrypted machine channels and capability-verified
child proxies. `remi pair --relay` uses a real loopback capability endpoint and local TTY
confirmation of the exact client fingerprint; no remote endpoint creates or
confirms offers. `remi devices` lists/revokes enrollment; encrypted enrolled clients
can also list/revoke, but cannot approve anyone or learn the local capability.
Raw PTY frames are refused at registry, hub and child-proxy boundaries. Semantic
answers return correlated actual child outcomes, and child discovery is aggregated
by the hub without exposing child endpoints. See [the caller map and limits](../../docs/relay-daemon-v2.md).
An orderly close leaves the pipe open after the hub's BYE, at most 2 s, for the client to close it
(#1225): on the Bun 1.3.11 pin the hub's own close can reset the connection, and a reset right after
the BYE could lose it. A client that does not close in time gets the hub's close, which on 1.3.11
can still arrive as the Worker's failure close (4400) after an intact BYE; the stream verdict, from
the authenticated BYE, is what counts (measured on macOS only, `docs/relay-daemon-v2.md`). During
the wait the hub opens each binary frame the peer sends: the reply BYE ends the stream clean, a data
frame is dropped and nothing is acted on, and a frame that fails to open ends the wait with the
failure close (4400).
The old `RelayAdapter`, signaling code client and permanent code store are removed;
`remi code` and `--permanent-code` refuse with migration guidance. The `kexSigningInput` compatibility encoding/export/fixtures remain unchanged;
its legacy Authenticator methods have no current production callers. Direct
Connection auth uses `createChallenge`/`verifyResponse`; detached direct `/answer` remains.
This relay branch includes the web relay client (`App` → `ConnectModal` →
`RelayPairingForm`), sealed secure-push sender and signed native-answer daemon
contracts. `cli.ts` builds `SecurePushService` and `NativeAnswerLedger`; question,
turn and harness-denied notifications call the secure sender, and
`SecurePushTransport` seals the content before `/v2/push/<rid>`. The web app wires
`SecurePushSubscriptions`. Swift background and Watch answers (#1242/#1201),
deployed Worker, signed hardware acceptance and the R7 gate remain unfinished.
Legacy plaintext `/push` is a separate path; the semantic channel does not protect it.

**The Worker in this repository is v2 (R2, #1197), and it is not deployed.**
It is one Durable Object per machine, named by the room id (the hash of the machine's public key), with no time-to-live: a socket is admitted by a signature over a Worker-issued nonce (the host by the machine key, a client by an enrolled device key or a single-use pairing ticket) before anything else happens, the enrolled set changes only on the host's `enroll` and `revoke`, and a client and the host's pipe are then paired and every message is forwarded unparsed.
Its rate limits go through one global Durable Object (`GlobalLimiter`), and its numbers are unmeasured defaults.
What it sees and what it does not, its routes and messages, its limits and the known gaps are in `docs/relay-worker-v2.md`; the deploy steps for the owner are in `docs/relay-worker-deploy-runbook.md`.
`/connect/<code>` and `/answer/<code>` are deleted. R3 tests construct the real source hub and capability-verified controlled children against this Worker; shipped R4 clients and deployed acceptance remain pending.
Those tests run the real Durable Object in workerd under Miniflare (`bun test packages/signaling`); that is not the deployed Cloudflare runtime, and the hibernation threshold, alarm precision and billing there are unverified.
The legacy `POST /push` stays on by default on the Worker (only `LEGACY_PUSH_ENABLED` set to a false value turns it off) and behind the push secret, until the R7 gate flips the daemon's default; the sealed `POST /v2/push/<rid>` route (R5) sits beside it and needs both the machine signature and that bearer secret.

**Authentication and local first-connect approval (#873).**
`auth.enabled = "auto"` now enables authentication on every bind. Unknown keys
never become trusted automatically: `Authenticator.verifyResponse` verifies a
one-time challenge, canonical Ed25519 public key and derived fingerprint before
storing an unsuccessful `UNKNOWN_KEY` candidate. Candidates hold only the public
key, derived fingerprint and first-seen/expiry timestamps (32 keys, four kept for pairing claims (#1275), ten minutes,
no retry extension). `remi keys` shows pending and authorized public keys;
compare the client's fingerprint and run `remi authorize <exact-fingerprint>
--label phone` on the daemon machine, then retry with a fresh challenge.
Explicit JSON/file authorization is still available; share only
`remi export-key --public-only` output. Detached signed `/answer` requests use
already authorized keys and never create candidates.
`require_local_auth` has been removed; old values are ignored with a visible
retirement notice. `--no-tofu` is accepted with a retirement notice and changes
no trust behavior. Explicit `--no-auth` or `auth.enabled = false` still disables
auth with a warning. A valid daemon capability over actual TCP loopback is the
other admitted path; bare loopback clients are challenged. Pending/authorized
mutations share an interprocess lock and atomic restricted files; approval
persists the grant before deleting its candidate. Physical signed iPhone and
signed sandboxed macOS acceptance remain unverified owner hardware gates.

**Pairing by QR (#1275, [ADR 0037](../../.context/decisions/0037-pairing-by-qr-with-terminal-approval.md)).**
No released app scans the code yet. Native source preserves the whole decoded v1/v2 payload from the scanner or Pairing code form through `AddMachineRequest` to `MachineStore.beginPairing` (#1574). Its memory-only coordinator tries permitted Local candidates before Tailscale, advances only after transport reachability failure, and keeps approval/store/queue retries on the same candidate. Only authenticated Hello admits the same socket and persists full-key-pinned address hints; nonce and label are sent in `auth_response`, never in the WebSocket URL, and cleared before adoption. Compatible native distribution and signed phone acceptance remain pending.
`remi pair` (`cli/cmd-pair.ts`) shows a `remi://pair#` link as a QR and text. V1 keeps its exact single-host field order and remains the default. Opt-in v2 has the exact `v,name,hosts,port,key,nonce,exp,proto` order, one to four hosts, the same machine key/nonce/expiry/protocol across candidates, a 2048-character link and 1527-byte decoded-JSON limit; its strict codec rejects duplicate normalized targets and loopback, unspecified and link-local candidates. Both versions are encoded and strictly decoded by `packages/shared/src/pairing.ts` against the shared vectors; protocol version stays 1.
It needs an interactive terminal and a running hub with authentication on and a bind that is not loopback (in any spelling, a trailing dot included) or link-local, which the hub records in `daemon-status.json` (`bind`, `auth`); for a wildcard bind it offers LAN addresses, then Tailscale, then the rest, then virtual bridges, never link-local (`--host` chooses, never loopback, unspecified or link-local).
V2 remains opt-in until a compatible native app is distributed, and `--qr-version` cannot be combined with `--relay`. Candidate discovery uses only eligible interfaces on the listener's actual family; a specific bind and explicit `--host` each yield one candidate. A wildcard reserves the first Local and first Tailscale candidate when both exist, fills to four, then emits all Local candidates before Tailscale candidates with stable order within each layer. `100.64.0.0/10`, `fd7a:115c:a1e0::/48` and `.ts.net` are Tailscale scheduling hints; every other permitted direct candidate is Local. These addresses remain hints, not trust or enrollment.
The phone checks `auth_challenge.serverPublicKey` against the link's key before it signs, and sends `pairingNonce` and `pairingLabel` in `auth_response` (not signed: the trust step is the fingerprint comparison; the label is the phone's own choice and proves nothing).
After the signature verifies, `Authenticator.verifyPairing` claims the code through `IdentityStore.claimPairing`: the first verified key claims it and is registered as pending in the same transaction, in one of four pending slots kept for claims if the 28 ordinary ones are full; records hold the nonce's SHA-256, at most four are open, at most sixteen are kept (finished ones make room), and each is single use. An unknown, expired, used, cancelled or rejected code, or a malformed code or label, gets its own `auth_result` error and registers nothing; another key presenting a claimed code is counted with its fingerprint, and a refusal for a full queue is counted, for the terminal. Claim attempts are logged with the key's fingerprint and outcome, never the nonce, at most once a minute per key and outcome; the counts stop at 999 and a repeat at the cap writes nothing.
A claimed code is held up to 20 s for the decision, read through the lock-free `peekPairing` so another process holding the store lock neither stalls nor fails it, and the wait ends when the connection closes (`verifyResponse`'s `isOpen`, passed by `connection.ts`). Approval answers with the ordinary success, rejection or cancellation with its error, no decision `PAIRING_PENDING`, after which the phone retries.
At the terminal the person sees the phone's fingerprint and label, a warning naming any other key that tried the code, and the question; keys typed before the question are drained in raw mode and dropped. Approving takes the first four characters of the phone's fingerprint, never a `y` (they cannot be typed ahead, and typing them means reading it), and goes through `approvePairing(nonce, shownFingerprint)`, which shares one commit with `remi authorize` (`commitAuthorizationInsideTransaction`); anything else rejects and removes the pending key. While waiting, Ctrl-C, SIGTERM and SIGHUP cancel the code (exit 130, 143, 129; a key that claimed it stays an ordinary pending key); at the question Ctrl-C and SIGTERM reject (130, 143), and a closed terminal rejects with 1 or 129.
The code authorizes nothing by itself; the direct WebSocket stays unencrypted by remi, so the nonce and label travel in clear like the rest of the session, and the single use and the fingerprint comparison are what stop a sniffed code from becoming access.

**Provisioning a client key (#1303, [docs/PROVISIONING.md](../../docs/PROVISIONING.md)).**
Approving a pending key, importing a public-only JSON (`remi authorize '{"publicKey":"<canonical base64>"}' --label <name>`, inline or as a file; other fields are ignored and the fingerprint is always derived from the key) and a pairing approval all end in the same `authorized_keys.json` record, the label naming the client and never the host.
A grant belongs to a remi home (`$HOME/.remi` of the process, or `REMI_HOME`): the hub, every session daemon it starts, wrappers and the CLI share one store (writes take one interprocess lock, reads none), and `isAuthorized` reads the file on every authentication, so a grant or removal applies to the next fresh authentication at all of them with no restart (`tests/integration/key-provisioning.test.ts` runs a real hub, a child it starts and the real CLI to show it, for importing before the hub has ever run, approving, a different key under the same label, removal, rotation, and one identity on two machines).
An unknown key is refused `UNKNOWN_KEY` with the connection closed and kept pending ten minutes from its first sighting (a retry neither extends nor duplicates it); the app builds `remi authorize <fingerprint> --label '<label>'` itself (it knows its fingerprint and the label), retries on a fresh connection, and the machine does not push an approval.
Removal (`remi authorize --remove <fingerprint>`) refuses the key's next authentication and leaves it pending again. An authenticated direct connection rereads its exact key/fingerprint grant before incoming domain dispatch and at its existing ping tick (#1305); a removed or unreadable grant closes through the existing `CLOSING`/disconnect path. Connected silent peers close at the next tick (30 seconds by default, plus scheduling delay); peers awaiting hello retain the existing handshake deadline. Local capability admission and hub-owned relay authority keep their own gates. Signed `/answer` requests check the grant on each request.
Importing an already authorized key exits 1 with "already authorized", which a bootstrap script must expect (the script in the docs is run from the file by the test).
`remi authorize` accepts JSON objects with a string `publicKey`, derives the fingerprint, ignores harmless metadata, and refuses any own `encryptedPrivateKey`, `salt`, `iv` or `iterations` property before writing a grant, even when its value is null (#1320). Malformed JSON errors are content-free. Add-mode labels are validated as 1–64 well-formed Unicode code points with visible text, no leading ASCII hyphen, no C0/C1 controls and no other `escapeUnsafeText` characters; quotes and backslashes remain allowed. Labels are stored without normalization, while `remi keys` displays a bounded, safely escaped preview and preserves legacy records (#1321). The native `PublicClientIdentity.authorizeCommand` validation remains outside this daemon change.
The machine fingerprint in `auth_challenge` is announced and unproven for a refused client (the machine signs only for a key it admits); a person reads the real one in the hub's startup line, `remi pair` or `remi export-key --public-only`.

**There is no WebRTC.** No `RTCPeerConnection` or data channel exists here.
The historical v1 design intended WebRTC after signaling but never built it
(#543). The current v2 relay is a WebSocket ciphertext courier, implemented
on the daemon side by R3. Descriptions of peer-to-peer DTLS or TURN do not
describe this source.
