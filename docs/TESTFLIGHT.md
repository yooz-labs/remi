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

## Production APNS (do once, at first archive)

The committed `packages/web/ios/App/App/App.entitlements` keeps
`aps-environment = development` so local **sandbox** push testing keeps working.
A TestFlight build needs **production** APNS. Split it by configuration rather
than flipping the shared file:

- add `App/AppRelease.entitlements` with `aps-environment = production`, and
- set `CODE_SIGN_ENTITLEMENTS` per config in the Xcode project
  (Debug → `App/App.entitlements`, Release → `App/AppRelease.entitlements`).

Coordinate the production APNS key with the signaling Worker (notification epic
#603 covers the sandbox/prod token split).

## One-time App Store Connect setup

- Register App ID `live.yooz.remi` with the **Push Notifications** capability.
- Create the App Store Connect app record (iOS).
- TestFlight: add internal/external test groups; complete export-compliance.

## Preflight checklist

- [ ] `config/app-release.json` build number bumped + committed.
- [ ] Release entitlement uses production APNS (above).
- [ ] App icons present (`packages/web/ios/App/App/Assets.xcassets/AppIcon.appiconset`).
- [ ] Distribution cert in keychain; `ASC_KEY_ID` / `ASC_ISSUER_ID` exported for `--upload`.
- [ ] Device family as intended (currently iPhone-only, `TARGETED_DEVICE_FAMILY = 1`).

## macOS

Deferred (Phase 2, #658). When we add it, decide between a yooz-notes-style
WKWebView client shell and folding the client into the menu-bar hub app (#648).
