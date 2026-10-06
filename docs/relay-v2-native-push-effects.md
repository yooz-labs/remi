# Native secure push effects (#1200, tranche E)

`NativePushEffect` independently opens the original capsule through the native
CryptoKit decoder. It reads the existing P256 recipient before checking the
captured public key/version, authority generation and completed machine trust.
Preparation commits the exact original-body digest, nonce and collapse lifecycle
in SQLite before publication. The effect overload checks the captured authority
generation inside that transaction. An exact duplicate of the latest live digest
renders its card again; an accepted old nonce refuses when its digest is no
longer latest.

Publication and deletion consumers must call `recheck` after every asynchronous
wait and immediately before their effect. Live content requires the latest exact
revision, digest and nonce before expiry. Dismiss uses a separate terminal check;
its absorbing tombstone cannot become a live question. No outer NSE flag or
outer routing/option field grants any authority.

The shipping notification service extension starts a secure (`remiPush`) push
with a new generic alert and empty category. It forwards only the original public
capsule. Verified text is installed only after durable preparation, which
rechecks generation, recipient, trust and lifecycle as its last step. Preparation
runs on its own queue, so an expiry is never held behind Keychain or SQLite;
expiration completes the fallback once and late work cannot publish or mutate
delivered content.

The extension registers no category, so a verified card has no action buttons
and a tap opens the app. Answering from the lock screen or the Watch is R6
(#1201) and has no native owner yet. The extension used to register Yes/No
actions that opened the app, but iOS dismisses the card after an action tap and
nothing answered, so the choice was dropped. They were removed together with the
action eligibility policy and its tests; the parent of the commit
`fix(native): offer no answer actions on secure cards` holds the last version.

The delivered notification's identifier is the collapse id, so what the extension
returns replaces the live card. An exact duplicate of the latest live digest
renders the same verified text again. A capsule that is no longer the latest
live revision (an older revision, a superseded collapse, a replay of an older
nonce, or a question after its terminal) cannot be dropped by an extension that
lacks the notification filtering entitlement, so it receives the generic alert:
it grants nothing, opens the app, and leaves the newer revision's lifecycle
record untouched. A terminal capsule that reaches the extension shows no text.
An empty extension result is not a signed-device guarantee that the OS suppresses
an alert; an unexecuted extension can also leave untrusted outer alert text on
screen.

A push with no `remiPush` carrier is the direct-mode plaintext push. The
extension returns its content and userInfo unchanged and builds its dynamic
`REMI_DYN_` category as before #1200, without opening the secure state or keys;
`RemiAnswerRelay` answers it through the legacy signed relay.

The direct Effect tests and actual notification-extension caller tests use the
committed shared capsules, actual CryptoKit, UUID-owned Keychain services with
explicit nil access groups, private SQLite files and a controlled legacy category
callback. They cover same-public-identity generation replacement, same-version
P256 replacement, latest digest, terminal dismiss, deadline, duplicate and stale
delivery, expiry before preparation and the legacy passthrough. The category
installer is injected for the legacy path only; business logic and crypto are
production.

Keychain and SQLite remain separate systems. Final observed checks are not a
claim of distributed atomicity or detection of every unobserved external change.
Unsigned SDK tests and iOS source typechecking do not prove signed App Group
sharing, locked NSE execution, physical camera/phone/Watch behavior, APNs
provisioning, handset delivery or deployed gateway acceptance. `NativePushNotificationConsumer` verifies a quiet dismiss and commits its
terminal lifecycle before the OS delivered-card read. The pending map holds at
most 32 contexts for two monotonic seconds; an expired read releases its decoded
context, and the callback holds only an ID. A scan exceeding 128 cards refuses
all removal. Each candidate capsule is independently verified, then matched by
signed rid/collapse/revision. The current terminal and captured generation/P256
are rechecked immediately before removal. An expired candidate capsule remains
untouched, rather than accepting it with relaxed time validation.

Background question wakes do not consume a notification nonce. There is no native
action consumer: `NativePushNotificationConsumer.routeResponse` consumes every
response to a v2 notification without reading its outer fields and without
answering. The owned OS callback tests of the quiet dismiss cover actual
second-connection authority changes, recipient replacement, scan bounds,
absorbing dismissal and repeated late callback histories. The iOS `AppDelegate`
calls this consumer for v2 quiet wakes before the legacy JavaScript pre-wake.
`RemiAnswerRelay` routes responses before reading outer IDs/options; the legacy
and wrapped JavaScript senders run only for the explicit old path, so no
JavaScript consumer of a verified v2 notification exists. Foreground presentation
independently verifies the original capsule and exact text; a signed card
carries no category, so any category is refused. The fixed generic no-action
fallback grants no route or authentication.

The adapter pins construct the actual native router and consume a result from
the shipping notification extension, including missing-key/malformed routing
refusal and altered text or category. SDK 27 unsigned iOS `App` and its notification
extension build with the real frozen Capacitor modules. The private build
extracts the installed CLI's SPM template, runs its actual sync, and uses
`CODE_SIGNING_ALLOWED=NO`; no shipping app is launched. This compile/build result
is not old-SDK, signed extension or real-device runtime acceptance.
