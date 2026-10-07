# V2 relay daemon (R3, #1198)

This source implements the machine-owned relay daemon. It is off by default and
runs only in the session-less hub. R4 web/native client integration, R5/R6 push
privacy, deployment and owner hardware acceptance are separate gates. This is
not a claim that a released phone app or the deployed Worker supports this path.
R5 adds signed, sealed push content through `/v2/push/<rid>`; native verification
and the background answer path still have separate acceptance gates. The daemon
builds the sealed-push sender only with a push secret (`--push-secret` or
`REMI_PUSH_SECRET`; a hub hands it to the session daemons it spawns through their
environment), which it sends as the Worker's bearer; without one the hub answers
`secure_push_register_request` with `UNSUPPORTED`. Plaintext `/push` stays on by
default (`notifications.legacy_push_enabled = true`) until the R7 gate, and still
needs a push secret. A durable, machine-wide activation latch retires it the first
time any device enrolls over the relay: from then on the machine sends no plaintext
push to any device, directly connected phones included (#1200). Direct transport
behavior remains separate.

## Opt-in and local authority

Run `remi serve --relay`, or set `[network] relay = true` for the hub.
`--no-relay` wins. Authentication must remain enabled; session daemons do not
register with the Worker. The default `signaling_url` is the Worker origin,
`wss://remi-signaling.yooz.workers.dev`, with v2 routes appended by `relay-url.ts`.
The recognized official old `/connect` URL (with or without a trailing slash)
refuses startup with explicit configuration guidance. User TOML is never rewritten.
Custom proxy prefixes retain their meaning for the interactive WebSocket relay.
Secure push accepts only an HTTPS or WSS root origin with an optional root slash;
it refuses credentials, a path prefix, query or fragment with a fixed startup
notice. It creates no secure-push service in that case and never posts to a
guessed root route. Supporting proxy-prefixed push needs an explicit deployment
route; the signed canonical path remains `/v2/push/<rid>` (#1200).

`remi pair` requires a local interactive terminal. Its private control connection
requires both actual TCP loopback and the daemon capability; forwarded headers or
bare loopback are insufficient. It displays the token as text and a QR, then asks
for exact client fingerprint confirmation, defaulting to refusal. A remote peer
cannot create or confirm an offer. Eight offers may wait, each for at most ten
minutes. Authentication snapshots their order, consumes a selected secret once,
and holds confirmation for at most two minutes. Disconnect, expiry or refusal
cancels the offer and pending effects. Production rejects injected randomness or
an ephemeral-key test hook.

Enrollment is persisted before Worker enrollment acknowledgment and encrypted
`ready`. Existing direct authorization remains separate: a direct grant alone
never enrolls a relay device. Authorized/device store mutations share the existing
interprocess file lock; atomic restricted files are synced and replaced. The
commit guard is checked inside the lock, so cancellation cannot grant a key after
an asynchronous preparation step. Corrupt storage refuses visibly.

`remi devices` lists public device identity metadata; `remi devices revoke
<fingerprint>` removes local authorization and requests Worker removal. An
`edgeAcknowledged` result means the actual current Worker generation acknowledged
that removal. Reconnect enrollment and revocation share serialization and recheck
durable state, so an old reconnect snapshot cannot undo that result. External
`remi authorize --remove` also invalidates outbound peers before sending, including
frames waiting for encryption. An enrolled encrypted peer can list/revoke devices,
but cannot enroll, approve offers or obtain the local capability. Self-revocation
may disconnect before its reply; that edge outcome is unverified to the client.

## Actual session and answer path

`cli.ts` creates `HubRelay`; `HubRelay` owns `WorkerControl`, a machine `Connection`,
and `ChildProxy`. Daemon/shared never import signaling implementation. Root
integration tests construct the real source hub and real local R2 Worker.

After encrypted machine `hello`, session discovery aggregates the actual hub
history and capability-verified child semantic responses. A query has one active
aggregate per peer, a total five-second deadline and at most 32 children queried
in batches of eight. Failed children produce `CHILD_LIST_PARTIAL`; the hub neither
fabricates live state nor exposes raw child endpoints. Queries do not block answer
processing. A targeted `hello` can attach to a registered child session.

Every proxy binds the registry's immutable session id, pid, port and start time,
checks the child's actual `hello_ack`, and rechecks current authority after waits
and immediately before sending. Stale socket frames and close effects cannot act
on a replacement generation. Raw PTY is refused by the adapter registry, hub and
child proxy. Direct terminal transport retains its own raw-output behavior.

An `answer_result` carries `requestId`, `sessionId`, `questionId` and the actual
handler outcome: `delivered`, `session-not-found`, `stale-binding`, `stale`,
`uncertain`, `conflict` or `busy`. Receipt ACK is not delivery. The child has a
ten-second result deadline; no result means uncertain, never a guessed decision.
Exact concurrent duplicates apply once. Content identity is a constant-size SHA256
hash of the exact tuple including child generation, not retained plaintext.
There are at most 32 in-flight and 256 completed results per peer connection;
completed records expire after ten minutes. This in-memory cache resets on
reconnect and is not durable per-device deduplication. Eviction or reconnect does
not justify replaying an answer.

Actual answer/user-input handlers log metadata and lengths, not choices, free
text, labels or answer messages. Semantic payloads larger than `MAX_PLAINTEXT`
(524288 bytes) and a full 64-message send queue refuse visibly. A missing history
entry cannot be followed by a false successful completion, and refusal has no raw
fallback or read-half shutdown. Transport frame byte limits apply before queued
crypto; the inbound wrapper also has a 64-frame count bound.

Worker command ACKs are serial and generation-bound. Unexpected, malformed or
late ACKs and the ten-second deadline poison that control generation. Encrypted
ready channels refuse all text. Authenticated BYE is orderly; transport close
drains the wrapper receive queue before the channel verdict while suppressing
post-close application effects. The Worker's control `gone` notice is emitted
only for pending peers; ready disconnect closes the pipe, which owns its drain.

On Bun 1.3.11, the CI and release pin, the hub's WebSocket client close usually
resets the connection instead of waiting for the Worker's Close reply (#1225). A
Worker that gets to the socket late, as on a loaded machine, then records the close
as abnormal (1006) and can lose what it had not read yet: the Close frame, and the
hub's BYE when the close came right after it (7 of 102 loaded runs before the change
below, where the client then read `unclean`). So an orderly close does not close at
once: after its BYE the hub waits, at most 2 s (`ORDERLY_CLOSE_GRACE_MS`), for the far
side to close the pipe. The web client closes as soon as it has the hub's BYE, so the
Worker ends the pipe and nothing is reset. A peer that does not close within 2 s gets
the hub's own close, which on 1.3.11 can still be reset: that client then gets the
Worker's failure close (4400, `closed`) instead of 1000, though the BYE, read long
before, still arrives (195 loaded runs on 1.3.11 on 2026-10-07, 51 of them with that
reset). The full 2 s is spent only when the far side does not close: on `stop()` (it
awaits every pipe still in its grace), on a revocation made outside the hub (the
authorized keys edited, caught at the pipe's next send) and with a client that ignores
the BYE. A revoke through the hub also tells the Worker, which drops the client's
socket at the edge and the pipe with it, so that wait ends early. While the hub waits,
it opens each binary frame the peer sends: the reply BYE ends the stream clean, a data
frame is dropped, and nothing is acted on; a frame that fails to open fails the
channel, which ends the wait with the failure close (4400).
`stop()` forgets the Worker control before closing it, since on 1.3.11 the control's
close handler runs inside the close and would otherwise fail every pipe first. The
hub's shutdown runs its push drain (2 s at most, #1223) beside the relay's stop, so
the two together stay well inside the 5 s after which `remi stop` kills the hub. A
failure close stays immediate and carries no BYE; on 1.3.11 the client may
get the Worker's `closed` reason instead of the hub's empty one, the same failure close
either way. The client's verdict comes from the authenticated BYE, not from the close
code; the web client reports that verdict and does not read the code. Each pipe close
is logged in a fixed form with no connection id (`Relay pipe closed by the hub (1000)`,
or `by the far side`). Measured on macOS against the local workerd, where
`relay-r3-transport-close.test.ts` pins the runtime's behavior (Bun 1.4.2 closes
gracefully); not measured on Linux or against the deployed Worker.

## Retirement and verification

V1 `RelayAdapter`, signaling client, code store and `remi code` implementation are
removed. Permanent-code requests refuse with migration guidance. The `kexSigningInput` compatibility encoding, export and cross-purpose signature
fixtures remain unchanged. Its legacy `createChallengeWithRelayKex` and
`verifyRelayKex` methods have no current production callers; direct Connection
auth uses `createChallenge` and `verifyResponse`. Detached signed direct `/answer`
remains authorized-only; this phase does not implement encrypted offline answers.

Focused tests live in `tests/integration/relay-r3*.test.ts` and
`packages/daemon/tests/answer-results.test.ts`. They use private 0700 HOME/state,
controlled harness executables and owned local Worker processes. No installed
model, user identity, deployment or external credential is used. Run:

```sh
bun test tests/integration/relay-r3*.test.ts packages/daemon/tests/answer-results.test.ts
bun run typecheck
bun run typecheck:web
bun run typecheck:web-tests
bun run typecheck:signaling
node_modules/.bin/tsc -p tests/integration/tsconfig.relay-r3.json
```

The wall-clock source-hub/real-Worker probes are opt-in and skipped in the default
suite. They use unchanged production timers; run each explicitly (about 30 seconds,
two minutes and ten minutes respectively):

```sh
REMI_R3_CLOCK_GATE=half-open bun test tests/integration/relay-r3-clock.test.ts
REMI_R3_CLOCK_GATE=confirmation bun test tests/integration/relay-r3-clock.test.ts
REMI_R3_CLOCK_GATE=offers bun test tests/integration/relay-r3-clock.test.ts
```

The scoped integration typecheck is also an ordinary step in the existing CI
Type Check job. Its main/develop branch filter is unchanged: an epic-target phase
PR has local gate receipts, while the final develop PR runs Linux CI. Full suite
and soak receipts are maintained by the integration owner at the tested immutable
head; focused results do not substitute for them. Real device/WebView, signed
sandboxed macOS, deployed Worker behavior and end-to-end R7 acceptance remain
unverified here.
