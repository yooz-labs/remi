# Native secure-push persistence and environment query (#1200)

This directory implements native persistence, original-capsule verification,
notification publication, quiet dismissal and foreground presentation checks.

What ships for a v2 notification (one carrying the `remiPush` capsule):

- The notification service extension replaces the generic alert with the
  verified title and body, and registers no category. A secure card has no
  action buttons, so a tap opens the app. Answering from the lock screen or the
  Watch is R6 (#1201), which has no native owner yet: an action button would be
  dismissed by iOS on tap and the choice silently dropped. The action policy
  that R6 needs (exact yes/no flags, complete `addRules` scope, protected
  identities) was removed with its tests in the commit `fix(native): offer no
  answer actions on secure cards`; its parent holds the last version.
- `NativePushNotificationConsumer.routeResponse` consumes every response to a
  v2 notification, even a malformed or unverifiable one, so none reaches the
  legacy direct relay or the wrapped Capacitor handler.
- Foreground presentation accepts only the verified text with an empty
  category. A category on a signed card is unverified authority and is refused.
- An exact duplicate of the latest live capsule renders the same verified card
  again, because the collapse id is the delivered notification's identifier and
  any other result would replace the live card. A capsule that is no longer the
  latest live revision (stale, replayed after a newer revision, or after a
  terminal) cannot be dropped by an extension without the notification
  filtering entitlement, so it shows the generic alert: no text, no actions,
  and the newer revision's record is untouched.

A push without the `remiPush` carrier is the direct-mode plaintext push. The
extension passes its content and userInfo through and builds its dynamic
`REMI_DYN_` category exactly as before #1200, never opening the secure state or
keys, and `RemiAnswerRelay` answers it through the legacy signed relay (#591).
That path keeps its documented arbitrary eviction of old dynamic categories.

The registration coordinator and the guarded bundled-WebKit operations
(`enableSecurePush`, `preparePushRegistration`, `validatePushRegistration`) are
connected to the actual OS token callbacks of both app delegates, and the web
client uses them: the Settings enable control and `SecurePushSubscriptions`
(see `docs/relay-v2-native-push-registration.md`). Not verified on a signed
device.

The P256 sealing key carries a version that is its creation time in milliseconds.
The daemon refuses an equal version with a different key, so a key recreated
after the item was lost must outrank every version the device could have
registered; earlier builds registered 1. This assumes the device clock has not
run backward past an earlier creation. A corrupt item is never replaced by
`loadOrCreate` or by registration. The explicit enable action calls
`repairCorruptItem`, which replaces only a corrupt item (not a valid key, a
missing item or a read error such as a locked device) with a higher-version key;
the new key must then register with the daemon before it receives any push.

Registration reads only an actual OS delegate token, captures its epoch, and
resolves the runtime APNs environment for each attempt. The bundled main document
may request permission explicitly, prepare public subscription metadata, and
validate a one-use native ticket immediately before sending it. These operations
recheck foreground, document, private identity, durable authority, completed
machine trust, sealing key, and token lifetime. Pending requests and tickets share
a 32-entry bound without live eviction; tickets and permission requests expire
after thirty seconds. Losing the foreground or document cancels continuations;
late system callbacks cannot regain authority. No permission prompt runs at macOS
startup. Build entitlement declarations do not replace the runtime query or prove
signed registration.

`NativePushState` stores public identity authority and completed machine trust in
SQLite. A nonblocking advisory file lock serializes identity writers. Every
revision-changing writer commits invalidation before updating the private
Keychain record, verifies the durable readback, and installs public authority
only for its own invalidation generation. Failure never restores older machine
trust. SQLite and Keychain are separate operations, not a distributed transaction.
The bundled WebKit bridge checks foreground and document lifetime again after
acquiring this lock; loads that migrate an older native seed use that same guard.
Native pairing ingress permits up to32 pending one-use, two-minute monotonic
attempts without evicting live entries. Each attempt is bound to the
current private identity, protection revision, bundled document, and durable
authority generation. Commit rechecks these contexts after the actual writer lock.
An explicit completed pairing may recover public identity authority for that same
generation; ordinary get/sign operations still never restore it. The actual
authenticated and encrypted web READY continuation awaits this durable commit
before publishing connected. Forget intent synchronously closes its client
reconnect; successful durable native forget clears all pending attempts, because
begin does not carry a machine selector. A delayed READY cannot reinstall a
forgotten row; a new explicit begin remains available. Native restore and forget
use only these completed
native rows, never browser pin storage. Browser-only clients retain their separate
browser persistence. A failed native save remains a visible terminal pairing
error and requires explicit retry.

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
An exact duplicate is recognized by its recorded nonce and digest and renders only
while it is still the identical latest live digest; a superseded one is refused.
Dismiss is absorbing until the maximum of the seen expiry plus 60
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
