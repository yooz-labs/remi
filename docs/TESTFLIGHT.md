# Shipping Remi to TestFlight

How the Remi app gets to TestFlight via **Xcode Cloud**, mirroring the
`yooz-notes` pipeline. iOS is live first; macOS is a later phase (see #658).

There is no fastlane. Apple team `9DQ459HAZB`, bundle id `live.yooz.remi`.

## The monorepo nuance

Unlike `yooz-notes` (Capacitor app at the repo root), Remi is a bun monorepo and
the Capacitor app lives in `packages/web`. Xcode Cloud clones the repo root, so
the CI scripts `cd` into `packages/web` before building. The iOS Xcode workspace
is `packages/web/ios/App/App.xcworkspace` (scheme `App`).

## Pieces in this repo

| File | Role |
|---|---|
| `ci_scripts/ci_post_clone.sh` | Repo-root logic: install bun, `bun install` (workspace), `bun run build` in `packages/web`, then `cap sync ios`. Verifies `dist/index.html`. |
| `packages/web/ios/App/ci_scripts/ci_post_clone.sh` | Thin wrapper co-located with the workspace; sets `YOOZ_XCODE_CLOUD_PLATFORM=ios` and delegates to the root script. |
| `packages/web/ios/App/ci_scripts/ci_pre_xcodebuild.sh` | Stamps the version before archiving: marketing from `config/app-release.json`, build number from Xcode Cloud's `CI_BUILD_NUMBER`. |
| `config/app-release.json` | The app's **own** version line (`marketingVersion`, `buildNumber`), decoupled from the daemon/npm version. |
| `scripts/sync-app-version.mjs` | Writes `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` into the iOS pbxproj (Info.plist already reads the build vars). `bun run app:version`. |

## Versioning

- **Marketing version** ("what users see") lives in `config/app-release.json`. Bump it there; run `bun run app:version` to write it into the Xcode project, commit the result.
- **Build number** is Xcode Cloud's monotonic `CI_BUILD_NUMBER`, applied by `ci_pre_xcodebuild.sh` at build time, so every TestFlight upload increments without a committed bump. Local archives fall back to `buildNumber` in the config.
- The app version is intentionally **separate** from the daemon/npm version (`scripts/bump-version.sh`, root `package.json`): a `0.1.x` app and a `0.6.x` daemon should not fight.

## Release flow

1. Set the marketing version in `config/app-release.json` if it changed; `bun run app:version`; commit.
2. Merge to / push the `testflight` branch (the Xcode Cloud trigger). **Never** push straight to `main`/`develop`; cut the TF build from a dedicated branch.
3. Xcode Cloud runs `ci_post_clone.sh` (web build + `cap sync`), `ci_pre_xcodebuild.sh` (version stamp), archives the `App` scheme, and uploads to TestFlight.

## Manual setup (Apple-account holder, one-time)

These need App Store Connect / Developer portal access and are **not** in the repo:

1. **App ID** `live.yooz.remi` registered with the **Push Notifications** capability.
2. **App Store Connect app record** (iOS platform; macOS added in Phase 2).
3. **Xcode Cloud workflow**:
   - Primary repository: the repo **root**.
   - Xcode project/workspace: `packages/web/ios/App/App.xcworkspace`, scheme `App`.
   - Start condition: branch changes on `testflight`.
   - Archive action → TestFlight (internal, then external) groups.
4. **APNS** production key configured (coordinate with the signaling Worker; see notification epic #603 for the sandbox/prod token split).
5. **Export compliance** declaration for the build.

## Production APNS entitlement (do when wiring signing)

The committed `packages/web/ios/App/App/App.entitlements` keeps
`aps-environment = development` so current on-device **sandbox** testing keeps
working. A TestFlight build must use **production** APNS. When configuring Xcode
Cloud signing, split it by configuration instead of flipping the shared file:

- add a `AppRelease.entitlements` with `aps-environment = production`, and
- set `CODE_SIGN_ENTITLEMENTS` per build config in the Xcode project (Debug →
  `App/App.entitlements`, Release → `App/AppRelease.entitlements`).

This is deliberately left as a signing-time step (it can't be validated without a
real signed archive) rather than flipping the shared entitlement now and breaking
local sandbox push testing.

## Preflight checklist (before a `testflight` push)

- [ ] `cd packages/web && bun run build` succeeds; `dist/index.html` present.
- [ ] `bun run app:version` run and committed if the marketing version changed.
- [ ] iOS Release entitlement uses production APNS (per above).
- [ ] App icons present (`packages/web/ios/App/App/Assets.xcassets/AppIcon.appiconset`).
- [ ] Decide device family if it changed (currently iPhone-only, `TARGETED_DEVICE_FAMILY = 1`).
