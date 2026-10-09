# Native shared secure push core (#1242)

`RemiPush` adapts the reviewed legacy native secure-push implementation from
source commit `1e96c688f89409043e17177c1914d8eec247de7e`.
The original files remain unchanged in the source contract worktree.

| Original file | Original SHA-256 |
| --- | --- |
| `NativePushCodec.swift` | `d81b755c47dc66a3d27aff5688015ad54b19a9533d2fcaaeaed672371567cea6` |
| `NativePushState.swift` | `30b01297ef66f1f3245c0aef05504c51ab738576fa464a7f2f2ba9dc10c1589c` |
| `NativePushEffect.swift` | `942b6ca89fee7ec1d3fd41cf0a44105ed608c2a5239929aab7db044c0851a827` |
| `NativePushNotificationConsumer.swift` | `936f9b1b05afc6cda5dd4e7766adc591d04c59c7ec5876bc1930d57b2e86eaf3` |
| `NativePushKeyStore.swift` | `feab7ab9fce901ecf609cd7b97557b8251fb7276f48785877bff6ac857737c8e` |
| `NativeKeychainOperations.swift` | `5c55cfe21921a745d5e0ebd211cee84485880f023935c2d8da5e19ae355d051e` |
| `NativeEd25519PublicKey.swift` | `89d79031cb69a8913991d9c5da7c00b2c5e2eb28e3a56ca27f9a0d272570afa5` |
| `NativeAPNsEnvironment.swift` | `8cff7fd063814539cd535750a9ff4e727ae1aa61788c9f2ebfa2ac81d403c7ce` |
| `NativeAPNsEnvironmentQuery.h` | `6c974b6c81bbb2ba6e5f7d840e671ba0521505bb8a409ff651ae1aef0aa6e1ba` |
| `NativeAPNsEnvironmentQuery.m` | `b66041c61288d5b1097f6ffdec122f9c06bb714336d02882c120be54f0048254` |

The codec, SQLite schema, replay/collapse rules, identity mutation leases and
P256 record format are reused. Adapters add a narrow public facade, fixed native
Debug/Release namespace configuration, no-UI recipient reads, owned bytes across
notification queue hops, Swift concurrency annotations and escaped display text.
The public runtime APNs query is a separate Clang target; it retains its exact
entitlement checks, cancellation and deadlines.

`RemiKit` contains the app-exclusive versioned Dpk record adapter, from legacy
`packages/macos/Remi/ClientIdentity.swift` at the same commit.
Its strict record parsing, raw-seed Update migration, pre-write invalidation and
durable readback are retained. Stored signatures re-read the no-UI durable Dpk
revision and protection policy; protected records cannot sign in native apps.
Neither notification service extension links RemiKit or receives the Dpk group.

Production configuration resolves only `group.live.yooz.remi/native-debug/` or
`group.live.yooz.remi/native-release/`, with distinct P256 services and accounts
inside the existing secure-push sharing group. It never opens the legacy root
ledger or sealing service and has no local/temporary fallback.
Tests explicitly supply disposable private SQLite files and UUID Keychain items.

Port deltas include strict JSON string decoding through `JSONDecoder`, because
`JSONSerialization` drops a sole U+FEFF inside a JSON string. The signed original
payload bytes remain unchanged; display escaping preserves its visible `\\uFEFF`
representation. Actual shared-source scalar corpus, malformed token, duplicate
field and payload/title boundary tests pin this adapter.

Persisted signing uses a separate no-mutation version2 record verification:
it cannot migrate raw seeds, create credentials, or reconcile public authority.
Foreground identity loading retains the deliberate migration/reconciliation path.
On iOS the fixed shared directory and existing DB/WAL/SHM/identity-lock files use
`completeUntilFirstUserAuthentication`, with directory inheritance for companions
SQLite recreates. Unix permissions are directory0700/files0600. Locked-device
Keychain/provisioning acceptance remains an owner gate.


The native action facade adds immutable capsule-derived category/action IDs and
shares the source's complete YN/YNA semantic choice policy with the app signer.
The legacy consumer's empty-category presentation check is not used for these
native alerts: the facade independently reopens the original and compares exact
escaped UTF8 title/body, empty subtitle and the verified native category (or an
intentional category-free fallback). Cooperative publication uses a separate
native category lease with bounded OS reads/readback; unrelated OS writers can
still cause availability loss. Both NSEs share this facade without Dpk access.
Disposable owned stores refuse OS category publication independently of policy
validation. Pure category objects and the real source action receiver are tested;
signed device registry/delivery acceptance is a separate owner gate.
