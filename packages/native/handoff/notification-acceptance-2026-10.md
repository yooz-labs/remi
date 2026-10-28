# Paired notifications: source and owner acceptance

Epic #1677 follows the owner's approved policy: authenticated app use renews registration, 30 days inactive requires Continue/Revoke, and push does not require a foreground socket. Source PRs are #1682 (scope), #1683 (host), #1684 (native) and the #1681 presentation phase; #1676 removes attached-client suppression. Confirm final GitHub heads and gates before installing any candidate. A source test, HTTP receipt or unsigned build is not physical APNs or Watch acceptance.

## Owner setup and release boundary

The running host diagnosed on October 26 had no push secret and explicitly disabled its secure sender. A candidate hub needs the existing provider credential configured through the owner's protected host setup, its signing identity and admitted Worker control. Never paste that credential in chat. Native Settings shows Host notification setup needed until these exist. Notification-only enrollment does not turn on a foreground relay route or override an explicit host network disablement.

Do not replace the installed CLI, restart active session daemons, change the production Worker, sign or upload an app as part of source verification. Preserve existing host keys, authorized devices, route profiles, aliases and manual layer selections. Old running session daemons do not acquire new forwarding code merely because the hub or app was rebuilt; new compatible session daemons are required for that path. Coordinate any host restart and session relaunch with the owner.

From the final clean reviewed checkout, the existing script's read-only signing/configuration preflight is:

```sh
DEVELOPER_DIR=/Volumes/S1/Applications/Xcode.app/Contents/Developer bash scripts/testflight-ios.sh --preflight-only
```

The owner runs signing/export using that script without `--preflight-only`; `--upload` additionally publishes the archive. Check `config/app-release.json` against the latest accepted Apple build before choosing a build number. Signing, provisioning updates, App Store Connect and final upload remain owner actions. The owner signs the native Mac app through the RemiMac scheme in `packages/native/Remi.xcodeproj`. Unsigned Debug builds prove compilation, not APNs entitlements or shared-container access.

## Physical acceptance receipts

Record the source commit, CLI version, app build, APNs environment, host identity fingerprint and selected foreground layer for each receipt. Keep tokens, provider credentials, private keys and question content out of shared logs.

1. Pair a signed app through Local-only, then through an existing Tailscale-only profile. Authorize OS notifications. Observe Notifications registered without adding a foreground Relay route, changing its identity/alias or switching the selected layer. Repeat when pairing the first host in an already open app.
2. With the app foregrounded, then backgrounded and its direct sockets closed, let an owner-controlled Claude question and Codex approval arrive. Record provider acceptance separately from NSE decryption and visible phone delivery. Verify a short summary; a fully represented binary permission has Deny/Allow once, while long commands, plans, protected identities and multi-question forms have Review request. Review opens the paired session's full current content and never sends an answer.
3. Choose an offered answer exactly once. Record the native receipt separately from the tool/harness outcome. Answer another prompt at the terminal and confirm the old notification action refuses or disappears. Do not replay an uncertain answer.
4. Repeat with a locked iPhone and paired Watch in the owner's intended notification-mirroring setup. Record actual Watch arrival, visible copy, action labels, Review behavior and safe first action. A phone receipt alone does not satisfy this step.
5. Revoke on the app, reconnect, background and cold-launch it. Confirm no automatic re-enablement; use Enable to opt in again. Revoke/Forget while offline must remove local notification authority before reconnection. Remove OS permission and confirm the app suppresses registration and unregisters on reachable hosts.
6. Use an isolated acceptance host with a deliberately short supported `notifications.push_lease_hours` value to exercise active renewal and inactive expiry without editing production records or advancing the clock. After inactivity, verify automatic registration refuses, Continue creates fresh registration, Revoke keeps it off, and old signed actions/key versions cannot revive it. The production default remains 30 days.

Keep each failure as a separate receipt. Missing delivery must distinguish host setup, registration, provider rejection/uncertainty, extension verification, device presentation and Watch mirroring. Do not relabel a retry's success as proof that a preceding failure was fixed.
