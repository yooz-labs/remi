# TestFlight and relay handoff

This is the live handoff for the first native iPhone TestFlight build. It is
reconciled on 2026-10-19 against `develop` at `d085e42e` and the #1272
continuation. Re-check the source head and linked issues before claiming a gate
passed. The primary checkout has local native edits; preserve them and use the
backend worktree for backend validation.

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

1. **#1272 — secure push subscription leases implemented in this continuation.**
   All secure store consumers and the hub use `push_lease_hours` (24 hours by
   default; 0 never expires). The hub renews on registration, ready, periodic
   current connection checks and close. Fan-out, prepared sends and native-answer
   commits reject expiry under the store lock. Expired records retain a monotonic dormant marker
   within the 64-row file bound to retain their push-key version floor; explicit
   unregister/revoke frees a row. Fresh registration rotates the subscription
   generation. Old records receive one migration lease. Review identified and
   corrected a stale-key rollback after expiry; regressions cover restart,
   physical capacity, clock/config changes, actual HTTP send and a real held-hook
   commit. Final
   exact-head CI and R7 remain merge gates, not implied by these source changes.
2. **#1225 — the fix already landed.** Reviewed #1271 (`5cb6c49f`) is an ancestor
   of current develop. The hub preserves its authenticated BYE with a bounded
   orderly-close grace and forgets the control before shutdown. Keep the
   existing loaded-test receipts and current close tests; reconcile the stale
   open issue rather than reimplementing the fix.
3. **#1202 — current R7 evidence and owner acceptance.** Run the ordinary relay
   gates and 61-minute source-hub/source-client soak at one immutable commit.
   Preserve full logs, exit status, runtime versions and the receipt. Prior
   source-runtime soaks passed (#1331, #1330 and later work); this is a current
   regression gate. Local evidence does not establish deployed Cloudflare
   measurements, production cost, Release/TestFlight or signed-device checks.
4. **#1303 — backend provisioning already landed in #1315 (`e4a1ecf7`).**
   `packages/daemon/tests/integration/key-provisioning.test.ts` constructs real
   hubs, a child daemon and CLI operations for pending approval, public-key
   preauthorization, same-label/different-key refusal, revocation, rotation and
   one identity on two machines. Keep the issue open for the remaining native
   identity/approval workflow and physical fleet acceptance; do not duplicate
   the completed backend implementation.
5. **#1385 — source lifecycle already landed in #1386 (`389d9dbf`).** The real
   `NativeSecureSourceIntegrationTests` fixture covers iPhone background
   transport retirement, signed background No delivery, single foreground
   reconnect and unchanged Mac monitoring. Keep this fixture intact. Physical
   connection/CPU observations exist on the issue, but battery improvement and
   a usable power trace remain unmeasured; no new source fix is required by the
   handoff alone.

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

- **#1385:** background suspension is landed; collect a physical
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

The native assets, release-contract script and preflight can be validated without
Apple credentials. They do not prove distribution signing or upload.

An internal TestFlight upload can proceed once the signed native archive/export and
App Store Connect checks pass. Relay should remain visibly opt-in while #1202,
#1225, #1272 or deployed-provider measurements remain open. A build may be an
internal TestFlight candidate without claiming relay default-on, battery readiness,
or broad production readiness.
