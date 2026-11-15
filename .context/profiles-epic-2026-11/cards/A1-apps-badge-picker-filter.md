# Card A1: profiles in the apps 1: badge, picker, filter chip and read-only list (issue #1788) (OUTLINE)

Status: outline
Tier: worker-hard
Timebox: L, 2 days; escalate at 4 days or two failed approaches
Needs: xcode
Depends: CPA1 (the lead completes this card there, after CP2)
Branch: `feature/issue-1788-apps-profiles-1` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/profiles-a1`
Plan: plan.md section 2 (A1); issue #1788 (all of it); ADR 0051 A1, A2 (list only), A5, A6, A14, A15 and the "Profile picker", "Session badge" and "Profile filter chip" state tables

## Goal

From an iPhone, an iPad or a Mac, a person starts a session in a profile the machine lets devices select (the hub's default preselected with its reason), sees which profile every session runs in, and narrows a session list to one profile.

## Context

Verified on `develop` `c9e13967`; the CPA1 lead re-verifies after phase 2 merged.
- `HubCapability` and `HubSupport.check` (`packages/native/RemiKit/Sources/RemiKit/Protocol/ProtocolSupport.swift:18`, `:138-177`); the new-session sheets `PhoneNewSessionSheet` (`packages/native/iPhone/NewSessionSheet.swift:5`) and `MacLiveNewSessionSheet` (`packages/native/Mac/MacLiveRootView.swift:2337`); rows `RemiKit/Sources/RemiUI/Rows.swift`, tiles `RemiUI/BoardTile.swift`, Mac detail `Mac/MacSessionDetail.swift`, iPhone session `iPhone/SessionScreen.swift`, Machines sheet `iPhone/MachinesSheet.swift`, Mac Preferences `Mac/MacPreferencesView.swift`; fixture decoding `RemiKit/Tests/RemiKitTests/FixtureConformanceTests.swift`.
- "Profile" already names a machine route profile in native code (ADR 0039; ADR 0051 F9): account profiles get a distinct type name (`AccountProfile`).
- Visual gate: `packages/native/VISUAL-ACCEPTANCE.md` (exact-commit receipt from `scripts/build-exact-native.sh`, screenshots at standard size and Accessibility 5, light and dark, iPad full screen and the narrowest regular-width window, iPhone Duo folded and unfolded); capture runs on the manager's host with the owner's announced consent (plan J10) against the fixture hub on a port above 18790, never the real hub, with the app uninstalled from the simulator before the first launch.
- App documentation gate: the picker's reason line and the Profiles list link to the docs guide's "How a new session picks a profile" section, published for the release that ships this slice (DOCS-P1 fixed the heading; the URL base is confirmed at CPA1).

## Scope

Draft: RemiKit models and decoders, `HubCapability.sessionProfiles`, the sheets, rows, tiles, details, the filter chip in each session list, the read-only Profiles list, tests, previews, `packages/native/PARITY.md` rows, PR body; no daemon or web file (a fixture gap stops the card).

## Decided design

Draft for the CPA1 lead: type and file names; where the chip state lives (memory only, cleared at launch); the integration test's hub fixture (a hub from source with a temporary `REMI_HOME`, two profiles, a fake `claude`).

## Acceptance

From #1788, to be made literal at CPA1 (each checkbox of the issue becomes a named test or command), including: every #1749 fixture carrying a profile decodes and unknown enum values decode as nil; no Profile row, badge or chip without `session_profiles`; the encoded `create_session_request` carries `profile` only for a capable hub; no stored profile choice after relaunch; the filter never changes the Inbox, notifications or the menu bar count; escaped labels and VoiceOver texts; the unknown-value fixture shows no sign-in claim; `lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --skip PairingAttemptTests --skip PairingSourceTests`, the Mac `xcodebuild ... build test` and the iPhone `xcodebuild ... build` under the lock; `typos`; the visual gate receipt.

## Gates

The native gates of `packages/native/AGENTS.md` under the Xcode lock with `-derivedDataPath /Volumes/S1/derived/remi-profiles-a1`; `typos`; completed at CPA1.

## Stop conditions

A daemon or fixture change is needed; a mock would replace the store, the connection or a decoder; the app would connect to a real hub.

## Report

The preamble's report.
