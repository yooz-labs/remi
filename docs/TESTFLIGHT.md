# Shipping Remi to TestFlight (local upload)

Remi ships to TestFlight from a **local archive + upload**, the same path as
`yooz-whisper` — no Xcode Cloud. You build and upload from your Mac with a single
script. Apple team `9DQ459HAZB`, bundle id `live.yooz.remi`.

## The one command

```bash
# build + archive + export the .ipa (no upload)
bun run testflight:ios
# or: ./scripts/testflight-ios.sh

# build + upload to TestFlight
ASC_KEY_ID=XXXX ASC_ISSUER_ID=uuid ./scripts/testflight-ios.sh --upload
```

`scripts/testflight-ios.sh` does, in order:

1. Stamp the app version into the Xcode project (`scripts/sync-app-version.mjs`).
2. `bun run build` (in `packages/web`) + `bunx cap sync ios`.
3. `xcodebuild archive` the workspace `packages/web/ios/App/App.xcworkspace`
   (scheme `App`, Release, `generic/platform=iOS`, automatic signing).
4. `xcodebuild -exportArchive` with App Store options → a `.ipa`.
5. With `--upload`: `xcrun altool --upload-app -t ios` using an App Store Connect
   API key.

Output lands in `build/ios/` (gitignored; override with `REMI_ARCHIVE_DIR`).

## Versioning

The app has its **own** version line in `config/app-release.json`
(`marketingVersion`, `buildNumber`), decoupled from the daemon/npm version. The
Info.plist already reads `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)`, so
only the pbxproj is stamped.

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
- `bun run app:version` stamps the pbxproj from config without bumping.

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

- **Debug** → `App/App.entitlements` (`aps-environment = development`) — local
  sandbox push testing keeps working.
- **Release** → `App/AppRelease.entitlements` (`aps-environment = production`) —
  what the archive/TestFlight build uses.

The only prerequisite is registering the **Push Notifications** capability on the
App ID `live.yooz.remi` so the distribution provisioning profile carries the
production push entitlement (else the archive's codesign step fails). Coordinate
the production APNS key with the signaling Worker (notification epic #603 covers
the sandbox/prod token split).

## One-time App Store Connect setup

- The App ID `live.yooz.remi` is auto-registered on the first archive (automatic
  signing + the API key). Enable the **Push Notifications** capability on it so
  the production-APNS entitlement is allowed.
- **Create the App Store Connect app record (iOS)** in the web UI — My Apps → +
  → New App, bundle id `live.yooz.remi`. This is **required before the first
  upload** and the App Store Connect API cannot do it; until it exists `altool`
  fails with `Cannot determine the Apple ID from Bundle ID 'live.yooz.remi'`.
- TestFlight: add internal/external test groups; complete export-compliance.

The script passes the ASC API key to `xcodebuild` itself
(`-authenticationKey*`), so the archive/export create the App ID and the App
Store distribution profile headlessly — no signed-in Xcode account needed.

## Preflight checklist

- [ ] `config/app-release.json` build number bumped + committed.
- [ ] Push Notifications capability registered on the App ID (production entitlement is already wired in the Release config).
- [ ] App icons present (`packages/web/ios/App/App/Assets.xcassets/AppIcon.appiconset`).
- [ ] Distribution cert in keychain; `ASC_KEY_ID` / `ASC_ISSUER_ID` exported for `--upload`.
- [ ] Device family as intended (currently iPhone-only, `TARGETED_DEVICE_FAMILY = 1`).

## macOS

The macOS client IS the menu-bar hub app (`packages/macos/`, epic #648 — see
`docs/MACOS_APP.md`). Same local path as iOS:

```bash
bun run app:version --bump-build     # shared version line with iOS; commit it
bun run testflight:macos -- --upload
```

One-off unique build without touching the config (same override as iOS):
`REMI_BUILD_NUMBER=$(date +%y%m%d%H%M) bun run testflight:macos -- --upload`.

The script stages the web UI into the app, archives, exports a signed Mac App
Store **.pkg** (macOS's .ipa equivalent), and uploads with `altool -t macos`.
Same `.env` / ASC API key as iOS.

One-time setup (beyond the iOS list):

- App Store Connect > My Apps > Remi (`live.yooz.remi`) > **+ Add Platform >
  macOS**. Same bundle id = universal purchase; macOS gets its own version
  line and build train (which is why sharing `config/app-release.json`'s
  build counter with iOS is safe).
- A **Mac Installer Distribution** certificate in the login keychain (shows
  as "3rd Party Mac Developer Installer" for older-generation certs — either
  works). It signs the .pkg and is the one credential iOS never needed. A
  missing one fails the export step with "no .pkg produced". Already present
  on the primary dev machine (verified 2026-07-07; export produced a signed
  .pkg end-to-end).

Preflight (macOS-specific):

- [ ] App Sandbox + network-client entitlements only (TestFlight validation
      rejects unsandboxed executables — the app never bundles the remi binary).
- [ ] `ITSAppUsesNonExemptEncryption=false` in the macOS Info.plist (set).
- [ ] AppIcon present (`packages/macos/Remi/Assets.xcassets/AppIcon.appiconset`).
- [ ] On-machine smoke: menu-bar icon states + web UI against a live hub
      (`remi serve`), kill-matrix from `docs/MACOS_APP.md`.

Testers install via the TestFlight app on macOS (App Store > TestFlight).
