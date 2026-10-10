# Plan: the roadmap

Updated 2026-10-10.
One page: where remi stands, what comes next and in what order, and how each step is tested.
The work itself lives in GitHub milestones and issues; standing decisions live in [decisions/](decisions/) as ADRs; history lives in [archive/](archive/).

## Where things stand

- **Supported hosts (owner decision, ADR 0040):** Apple Silicon Macs (M1 and
  later), Linux ARM64 and Linux x86_64. Intel Mac/Rosetta is outside acceptance
  and future distribution scope.
- **Released on GitHub:** [0.7.16](https://github.com/yooz-labs/remi/releases/tag/v0.7.16), published 2026-10-07.
- **On develop (0.7.17-dev), ahead of the stable release:**
  - no local judge: Claude Code decides permissions, remi relays them (#1125, ADR 0030);
  - held-hook answers (#1126, #1127, ADR 0031);
  - the Codex adapter (epic #1175, ADR 0033);
  - first-connect approval: every client key is approved once with `remi authorize` (#873);
  - the relay off by default and fail-closed (#1193);
  - one `turn_failed` alert per failure until the agent works again (#1153, #1226).
- **Relay backend landed in develop:** [#1331](https://github.com/yooz-labs/remi/pull/1331), merge `b1168126`, includes the existing R1-R5 and daemon R6 contracts, the authority-contention correction, v1 retirement and heartbeat replies. Relay remains off by default. Both full Bun suites and the actual [61-minute Linux relay gate](https://github.com/yooz-labs/remi/actions/runs/37905906897) passed at backend `2858e4bd`, whose tree equals the merge. Signed-device and deployed-Worker acceptance remain open; #1195/#1202 are not closed by the source landing.
- **File tunnel:** [#1329](https://github.com/yooz-labs/remi/pull/1329) records the threat model and candidate staging contract. It is a proposal, with no accepted freeze or runtime attachment capability. Platform-storage, bounded-decoder and harness-lifetime work precede native attachment UI.
- **Apps today:**
  - a sandboxed macOS menu-bar app that hosts the web UI;
  - the Capacitor iPhone app with a Notification Service Extension;
  - the web client.

  Native SwiftUI source lives in `packages/native`: [native-apps-plan-2026-10.md](native-apps-plan-2026-10.md).
  Relay and secure native answers continue in existing [#1330](https://github.com/yooz-labs/remi/pull/1330), against the landed backend; its handoff lists the foreground Ping/Pong fix, source-test refresh and remaining signed/device gates.

## Milestones, in order

Each milestone is a GitHub milestone of the same name. Issues outside a milestone belong to a track (below).

| # | Milestone | What it delivers | Done when |
|---|---|---|---|
| 1 | **0.7.16 release** | Develop shipped to users, with its release blockers fixed: #1223 (legacy cards not dismissed on a real close), #729 (the always-on hub's logs never rotate), #1131 (third-party notices in the packages), #1249 (the agent's process inherits remi's secrets), #1254 (a machine the phone disconnected from keeps pushing to it) | The owner approves the release (#1233); `develop` to `main` is merged; the upgrade notes cover the one-time `remi authorize` and stopping the old engine by hand |
| 2 | **Relay R7** | Relay v2 finished and merged into develop, still off by default: #1224, #1225, R7 (#1202); then close #1195, #1199, #1200, #544, #373 | The R7 suite passes against a real Durable Object (session over an hour; replay, displacement, stranger and revoke refused; ciphertext only); the owner's signed-device and deployed-Worker gates pass |
| 3 | **Protocol freeze** | The wire a native client builds on: machine object (#1234), Decision (#1235), workspaces and worktrees (#1236), version and capabilities (#1237), fixture coverage (#1238), multiple profiles per session (#1157), the file tunnel's frames (#1170), plus #1129, #534, #695, #791 | Every message a native client uses has a golden fixture and an ADR records each new shape |
| 4 | **Native foundations (X0-X2)** | Repo prep for Xcode's agents (#1240), the `RemiKit` core (#1241), relay v2 in Swift and native answers (#1242, #1201) | Every fixture round-trips in Swift; all relay v2 vectors pass in Swift; a TypeScript hub accepts a Swift-signed answer |
| 5 | **Native apps (X3-X4)** | The Conductor-like Mac app (#1243) and the iPhone app (#1244) | The Mac app replaces the WebView window for daily use on two machines; the iPhone app reaches parity with the Capacitor app |
| 6 | **Native depth (X5-X6)** | Diffs, files and a terminal view (#1245); Live Activities, Watch and widgets (#1246) | Per phase issue |

Milestones 2 and 3 run in parallel.
The native apps (milestones 4 and 5) run in parallel too: Codex builds them in Xcode from `packages/native/handoff/README.md`, on `develop` (the scaffold moved there on 2026-10-07 in #1267; there is no epic branch), as two tracks, the Mac app and the iPhone app.
They build against today's wire and adopt the freeze's shapes as they land.
The epic for 4 to 6 is #1239.

## Completed backend continuation: recent repositories (#1284)

The owner selected #1284 on 2026-10-09 while the native developer continues X2 separately.
The wire stays unchanged; only successful hub starts write history, capped at 20 with no age expiry.
Landed through [#1332](https://github.com/yooz-labs/remi/pull/1332) at `ef84b4c6`, with the same tree as tested `28ea5daf`.
Both full Bun suites passed 7,942 tests with no failures; Linux CI and the actual 61-minute relay gate passed.
The existing native caller needs no new Swift model or wire field for this persistence behavior.

1. Pin the removed-worktree and expired-session regressions against the original source, plus ordinary creates and hub resumes (`tests/integration/hub-create-session.test.ts`, `hub-resume.test.ts`).
2. Add restricted atomic history (`workspace/recent-store.ts`), merge it into `workspace/recent.ts`, and wire the successful shared starter and recent-repositories handler in `cli.ts`; async lock waiting reuses the existing ownership and stale recovery rules.
3. Verify canonical main repositories, latest-use deduplication, cap, permissions, damaged-source fallback, simultaneous writers and responsive bounded lock waiting; update ADR 0036's source and disclosure descriptions.
4. Review, mutation-check each behavior, run fresh full suites on Bun 1.4.2 and 1.3.11 and the existing CI gates, then land through a PR to develop.

## Next work while native acceptance proceeds

1. Complete the backend machine descriptor in #1234, with the existing relay room ID and shared bounded pairing name, hello/list fields, entry machine IDs, fixtures and ADR 0039. Native persisted aliases, rename controls and profile transfer follow these contracts in the Xcode track. #1330 and #1342 have landed; remaining signed/native acceptance stays with #1242/#1201.
2. The file-tunnel proposal [#1329](https://github.com/yooz-labs/remi/pull/1329) landed at `35254d7e`. Packaging [#1350](https://github.com/yooz-labs/remi/pull/1350) and admission [#1362](https://github.com/yooz-labs/remi/pull/1362) landed; six supported target/version executions passed 16 admission/primitive controls. Continue the same standalone candidate with bounded private-copy validation, then reservations/recovery and decoder/process proof before the staging contract and handler/caller. No accepted production helper or attachment capability; keep #1170 open.
3. Follow the [file-tunnel execution queue](../docs/FILE-TUNNEL.md#next-independently-reviewable-changes): prove standalone storage and bounded-decoder packaging, accept the staging ADR/fixtures, implement durable reservations and direct staging, then add one production client caller. Claude insertion, links, outbound files and relay/native depth each have separate gates. The existing decoder's compiled runtime failed to load; resolve that before upload implementation. Do not duplicate the native developer's work or wait for relay deployment to prepare direct staging.

## Tracks (work outside the milestones)

Labeled by area and prioritized P1 to P3.
Take P1 and P2 items between milestones; P3 items when they are in the way.

- **claude** (the Claude Code harness): #375 (P1, suspend and resume loses input), then #808, #1147, #940, #1189 with #1211, #1137.
- **codex:** #1192 (Guardian reviews), #1187; #1207 waits on an owner decision.
- **web:** #1146, then the P3 list.
- **quality:**
  - #1232: one port helper; it supersedes #1150, #1159 and #1169.
  - #1213, which likely causes the hub-create flake.
  - #1206, the `bun test` hang, capped in CI by #1215.
  - #855, #1191.
- **docs:** #1145, a new notification-flow diagram.
- **backlog:** ideas, not scheduled.

## Owner decisions

Collected in #1233. Decided on 2026-10-06:
- **Release 0.7.16:** yes, once milestone 1 is done.
- **Release automation:** the Bun, npm and Homebrew pipeline stays automated (`release.yml`). The native apps go to TestFlight by pushing the archive directly, the way transit and whisper do; the owner runs the upload (#1240).
- **Mac app distribution:** the App Store if the sandbox allows it; otherwise Developer ID.
- **Minimum OS:** macOS 26 and iOS 26.
- **Capacitor iOS app:** it retires once the same mechanics are designed natively, at X4 parity (#1244).
- **Worktrees:** hub-created worktrees live in `../remi-worktrees`, next to the repository (#1236).
- **Freeze scope:** the file tunnel (#1170) and multiple profiles per session (#1157) join the protocol freeze.
- **Remote and hub posture:** the host passes its default (#1208, #1192).
- **Old epics:** #548 and #885 are closed, their leftovers tracked on their own.

- **Project structure:** the native apps use a checked-in Xcode project with synchronized folders (`packages/native/Remi.xcodeproj`); `packages/macos` keeps xcodegen until it retires.
- **Native apps start now,** in parallel with the protocol freeze.

Still open:
- the push lease: how many days a phone can go without reconnecting before a machine stops pushing to it (#1254; proposed 30);
- whether closing a session deletes its worktree (until decided, it does not);
- Codex typed chat (#1207).

## How every step is tested

- A pin test is committed first, and it must fail; then the fix.
- Each part of a fix is mutation-checked: revert it and a test fails.
- No mocks that replace business logic.
- Gates on every PR:
  - the full `bun test` on Bun 1.4.2 and on the CI-pinned Bun 1.3.11;
  - `bun run typecheck`, `bunx biome check`, `typos`;
  - the macOS `RemiTests` for Swift changes;
  - the integration scripts and browser tests when the daemon wire or the web client changes.
- Each PR gets a Sonnet review, and every finding is fixed or recorded with its reason.
- Owner hardware gates (signed builds, real devices, a deployed Worker) are listed in their milestone and are never claimed as passed without the owner's run (ADR 0011).
