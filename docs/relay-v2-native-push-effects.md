# Native secure push effects (#1200, tranche E)

`NativePushEffect` independently opens the original capsule through the native
CryptoKit decoder. It reads the existing P256 recipient before checking the
captured public key/version, authority generation and completed machine trust.
Preparation commits the exact original-body digest, nonce and collapse lifecycle
in SQLite before publication. The effect overload checks the captured authority
generation inside that transaction. Exact duplicates cannot reinstall a card;
an accepted old nonce also refuses when its digest is no longer latest.

Publication and deletion consumers must call `recheck` after every asynchronous
wait and immediately before their effect. Live content requires the latest exact
revision, digest and nonce before expiry. Dismiss uses a separate terminal check;
its absorbing tombstone cannot become a live question. Actions independently
open the original capsule and check the latest live state, rather than relying
on an NSE flag or outer routing/option fields.

The shipping notification service extension starts with a new generic alert and
empty category. It forwards only the original public capsule. Verified text is
installed only after durable preparation. A category registration failure leaves
verified text without actions. Category callbacks recheck generation, recipient,
trust and lifecycle; expiration completes the fallback once and late callbacks
cannot publish or mutate it. Duplicate and dismiss content has no permission
card text or actions. An empty extension result is not a signed-device guarantee
that the OS suppresses an alert; an unexecuted extension can also leave untrusted
outer alert text on screen. Independent action refusal remains necessary.

Native MULTI and category-none cards always open the app. Protected identities,
missing/incomplete scope, setMode/session grants and action titles that cannot
contain their complete signed label/description/scope also grant no native
choice. YN/YNA require exact signed yes/no flags and option ordering; YNA permits
only a complete addRules scope. No label inference, truncation or omitted choice
is used. The whole title ceiling is 24 characters. For R5 every installed action
opens the app; the R6 native submission owner is not wired by this checkpoint.

The direct Effect tests and actual notification-extension caller tests use the
committed shared capsules, actual CryptoKit, UUID-owned Keychain services with
explicit nil access groups, private SQLite files and controlled OS category
callback scheduling. They cover same-public-identity generation replacement,
same-version P256 replacement, latest digest, terminal dismiss, deadline,
canonical option indices, full scope and protected policy. Notification tests
observe durable state before the callback and completion histories afterward.
The category boundary is injected; business logic and crypto are production.

Keychain and SQLite remain separate systems. Final observed checks are not a
claim of distributed atomicity or detection of every unobserved external change.
Unsigned SDK tests and iOS source typechecking do not prove signed App Group
sharing, locked NSE execution, physical camera/phone/Watch behavior, APNs
provisioning, handset delivery or deployed gateway acceptance. Native quiet
background dismissal, action ingress and secure registration still require their
own caller wiring and tests.
