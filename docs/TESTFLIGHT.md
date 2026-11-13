# Shipping Remi to TestFlight (local upload)

Remi ships its native Mac and iPhone apps through **local archives and uploads**.
There is no Xcode Cloud path. Both helpers archive `packages/native/Remi.xcodeproj`:
`RemiMac` for Mac and `RemiPhone` for iPhone and iPad. Apple team `9DQ459HAZB`; app bundle identifier
`live.yooz.remi`; push extension bundle identifier
`live.yooz.remi.native-push-service`.

Signing and upload belong to the owner under
[`packages/native/AGENTS.md`](../packages/native/AGENTS.md). Agents prepare and
validate unsigned archives; the owner runs the signed export and upload steps.

## iPhone and iPad

```bash
# build + archive + export the .ipa (no upload)
bun run testflight:ios
# or: ./scripts/testflight-ios.sh

# build + upload to TestFlight
ASC_KEY_ID=XXXX ASC_ISSUER_ID=uuid ./scripts/testflight-ios.sh --upload
```

`scripts/testflight-ios.sh` validates the native release contract, resolves the
configured version and exact source commit, archives `RemiPhone` for a generic iOS
device, checks the embedded `PhonePushService` extension and signed entitlements,
exports exactly one IPA, writes an acceptance receipt, and uploads only when
`--upload` is explicit. `--preflight-only` and `--unsigned-archive` provide
non-upload validation paths used by CI.

Automatic signing may use a development profile for the archive. App Store
export re-signs the payload with distribution profiles. The helper requires
production APNS on the exported app and verifies signatures, shared groups and
disabled debugger access on both exported targets before writing the receipt
or uploading (#1554).

Output lands in `build/ios-native/` (gitignored; override with
`REMI_ARCHIVE_DIR`). DerivedData defaults to `DerivedData` inside that output
directory; override it with `REMI_DERIVED_DATA_DIR`. For S1 worktrees, set both
paths explicitly on S1. Unsigned archives disable code signing and do not request
provisioning updates. They do not validate distribution entitlements or APNS
delivery.

## Versioning

The app has its **own** version line in `config/app-release.json`
(`marketingVersion`, `buildNumber`), decoupled from the daemon/npm version. The
release script passes both values as archive build settings; it does not rewrite
the Xcode project.

- Marketing version: edit `marketingVersion` in `config/app-release.json`.
- Build number: **bump before every upload** (App Store Connect rejects a
  duplicate build for the same marketing version):
  ```bash
  bun run app:version --bump-build   # buildNumber++ in config + stamp; commit it
  ```
  Or for a one-off unique build without touching config:
  ```bash
  REMI_BUILD_NUMBER=$(date +%y%m%d%H%M) ./scripts/testflight-ios.sh --upload
  ```
- `bun run app:version` updates the release configuration used by the repository's
  release tooling. The native archive receives the resolved values explicitly.

## App Store Connect API key (for `--upload`)

1. App Store Connect → Users and Access → Integrations → App Store Connect API →
   create a key (Admin or App Manager). Download the `.p8` **once**.
2. Place it at `~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8`
   (`altool` auto-discovers it there).
3. Export the identifiers when uploading:
   ```bash
   export ASC_KEY_ID=<KEYID>          # the key's Key ID
   export ASC_ISSUER_ID=<issuer-uuid> # the team's Issuer ID (top of the keys page)
   ```

## Signing

Automatic signing with team `9DQ459HAZB`. You need an **Apple Distribution**
certificate in your login keychain; `-allowProvisioningUpdates` lets `xcodebuild`
fetch/create the App Store provisioning profile. The simplest way to get the cert
the first time is to sign in to your Apple ID in Xcode → Settings → Accounts and
let it manage certificates, then run the script.

## Production APNS (already wired)

Push is split by build configuration so local testing and TestFlight each get the
right APNS environment:

- **Debug** requests the development APNS environment.
- **Release** requests the production APNS environment used by TestFlight.

The only prerequisite is registering the **Push Notifications** capability on the
App ID `live.yooz.remi` so the distribution provisioning profile carries the
production push entitlement (else the archive's codesign step fails). Coordinate
the production APNS key with the signaling Worker (notification epic #603 covers
the sandbox/prod token split).

## One-time App Store Connect setup

- Ensure the App ID `live.yooz.remi` and extension identifier
  `live.yooz.remi.native-push-service` exist with the capabilities required by the
  checked-in entitlements. Enable **Push Notifications** so the production APNS
  entitlement is allowed.
- **Create the App Store Connect app record (iOS)** in the web UI — My Apps → +
  → New App, bundle id `live.yooz.remi`. This is **required before the first
  upload** and the App Store Connect API cannot do it; until it exists `altool`
  fails with `Cannot determine the Apple ID from Bundle ID 'live.yooz.remi'`.
- TestFlight: add internal/external test groups; complete export-compliance.

The script passes an available ASC API key to `xcodebuild` itself
(`-authenticationKey*`) for archive/export provisioning. This does not replace
the one-time App Store Connect app record and capability setup.

## Preflight checklist

- [ ] `config/app-release.json` build number bumped + committed.
- [ ] Push Notifications capability registered on the App ID (production entitlement is already wired in the Release config).
- [ ] Native app icons and privacy manifests pass `bun run test:native-assets`.
- [ ] Distribution cert in keychain; `ASC_KEY_ID` / `ASC_ISSUER_ID` exported for `--upload`.
- [ ] Device family as intended (currently iPhone and iPad, `TARGETED_DEVICE_FAMILY = "1,2"`).

The live backend/relay, owner and physical-device checklist is
[`packages/native/handoff/testflight-backend.md`](../packages/native/handoff/testflight-backend.md).

## macOS

`bun run testflight:macos` selects the native SwiftUI `RemiMac` app and its
`MacPushService` extension. It replaces the older WebView app in the Mac
TestFlight train. Do not use `scripts/testflight-macos.sh` for native releases.

```bash
# Settings and source checks, no signing or upload
bash packages/native/scripts/testflight-native-macos.sh --preflight-only
# Compile and inspect the Release payload without signing
bash packages/native/scripts/testflight-native-macos.sh --unsigned-archive
# Owner: signed archive, export and verification of the App Store .pkg
bun run testflight:macos
# Owner: additionally validate and upload the .pkg
ASC_KEY_ID=XXXX ASC_ISSUER_ID=uuid bun run testflight:macos -- --upload
```

Mac output defaults to `build/macos-native/`. The same `REMI_ARCHIVE_DIR`,
`REMI_DERIVED_DATA_DIR`, version configuration, build override and source marker
apply to both helpers. Use separate output and DerivedData directories for each
platform. Both archives require a clean tracked checkout. Pin the same commit
for the two platforms and retain their `acceptance-receipt.txt` files.

For example, prepare the unsigned pair on S1 from that clean checkout:

```bash
REMI_ARCHIVE_DIR=/Volumes/S1/yooz/remi/artifacts/tf22/macos \
REMI_DERIVED_DATA_DIR=/Volumes/S1/derived/remi-tf22-macos \
bash packages/native/scripts/testflight-native-macos.sh --unsigned-archive
REMI_ARCHIVE_DIR=/Volumes/S1/yooz/remi/artifacts/tf22/ios \
REMI_DERIVED_DATA_DIR=/Volumes/S1/derived/remi-tf22-ios \
bash scripts/testflight-ios.sh --unsigned-archive
```

One-time Mac setup, in addition to the iOS setup:

- Add the macOS platform to the Remi App Store Connect record (`live.yooz.remi`).
  Mac and iOS have separate build trains; confirm the proposed number is unused
  on both before preparing the shared version configuration.
- Install the distribution application and Mac Installer Distribution
  certificates in the owner's keychain. The installer certificate signs the
  exported `.pkg`.

The native helper checks app and extension identifiers, icons, privacy manifests,
source and version markers, sandbox and shared groups. Signed export additionally
checks production APNS entitlements, signatures, disabled debugger access and the
installer signature before upload. These checks establish payload properties;
physical notification delivery and answers still need device verification.

## Device acceptance after upload

Install the processed build on Mac and iPhone. With a fresh daemon session,
verify Claude and Codex conversation history, current Working/Thinking/Idle
states, foreground and background questions, concise notification options,
answers and resolution on the other client. Include iPhone lock screen and
Watch delivery where available. Keep delivery, extension decryption and answer
results separate from provider acceptance; an APNS success response alone does
not establish that the device displayed a notification.

Record the results against [#1681](https://github.com/yooz-labs/remi/issues/1681).
Internal Codex `/resume` rebinding remains tracked separately in
[#1691](https://github.com/yooz-labs/remi/issues/1691).
