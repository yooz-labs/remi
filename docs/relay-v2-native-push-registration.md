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
Callers must recheck before transmission. This coordinator checkpoint has not yet
wired OS delegates, guarded WebKit registration or relay subscription requests.

Tests use explicitly owned Keychain services with nil access groups, private
SQLite, real CryptoKit keys and only controlled public OS completion scheduling.
Unsigned SDK tests do not establish signed APNs provisioning, shared access
groups, locked extension execution, handset delivery or older iOS runtime support.
