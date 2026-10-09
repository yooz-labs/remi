# Native relay X2: foreground milestone (#1242)

This milestone adds an opt-in relay v2 connection to the Swift Mac and Phone
clients. It covers foreground pairing, reconnecting with a saved public machine
pin, session discovery, semantic session requests, permission cards, and the
existing `answer` / `answer_result` path. Issues #1242 and #1201 remain open.

## Production callers and trust

Both add-machine screens accept a token created by `remi pair --relay` on a
relay-enabled machine. The direct pairing command remains `remi pair`.
`MachineEndpoint.pairingOverRelay` validates the token, and `MachineStore` passes
its one-use secret separately to `RemiConnection`. Public machine state and map
keys contain only the relay route and machine public key. An unconfirmed pin is
excluded from configuration persistence. Only authenticated READY confirms it.

`RemiConnection` signs the Worker's admission challenge, verifies the pinned
machine's handshake signature before signing the device proof, and opens READY
before sending the existing application Hello. Pair and resume use the ADR 0034
transcript, HKDF labels, directional AES-GCM keys, counters, and authenticated
BYE. There is no plaintext fallback. Admission and resume are bounded at 30
seconds, pairing confirmation at 120 seconds and the token expiry, and closing
BYE emission at one second. Network retries after enrollment are bounded at five
attempts. Local size and reserved-counter refusals leave the receive direction
usable; encryption or emission failure terminates the channel.

Store callbacks carry a connection generation. Replacing an equal endpoint or
stopping the Store invalidates that generation before asynchronous actor cleanup,
so an old READY cannot persist a replacement attempt. The actor releases its
pairing secret after READY and on connection cleanup; Swift Data and CryptoKit
provide no guarantee that every old memory copy has been overwritten.

Session requests use the aggregate hub relay and include the existing session
id. The client never dials advertised child ports for a relay machine. Foreground
answers remain correlated until `answer_result`, with a bounded pending table
and 15-second deadline. An unclean ending or uncertain outcome asks the person to
check the session. A delivered result means the daemon accepted the choice; it
does not prove that a real harness executed a tool.

Stored-session Resume is disabled for relay machines with an explicit message.
The current relay hub routes `resume_session_request.sessionId` through its live
child registry, which cannot resolve an exited session. Direct Resume remains
supported. Fixing that backend route is a separate change.

## Contracts and oracle

The reviewed TypeScript relay contracts originated on epic #1195, outside
develop. The canonical golden oracle is copied byte-for-byte from `8fb5b88b` at
`packages/shared/tests/fixtures/relay-v2/vectors.json`; its adjacent provenance
README records SHA-256
`d64d48636c97f4ac4064b46bc08f39a1b7c16181d1d224ba7790dececbd21084`.
Ordinary `swift test` reads that local file and fails if it is absent.

Applicable golden cases exercised by `RelayClientTests`:

| Group | Coverage |
| --- | --- |
| Positive pair and resume | Both client handshakes, device proof verification, exact Hello/fingerprint, 40 directional DATA frames and four BYE frames |
| `control_decode` | 9 cases: hello_ack, ready, and auth codec cases |
| `hello_ack_verify` / `ready_open` | All 21 cases |
| `ec_point` / `frame_length` | All 17 cases, including exact refusal codes |
| `data_sequence` | All 41 cases, accepted-frame counts and exact refusal codes |
| `token_decode` | All 34 cases, exact refusal codes and public-only pin persistence |

That is 122 of the 206 negative/boundary cases. The remaining 84 are explicitly
deferred: 36 host-side Hello decode cases, six host auth-open cases, 21 host
auth-policy cases, 11 sealed push opening cases, and ten admission-verification
cases for the Worker. Native client admission is exercised positively against
the actual Worker; this milestone does not implement a host or a Worker.
Secure-push and native-answer vector files are not imported or claimed.

The original source pin advertises `workspaces` but lacks develop's
`recent_repositories_request` registry and handler. Actual native interop exposed
that mismatch: DATA decrypted successfully, then source `deserialize` returned
null for the request. The separately maintained contract-sync composite
`fe52daf7` combines existing relay `8fb5b88b` and develop `1d800273`, preserving
both protocols and selecting relay pairing with `--relay`. The native branch
does not merge or rewrite that backend. Both source bases must be ancestors of
the checkout used for the interop gate.

## Local receipts (2026-10-08)

The unsigned package and app gates pass:

```sh
swift test --package-path packages/native/RemiKit
xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiMac \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build test
xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiPhone \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

Swift Testing reports 60 passes and one explicit source-interop skip in the
ordinary package and Mac runs. The inherited direct `RealHubIntegrationTests`
returns early without its own environment; that reported pass is not a new
direct-hub runtime receipt. The separate relay source gate passes 1/1:

```sh
REMI_RELAY_REFERENCE_ROOT=/path/to/relay-contract-sync \
  swift test --package-path packages/native/RemiKit \
  --filter RelaySourceIntegrationTests
```

It constructs the actual Swift Store and connection, runs the actual source CLI
hub and hub-spawned child through the real workerd Durable Object, confirms the
same pairing fingerprint, restores a persisted public pin without a ticket,
receives a real held PermissionRequest card, sends semantic No, observes the
hook's deny response, and receives the correlated delivered result and card
resolution. An inert owned CLI process keeps the PTY alive, as in the existing
R6 source tests; no real Claude or Codex service is used. The transport control
also refuses an oversized local send, then serves a valid list request, receives
authenticated BYE during orderly hub restart, and resumes through a fresh Worker
admission on the same native actor. The fixture stops each Store before starting
another channel with the same device key. It waits for its owned hub and child
processes before deleting scratch state. Concurrent cleanup calls share one promise.

Thirteen semantic mutations were detected: signature, KDF, READY echo,
canonical control, incoming direction, counter limit, expiry boundary, route
policy, stale generation, retained PSK, reserved BYE counter, connection cleanup,
and fatal treatment of local refusal. The last two use the actual source
interop test. A narrower mutation removing only the whole-regex-match guard was
equivalent for the tested newline inputs because URLComponents independently
rejects them; weakening the route policy was detected. All mutations were
restored before the final gates.

Receipt files on the implementation machine are:

- `/private/tmp/remi-x2-swift-final.log`
- `/private/tmp/remi-x2-mac-final.log`
- `/private/tmp/remi-x2-phone-final.log`
- `/private/tmp/remi-x2-interop-final.log`
- `/private/tmp/remi-x2-mutations.json` and the named mutant logs

The only final build warning is the existing AppIntents metadata extraction
notice. No new source diagnostics were reported.

Rendered QA uses isolated view harnesses with no owner Keychain or configuration.
The Mac harness uses the actual add-machine view and exercises opt-in and invalid
token submission. The Phone harness uses the actual view layout with preview
state seeded for error and confirmation. The command, masked token, comparison
text and error wrap without clipping at the captured viewports. These are layout
receipts, not signed full-app or physical-device acceptance. The unsigned Phone
app itself reaches the existing Keychain entitlement error on a fresh simulator.

## Remaining X2 and #1201 gates

The next tranche must adapt the existing reviewed secure-push codec, protected
state, keychain storage and registration from the relay epic's NativePush work.
It needs the native app and notification extension's shared access group and
file-protection policy, verified secure-push context and replay/rollback bounds,
and the exact detached `native_answer` signing and source acceptance path.
Foreground question cards do not carry the secure-push runtime instance, content
digest or collapse authority, so this milestone does not forge those fields.

No new relay notification action, background answer, lock-screen category, Watch
answer, attachment UI, push registration or sealed-file transport is enabled.
Notification categories (#1141) wait for the signed answer path and standing-grant
protection gates. Image/file tunnel UI (#1170) waits for its threat model and
protocol freeze. Signed sandboxed Mac, signed Phone, notification-extension,
locked-device, Watch and physical-hardware acceptance remain owner gates. No
relay deployment or release acceptance is claimed.
