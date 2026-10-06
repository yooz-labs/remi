# Native secure push registration (#1200, tranche F)

`NativePushTokenOwner` captures only the native OS delegate callback. It bounds
tokens to 1–256 bytes and gives every callback a new in-memory revision; an
invalid token or failure clears the snapshot. No JavaScript token input selects
secure metadata.

`NativePushRegistration` requires current public device authority and a complete
native machine pairing. Each preparation owns a separate public runtime APNs
environment resolver, including its two-second deadline. Both exact entitlement
results are required; unavailable, conflicting or missing results refuse setup.
Build settings and DEBUG never select the environment.

Preparation preserves an existing native P256 recipient. Creation follows the
actual Keychain provider's not-found and durable-readback rules. It rechecks the
token epoch, document/identity callback, authority generation, machine trust and
recipient after the environment wait and after the final existing-key read.
Returned metadata is public and must travel over the current authenticated relay.
Callers must recheck before transmission.

The OS delegates (`AppDelegate` on iOS and on macOS record the token or its
failure) and the guarded WebKit operations `enableSecurePush`,
`preparePushRegistration` and `validatePushRegistration` in `NativeIdentityBridge`
are wired. The web client's relay subscription request and the visible enable
control are not: `SettingsPanel` renders the control only when a caller supplies
`onEnableSecurePush`, and `App` supplies none, so no shipped screen reaches these
operations yet.

A new P256 recipient carries its creation time in milliseconds as its key
version. The daemon refuses an equal version with a different key
(`STALE_KEY_VERSION`), so a key recreated after the item was lost, while the
identity and the daemon's subscription survive, has to outrank every version the
device could have registered; earlier builds registered 1. This assumes a device
clock that has not run backward past an earlier creation. `loadOrCreate` and
registration never replace an existing item. A corrupt item is repaired only by
the explicit enable action (`repairCorruptItem`, after the user grants
notification permission), which replaces an item that is corrupt, and nothing
else, with a higher-version key that must then register.

Tests use explicitly owned Keychain services with nil access groups, private
SQLite, real CryptoKit keys and only controlled public OS completion scheduling.
Unsigned SDK tests do not establish signed APNs provisioning, shared access
groups, locked extension execution, handset delivery or older iOS runtime support.
