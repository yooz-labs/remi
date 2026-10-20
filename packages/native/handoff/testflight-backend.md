# TestFlight and relay handoff

This handoff is reconciled on 2026-10-20. The iPhone candidate is **0.2.0 (11)**,
from clean source `e72012e6f8aa67c300b9bdf478653d8936f80c56`, which includes
#1551's secure push lease fix and #1552's release metadata. It has been signed,
exported, uploaded, processed, cleared for export compliance with owner
confirmation, and verified as **Testing** in the existing internal group.

The CLI is a separate release: npm and Homebrew still publish 0.7.16 at this
snapshot. #1556 tracks publishing CLI 0.7.17 through `develop` to `main` so
`remi pair` is available from those channels. A reviewed local compiled backend
at the candidate source reaches the real QR pairing flow; this does not prove
completed phone pairing. See [the upgrade guide](../../../docs/UPGRADING-0.7.17.md).

The old primary-checkout native edits were compared with landed #1535 and removed
at the owner's request. The primary checkout is clean; other pre-existing
worktrees remain preserved. Recheck current heads and linked issues before
claiming any remaining gate passed.

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

The signed export/upload evidence is recorded below. Source and CI results alone
do not establish deployed production relay behavior, battery behavior or all
remaining hardware gates.

## Backend developer queue

Work these as their own reviewed changes; do not fold them into release signing.

1. **#1272 — secure push subscription leases landed in #1551; issue closed.**
   All secure store consumers and the hub use `push_lease_hours` (24 hours by
   default; 0 never expires). The hub renews on registration, ready, periodic
   current connection checks and close. Fan-out, prepared sends and native-answer
   commits reject expiry under the store lock. Expired records retain a monotonic dormant marker
   within the 64-row file bound to retain their push-key version floor; explicit
   unregister/revoke frees a row. Fresh registration rotates the subscription
   generation. Old records receive one migration lease. Review identified and
   corrected a stale-key rollback after expiry; regressions cover restart,
   physical capacity, clock/config changes, actual HTTP send and a real held-hook
   commit. Both supported Bun full suites and loaded close controls passed
   locally. Exact-head CI and the actual 61-minute R7 source soak passed before
   merge `a3f8f10c`; the final reviewed head was `fbe9e1e8`.
2. **#1225 — the fix already landed.** Reviewed #1271 (`5cb6c49f`) is an ancestor
   of current develop. The hub preserves its authenticated BYE with a bounded
   orderly-close grace and forgets the control before shutdown. Keep the
   existing loaded-test receipts and current close tests; reconcile the stale
   issue, now closed with those receipts, rather than reimplementing the fix.
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

The owner explicitly approved the v2 cutover and push setup after reviewing the
irreversible migration and impact on old clients. Production is now version
`8110ead2-d14c-4343-b408-3cbd9146d135`, migration v4, from `e72012e6`.
The APNS secrets were preserved, the push bearer and canonical audience were
configured, and this Mac's real hub reported `Relay control admitted`.

The deployed engine's 39 required checks, seven live route/nonce checks and
13 controlled-peer checks passed. These sent no APNS notification and do not
establish full shipping-client or signed-device acceptance. See the
[deployment receipt](../../../docs/relay-production-2026-10-20.md) for exact
scope, source, version and retained evidence. Continue with the
[deployment runbook](../../../docs/relay-worker-deploy-runbook.md):

- Configure the matching bearer on every other participating hub and update old
  senders. Existing session daemons on this Mac were preserved.
- Verify the production push/decryption/answer path on the installed TestFlight
  app and finish the deployed R7 session and negative controls.
- Measure production hibernation, alarm behavior, limits and Durable Object cost;
  local Miniflare observations are not Cloudflare measurements.
- Keep relay opt-in until every R7 default-on gate passes. Do not retire legacy
  `/push` until the full release-cycle criteria in the runbook are met.

## Apple/TestFlight owner queue

App Store Connect was checked in the owner's authenticated Chrome session on
2026-10-20. [Yooz Remi](https://appstoreconnect.apple.com/apps/6785313030/testflight/ios)
now has native iOS **0.2.0 (11)**, verified **Testing** in the existing internal
group, with one tester and 90 days remaining. The owner confirmed the updated
Developer Program agreement was already accepted.

- Source: `e72012e6f8aa67c300b9bdf478653d8936f80c56`.
- Delivery/build ID: `795c742d-23f3-45d9-82a0-29b70dc2135d`.
- IPA SHA-256: `329ec7f4c5e6f5e8605ed0c8519ede192d6e4940e204336a5e6c6fbccaf433b1`.
- Both exported app and Notification Service Extension passed strict signature,
  App Group and shared keychain checks; the app has production APNS and both
  have debugger access disabled. Xcode's intermediate automatic-signing archive
  used development profiles; the distribution export was checked separately.
- Upload succeeded without errors. Processing and internal testing availability
  were verified independently in App Store Connect. With owner confirmation,
  the OS-only encryption declaration was saved: native cryptographic primitives
  use Apple CryptoKit/Security. This does not mean that the app has no encryption.
- #1555 corrects the helper's premature production-APNS check: final distribution
  entitlements must be checked after export, before upload. A full signed
  archive/export at its reviewed head `985ad3e3` passed without a second upload.

Receipts, upload logs and the internal Testing screenshot are under
`/Volumes/S1/yooz/remi/artifacts/2026-10-19-testflight-backend/signed-release/`.
Build 11 has been consumed: **do not upload it again**. Keep marketing version
0.2.0 and advance the build number to 12 or higher for another upload.

Internal testing availability does not prove the device gates below. The main
iPhone reports 0.2.0 (11) installed; pairing, transport, notification and answer
acceptance need their own observations. External Beta/App Review submission,
privacy review and broad availability remain separate.

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

Local acceptance at backend source `b6e66aad` passed 10,369 tests on each Bun
1.4.2 and 1.3.11 (37 skips), 101 focused checks on each runtime, and all 28
semantic mutation controls. The initial 1.4.2 full run had one discovery failure;
the single quiet full rerun passed. #1550 retains the original failure and its
undetermined cause. Loaded original R3 grant/BYE and orderly-close controls also
passed twice on each runtime with one owned load process per CPU.

The current Swift package passed 230 tests, unsigned Mac build/tests and an
unsigned iPhone simulator build. Its optional source fixture deliberately pins
backend `1e96c688f89409043e17177c1914d8eec247de7e`; that interoperability pass is
against the reviewed reference, not the changed lease backend. Real current
backend store, HTTP, held-hook and source-hub tests cover the lease change.
Receipts and full logs are retained under
`/Volumes/S1/yooz/remi/artifacts/2026-10-19-testflight-backend/`.

The native assets, release-contract script and preflight can be validated without
Apple credentials. They do not prove distribution signing or upload.

The internal TestFlight upload and App Store Connect gates above passed. Relay
should remain visibly opt-in while #1202 or deployed-provider and signed-device
measurements remain open. Internal TestFlight availability does not establish
relay default-on, battery readiness or broad production readiness.
