# Native secure-push persistence and environment query (#1200)

This directory currently implements the native persistence and APNs environment
boundaries. Secure registration, original-byte capsule verification, the verified
READY web caller, and NSE/action consumers still need to be connected. The
existing notification extension is not yet the secure-push decoder.

`NativePushState` stores public identity authority and completed machine trust in
SQLite. A nonblocking advisory file lock serializes identity writers. Every
revision-changing writer commits invalidation before updating the private
Keychain record, verifies the durable readback, and installs public authority
only for its own invalidation generation. Failure never restores older machine
trust. SQLite and Keychain are separate operations, not a distributed transaction.
The bundled WebKit bridge checks foreground and document lifetime again after
acquiring this lock; loads that migrate an older native seed use that same guard.
Native pairing ingress issues a one-use, two-minute monotonic attempt bound to the
current private identity, protection revision, bundled document, and durable
authority generation. Commit rechecks these contexts after the actual writer lock.
An explicit completed pairing may recover public identity authority for that same
generation; ordinary get/sign operations still never restore it. The verified web
READY callback is not connected to these new ingress operations yet.

Read-only identity observation invalidates installed authority if the actual
record is unavailable, deleted, corrupt, or differs in public key, revision, or
`requiresAppUnlock`. A successful later read installs neither authority nor
machine trust. External Keychain changes remain unobserved until an app reader
runs; the notification extension has only the public ledger. Protection metadata
is a local policy hint. The native signer independently reads and enforces the
private protection policy; the hint is not Keychain attestation.

Production Dpk queries specify the app-exclusive Keychain group. The P256
sealing key has a separate shared app/extension group. The extension's default
Keychain group is its own bundle group, and it does not compile the Dpk-private
store. The P256 store uses CryptoKit DER and public-point import/export, creates
only on an actual not-found result, and refuses corruption or readback mismatch.
Tests explicitly inject nil groups with disposable UUID service/account pairs.
Production resolves only the configured shared container and groups; missing
configuration does not create a temporary or app-local substitute.

Completed machine trust pins a canonical HTTPS origin: ports are bounded and
re-emitted without zero prefixes; public IP parsers verify exact dotted IPv4 and
lowercase IPv6 with the longest first zero run. The actual shared submission
validator is checked against the native store for the same origin corpus.
Completed machine trust stores the verified public WSS route and its matching
HTTPS origin. The route preserves the bounded relay path; credentials, query,
fragment, noncanonical spelling, and a different origin are refused. Schema-five
migration leaves older route-less rows incomplete. Native listings restore only
complete rows and never import browser localStorage pins.
Completed machine trust is limited to 32 saved machines. Replay state has 2048
rows total across nonce and collapse tables; it never evicts live rows. The
preverified tuple/digest storage boundary commits before publication or deletion.
Exact duplicate capsules do not redisplay. Actions require the identical latest
live digest. Dismiss is absorbing until the maximum of the seen expiry plus 60
seconds and dismiss issue time plus 3600 plus 120 seconds. Forget and re-pair
preserve replay records and tombstones. Cryptographic verification belongs to the
original-byte decoder; the persistence API does not verify a signature itself.

`NativeAPNsEnvironment` queries both exact entitlement values under one two-second
async deadline. One match and the other mismatch selects the environment;
conflict, missing evidence, cancellation, context replacement, and timeout refuse.
macOS uses public SecTask self-entitlement lookup. iOS 17.4 and newer use the public
anonymous self-XPC lightweight requirement path. Older iOS and simulator builds
report unavailable, with no receipt, DEBUG, configured-environment, or private-API
fallback. The public requirement-error constant is weak-linked and checked before
comparison. Query mechanics tests do not prove signed iOS environment detection.

Owned unsigned tests exercise actual Keychain records, SQLite connections and
separate processes, bundled nonpersistent WKWebViews, CryptoKit keys, and actual
anonymous self-XPC mismatch/cancellation. Supported SDK compilation and these
local tests do not establish signed App Group containment, cross-target Keychain
sharing, old-device backdeployment, locked notification handling, or physical
phone/Watch acceptance. Those remain owner hardware/provisioning gates.
