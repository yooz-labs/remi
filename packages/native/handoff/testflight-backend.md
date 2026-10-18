# TestFlight and relay handoff

This is the live handoff for the first native iPhone TestFlight build. It is
written against `develop` at `4be3b65c` on 2026-10-18. Re-check the source head
and linked issues before claiming a gate passed.

## What is ready

- `scripts/testflight-ios.sh` archives `packages/native/Remi.xcodeproj`, scheme
  `RemiPhone`, not the retired Capacitor app.
- The native Xcode 27 workflow builds RemiKit, RemiMac, RemiPhone and the push
  extension, runs the package tests, and produces a validated unsigned archive.
- Release validation pins the production app and extension bundle identifiers,
  version/build, source commit, production APNS request, app group, shared push
  keychain group, icons, privacy manifests, embedded extension and receipt.
- Native relay v2, secure push registration, notification decryption and signed
  answers are implemented. Physical evidence already includes iPhone lock-screen
  Yes and Watch-mirrored No through a deployed Debug relay; see #1242.

These facts do not prove distribution signing, App Store export/upload, deployed
production relay behavior, battery behavior, or all remaining hardware gates.

## Backend developer queue

Work these as their own reviewed changes; do not fold them into release signing.

1. **#1272 — secure push subscription leases.** Renew a secure subscription while
   its phone is connected, expire it after `push_lease_hours` under the store lock,
   and cover the real secure store and source hub.
2. **#1225 — loaded relay close behavior.** Reproduce the BYE and grant failures
   under CPU load on the pinned Bun runtime, identify whether the cause is runtime,
   Worker, hub, or test timing, and close only with repeatable evidence.
3. **#1202 — R7 evidence and cleanup.** Run the ordinary relay gates and the
   61-minute source-hub/source-client soak at one immutable commit. Preserve full
   logs, exit status, runtime versions and the receipt. Local evidence does not
   substitute for deployed Cloudflare measurements or signed-device checks.
4. **#1303 — authorization/provisioning integration.** Complete the real-hub
   pending approval, public-key pre-authorization, same-label/different-key,
   revocation, and multi-host stable-identity tests.
5. **Support #1385 without changing Mac behavior.** Retain the real source
   hub/Worker fixture needed to prove iPhone background entry removes foreground
   connections, a signed background No reaches the held hook, and foreground
   activation reconnects exactly once.

## Relay deployment owner queue

Follow `docs/relay-worker-deploy-runbook.md`; agents must not handle these secrets
or deploy on the owner's behalf.

- Run the committed engine check on the deployed Cloudflare runtime and record its
  complete result.
- Configure `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` and `PUSH_SECRET` as
  Worker secrets. Configure the same push secret on each participating hub.
- Set `PUSH_AUDIENCE` to the exact canonical HTTPS Worker origin.
- Deploy the Worker migration, then run the health, removed-route, WebSocket nonce,
  unauthenticated push and authenticated-malformed push smoke checks.
- Measure production hibernation, alarm behavior, limits and Durable Object cost;
  local Miniflare observations are not Cloudflare measurements.
- Keep relay opt-in until every R7 default-on gate passes. Do not retire legacy
  `/push` until the full release-cycle criteria in the runbook are met.

## Apple/TestFlight owner queue

1. Ensure App Store Connect has the iOS app record for `live.yooz.remi` and the
   App ID has Push Notifications, App Groups and the required keychain capability.
2. Ensure the distribution certificate/profile can sign both the app and
   `live.yooz.remi.native-push-service`, including production APNS and
   `group.live.yooz.remi`.
3. Install the App Store Connect API key locally and set `ASC_KEY_ID`,
   `ASC_ISSUER_ID`, and optionally `ASC_KEY_PATH`. Do not commit them.
4. Bump and commit `config/app-release.json`'s build number, then run from a clean
   checkout:

   ```sh
   bun install --frozen-lockfile
   bun run testflight:ios
   ASC_KEY_ID=... ASC_ISSUER_ID=... bun run testflight:ios -- --upload
   ```

5. Preserve the acceptance receipt and upload response with the exact source
   commit. Confirm processing before assigning testers.
6. Complete export-compliance, privacy answers, the internal test group and tester
   access in App Store Connect.

## Native/device gates before broad TestFlight

- **#1385:** land iPhone background connection suspension and collect a physical
  power trace with Xcode disconnected. Source correctness is not battery evidence.
- **#1242:** finish two-machine signed-Mac validation, connection/registration
  recovery polish, and remaining standing-grant hardware behavior.
- **#1314:** verify notification summaries on physical devices with Apple
  Intelligence enabled, disabled and model-not-ready, including exact deep links.
- Run an installed TestFlight build through direct SSH-tunnel access and explicit
  Tailscale/LAN bind plus authentication, then through the deployed relay. Verify
  pairing, authorization, reconnect, session discovery, exact notification route,
  Yes/No answers, dismissal and revocation. Do not recommend `tailscale serve`.

## Go/no-go boundary

An internal TestFlight upload can proceed once the signed native archive/export and
App Store Connect checks pass. Relay should remain visibly opt-in while #1202,
#1225, #1272 or deployed-provider measurements remain open. A build may be an
internal TestFlight candidate without claiming relay default-on, battery readiness,
or broad production readiness.
