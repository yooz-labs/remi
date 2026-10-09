# Native relay X2 checkpoints (#1242)

This milestone adds an opt-in relay v2 connection to the Swift Mac and Phone
clients. It covers foreground pairing, reconnecting with a saved public machine
pin, session discovery, semantic session requests, permission cards, and the
existing `answer` / `answer_result` path. The verified-alert checkpoint adds secure
alerts and an app-opened notification card whose offered choice uses the signed
`native_answer` path. Issues #1242 and #1201 remain open; OS action categories and
lock-screen/Watch answer acceptance are not enabled by this checkpoint.

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
The separate secure-push checkpoint below imports its existing reviewed oracles;
it does not claim those 84 foreground oracle groups.

The original source pin advertises `workspaces` but lacks develop's
`recent_repositories_request` registry and handler. Actual native interop exposed
that mismatch: DATA decrypted successfully, then source `deserialize` returned
null for the request. The separately maintained contract-sync composite
`fe52daf7` combines existing relay `8fb5b88b` and develop `1d800273`, preserving
both protocols and selecting relay pairing with `--relay`. The native branch
does not merge or rewrite that backend. Both source bases must be ancestors of
the checkout used for the interop gate.

## Foreground checkpoint receipts (782ca468)

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

## Verified alerts and app-opened signed answers

`RemiPush` reuses the reviewed legacy codec, SQLite lifecycle/authority leases,
P256 storage and actual-runtime APNs entitlement query from source
`1e96c688f89409043e17177c1914d8eec247de7e`. File provenance and port deltas are in
`packages/native/RemiKit/RemiPush.md`. The app and both new service extensions use
the fixed `native-debug` or `native-release` subdirectory of the already approved
`group.live.yooz.remi` container. Native P256 service/account names include that
namespace inside the existing secure-push access group. Missing configuration,
group or container refuses; no local/temporary production fallback exists.
The legacy root ledger and legacy P256 service are never opened.

Both extensions depend only on the `RemiPush` product. They independently open
the original carrier, verify the machine signature and current recipient/trust,
apply the reused rollback/replay/collapse rules, and recheck before presenting
escaped signed title/body. Their secure category remains empty. Extension expiry
returns a generic alert rather than an unverified button or destination. The
extensions never link the app-exclusive Dpk store, signer or relay sender.

The app-exclusive Dpk adapter preserves valid legacy v2 JSON, PKCS8 bytes,
revision and protection metadata. Native raw32 migration uses Keychain Update
under the identity mutation lease, with invalidation before write and durable
readback; a successful corrupt read is never treated as absence. Cold app
bootstrap uses strict load-only current-record reads. Creation or migration is
confined to an active foreground boundary. Every persisted admission, H2 and
native-answer signature re-reads the current no-UI durable record. Protected
records refuse signatures; no native passphrase unlock is implemented.

Explicit Enable requests OS notification permission and registration, obtains
the token from the app delegate, and uses the actual signed runtime APNs
environment. A freshly authenticated READY may commit native notification trust
for that explicit attempt. A saved endpoint or notification preference alone
cannot reinstall missing/revoked SQLite trust: ordinary READY only checks
existing trust, and restored registration intent requires current completed
ledger trust. Token rotation rechecks that authority before sending a correlated
`secure_push_register`. Failed Forget keeps a visible retryable machine and its
preference, while invalidating old callback, reconnect and in-flight authority.

Default notification taps reopen the original capsule into a verified card;
foreground presentation independently compares the same escaped signed text.
A v2 marker is consumed even if malformed and never falls through to a legacy
destination/action handler. Quiet dismiss uses only the shared verification
facade. Rendering follows the exact shared scalar escape set, including U+FEFF,
without modifying signed payload bytes. Signed option values use exact UTF8
equality, preserving composed/decomposed distinctions that Swift String equality
otherwise hides.

An offered YN/YNA choice from that verified app card enters
`MachineStore.answerRelayNotification`. The shared broker reserves the current
Dpk/room, waits for queued foreground launch and retirement across Store
lifetimes, then starts one short-lived relay channel without a reconnect loop.
The same restricted identity signs admission, H2 and the final proof; each
signature checks the current capsule, presentation/lifecycle and durable Dpk.
The sender reopens/rechecks after awaits and immediately before emission. The
tuple derives solely from the verified original carrier. Its fresh 32-byte nonce,
body digest, timestamp and signature match the existing source contract. Actual
send omits every optional field, including `cancel: false`.

Handshake and receipt settlement use a monotonic 23-second deadline, reserving
two seconds of the 25-second total for bounded BYE, cancellation and actor
retirement. A missing receipt yields uncertainty, with no automatic second proof,
ID, nonce or retry. A receipt for an old card is recorded separately and cannot
dismiss a newly opened card. Foreground restart requires the same running Store
epoch and existing endpoint; a stopped or forgotten Store is not resurrected.

The unchanged canonical source oracles include ten push vectors and eight native
answer body/digest/signing-input vectors. Their adjacent README pins hashes.
All eight answer variants are internal encoder/oracle coverage; production sends
only the source-accepted required signed choice. The separate actual source gate
requires the exact clean contract-sync source checkout and installed Bun runtimes:

```sh
REMI_NATIVE_SECURE_SOURCE_ROOT=/absolute/path/to/relay-contract-sync \
REMI_NATIVE_SECURE_BUN=/absolute/path/to/bun-1.4.2 \
REMI_NATIVE_SECURE_CLI_BUN=/absolute/path/to/bun-1.3.11 \
  swift test --package-path packages/native/RemiKit \
  --filter NativeSecureSourceIntegrationTests
```

The proxy runtime defaults to `/opt/homebrew/bin/bun`; CLI runtime defaults to
the proxy. The helper validates proxy 1.4.2 and CLI 1.3.11 or 1.4.2, exact source
head, clean source and real TLS health. Requested opt-in configuration failures
fail the gate. It launches from a new empty private directory with a stripped
environment before Bun can load dotenv. The Swift test trusts only its owned CA
through a test-only URLSession delegate, with exact SSL host/anchor evaluation;
no app certificate bypass or system trust change is introduced.

The gate runs the actual source CLI hub and spawned child, workerd Durable
Object, TLS proxy and APNs receiver. Swift genuinely pairs, installs trust only
after the compared READY, registers its own P256 recipient, opens the original
APNs carrier, signs No, observes the actual held hook deny and correlates delivered.
It separately tests child-to-hub receipt loss (source returns uncertain), and
hub-to-Swift byte loss (actual effect occurs once while the client's own waiter
expires, retires its socket within the total bound, and never reconnects/retries).
Actual abort then signed same-collapse higher-revision dismiss tests H2 and final
signature invalidation; lower replay cannot revive that capsule. Source grant
revocation must report both success and edge acknowledgment before interpreting
refused authentication. The initial wrong-fingerprint control returned NOT_FOUND
and is retained as failed-control diagnosis, not revocation acceptance.

The owned proxy's half-closed TLS streams are explicitly retired. Cleanup shares
one promise, independently checks/stops only owned PID/birth/parent/cwd matches,
and waits for child/hub/workerd before removing launch state. Private scratch
receipts are retained. The inert owned CLI keeps a real PTY/hook alive; no real
Claude/Codex service, owner configuration, APNs credentials or device is used.

### Verified-alert checkpoint receipts

The ordinary package reports 85 tests: 83 passes and two explicit source opt-in
skips. `NativeAnswerProofTests` checks all eight original body/digest/signing-input
vectors, distinct signed Unicode option values and current capsule/lifetime/
presentation restrictions. `NativePushCoreTests` opens all ten original push
capsules and rejects decryptable content with a corrupt machine signature.
The 248-entry actual shared display corpus and strict parser boundaries remain
part of the ordinary suite. Cold identity tests preserve missing, raw and corrupt
records without migration, creation or authority reconciliation.

The focused actual source/proof/broker run passed seven tests at 29.685 seconds
against source `1e96c688` after caller fixes `9cd3fa7e`. Its third-signature
observer opens the genuine retained higher-revision dismiss exactly before final
signing, proving the production proof uses the same restricted identity as
admission/H2. Broker tests pause an already-authorized queued launch and prove
stop, claim and replacement wait for that launch followed by actor retirement.

Ten semantic mutation families were detected: current identity revision,
protection, capsule/lifetime/presentation restriction, cold-read migration,
machine push signature, exact option bytes, duplicate JSON fields, retained
launch retirement, final proof using a base identity, and the cleanup budget.
The first duplicate-field mutant survived its initial false/true test because
JSONDecoder independently refused the first false value without an error.
A valid same-value duplicate test detects that mutant; the initial masked test
is not counted as detection. All source mutations were SHA-verified restored.
The original 24-second receipt budget failed the silent client test at 25.465
seconds total; the current 23-second settlement passes its measured 23-to-25
second total assertion for that owned transport path.

Implementation-machine receipts:

- `/private/tmp/remi-x2-foundation-final-swift.log`
- `/private/tmp/remi-x2-caller-races-fixed.log`
- `/private/tmp/remi-x2-final-signer-pin.log` and `remi-x2-broker-retirement-pin.log`
  record the reproduced pre-fix failures.
- `/private/tmp/remi-x2-secure-client-deadline.log` and
  `remi-x2-secure-client-deadline-fixed.log` distinguish the measured budget fix.
- `/private/tmp/remi-x2-secure-mutations.json`, named mutant logs, and
  `/private/tmp/remi-x2-secure-mutant-duplicate-json-strengthened.log`.

The App/NSE Debug and Release build receipts for isolated wiring are under
`/private/tmp/remi-x2-app-wiring.o0gPEF/`. Those provisional builds and inspected
Info/linker products do not exercise signed entitlements, live APNs or device
delivery. Final whole-checkpoint unsigned gates and rendered QA are reported
separately in the PR. This checkpoint does not replace the foreground receipt
counts above.

For the Xcode handoff, daemon relay contracts already landed on the relay epic
through #1222. The current composite source is the separate draft #1331 at
`1e96c688`, preserving newer develop contracts. Those contracts are not merged
into develop/release by this native branch. Provider deployment, signed APNs
provisioning, sandbox/extension delivery, locked-device behavior, Watch and the
two-machine owner acceptance remain unmeasured here.
The Worker's default `APNS_BUNDLE_ID` is `live.yooz.remi`; a signed Debug app
(`live.yooz.remi.dev`) needs owner-controlled provider topic configuration matching
that app before APNs delivery can be tested. No agent changes that deployment.

## Remaining X2 and #1201 gates

The next tranche must enable action categories only after the signed caller
review and source gates, preserve full signed titles/meanings and require unlock
for standing grants. Background actions must independently reopen the capsule,
compare displayed text and recompute immutable category/action identifiers;
outer APNs/NSE flags grant no answer authority. Native currently has no protected
foreground unlock capability, so protected signatures still refuse.
Foreground question cards do not carry the secure-push runtime instance, content
digest or collapse authority, so this milestone does not forge those fields.

No new OS relay notification action, background answer, lock-screen category,
Watch answer, attachment UI or sealed-file transport is enabled.
Notification categories (#1141) wait for the signed answer path and standing-grant
protection gates. Image/file tunnel UI (#1170) waits for its threat model and
protocol freeze. Signed sandboxed Mac, signed Phone, notification-extension,
locked-device, Watch and physical-hardware acceptance remain owner gates. No
relay deployment or release acceptance is claimed.
