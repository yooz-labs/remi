# Native signed push verification (#1200, tranche D)

`NativePushCodec.open(userInfo:state:keys:now:)` verifies the original `remiPush`
capsule with CryptoKit. It reads only an existing native P256 recipient key and
current public SQLite authority. The machine trust must include the completed
native pairing route; nullable legacy rows remain diagnostic state and refuse.
This module never creates or repairs a key, installs pairing trust, commits
lifecycle state, publishes a notification or signs an answer.

The codec parses only the exact `remiPush` member. Other outer fields, including
APS category, session selectors, options and a supplied verification flag, are
untrusted. The recipient, machine key and device identity come from the actual
native stores. The sealed capsule binds rid and collapse id as AAD; its inner
tuple binds every recipient, lifecycle and time field. Signature verification
uses the original length-prefixed body and the `remi-relay-v2 push content`
domain. Only after verification does the codec parse those same payload bytes.
Reordered JSON and whitespace are valid when signed exactly; decoded duplicate
member names, unknown fields, invalid UTF8, wrong types and noncanonical public
encodings refuse. The entire signed inner envelope is at most 2048 bytes.

The immutable `VerifiedPush` result contains:

- `originalCarrier.userInfo`, preserving the exact validated public capsule for
  later independent verification; `originalBody` and `payloadBytes` remain exact.
- `record`, with SHA256 of that original body, nonce, revision, kind and expiry.
- The typed question, informational or dismiss payload. Question options retain
  every value, label, yes/no flag, description and standing-grant scope.
- Captured completed trust, public authority generation and recipient key/version.

The final existing-key OS read precedes the final current trust/authority and
generation checks. Another process can still mutate state after this synchronous
function returns. The receiving consumer must commit
`state.recordVerifiedContent(record, trust:trust, now:)` before any publication or
deletion, then recheck current authority at its final effect. Actions must invoke
the actual codec again on the original capsule and use
`state.reverifyLatestContent(record, trust:trust, now:)`; a persisted verified flag
or a result supplied by JavaScript never substitutes for verification. Category
and display eligibility belong to the independently guarded presentation/action
consumer. An authenticated question with category `none` does not grant a tap.

Failures use fixed `NativePushCodecError` cases. The module has no logger and
returns no private key. Its direct tests use the ten committed shared vectors,
actual CryptoKit, UUID-owned Keychain namespaces and private SQLite files.
They also exercise the OS-read boundary with another real SQLite connection;
those controlled boundary cases do not claim natural scheduling measurements.

Tranches B/E/F own actual READY, ingress, NSE and action wiring. Unsigned SDK tests
and cross-engine fixtures do not establish signed sharing entitlements, locked
iPhone/Watch behavior, deployed gateway delivery or owner hardware acceptance.

Scoped validation at the source checkpoint `aa7ff637` and test checkpoint
`a6fac6c2`:

- Unsigned SDK 27 macOS `NativePushCodecTests`: 16 passed, zero failures/skips.
  Each constructor uses a UUID Keychain service/account, explicit nil access
  group and private SQLite directory. The unhosted test target has no WK or
  default identity access. OS tests used the approved inherited-HOME convention;
  dependency and Bun checks used private HOME.
- The shared push and vector tests passed on Bun 1.4.2 and pinned 1.3.11:
  15 tests, 163 assertions on each. The independent Python verifier checked all
  ten exact vectors. Swift/CryptoKit is a separate SDK engine, not a Bun run.
- A frozen private copy killed 32 named mutation families through XCTest
  expectations; each selected test passed after restoration. These cover
  original-byte signature/domain, tuple bindings and shape, duplicate/type/
  schema/UTF8 parsing, finite time and byte bounds, payload kind, current
  recipient/generation/completed trust, and final OS-read ordering. The copy
  finished clean with identical codec bytes and no processes referencing its
  owned path. Timeout, compile and setup failures are not assertion kills.
- SDK 27 iOS 15-minimum source typecheck passed. Pinned Biome 1.9.4 reported
  zero errors and the 52 baseline warnings; typos and diff checks passed.
  Web and signaling typechecks passed. Root and web-test checks on this native
  base still lack secure-push cases in daemon `Connection`/`attach-client`;
  the separately owned consumer fixes and merged-head gates remain required.

Reproduce the scoped tests from a frozen checkout with owned output directories:

```sh
xcodebuild test -project packages/macos/Remi.xcodeproj -scheme Remi \
  -destination platform=macOS -derivedDataPath "$OWNED/DerivedData" \
  -resultBundlePath "$OWNED/codec.xcresult" \
  -only-testing:RemiTests/NativePushCodecTests CODE_SIGNING_ALLOWED=NO
bun test packages/shared/tests/relay/push.test.ts \
  packages/shared/tests/relay/push-vectors.test.ts
python3 scripts/verify-push-vectors.py
```

The initial scaffold produced actual verification-outcome assertion failures.
Two later regressions were pinned before their fixes: authority invalidation
during the final OS read, and refusal of a diagnostic trust row with no completed
route. An earlier fresh-signature fixture equality assumption was corrected and
its failed attempt excluded; exact fixture parity uses the original committed
signature. Missing XCTest framework setup attempts are also excluded. No
monorepo full suite, signed extension ingress, notification publication or tap
transport is claimed by these direct codec checks.
