# Card L2-CLI: the `remi keep-awake` command (issue #1773, slice 3)

Status: ready
Tier: worker-hard
Timebox: M, 1 day; escalate at 2 days or two failed approaches
Needs: none (no Xcode, no simulator); macOS host
Depends: L2-HUB; and the profiles plan's PR #1798 (P1A) merged into `develop`, because both add a subcommand to the same lines of `cli/arg-parser.ts`, `cli/help.ts` and `cli.ts` (the manager checks `gh pr view 1798 --repo yooz-labs/remi --json state` shows `MERGED`)
Branch: `feature/issue-1773-keep-awake-cli` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/awake-l2cli` (the manager creates it with `git worktree add --no-track -b` and runs `bun install`)
Plan: plan.md section 2 (L2-CLI); ADR 0050 option (A), "Fail-safe design for level 2" item 4, "Consequences" ("`remi keep-awake` prints how to remove both"), owner question Q1

## Goal

`remi keep-awake` lets the person, at the Mac, see the level 2 state, start, extend and stop a level 2 period through the hub's local endpoint, print the exact owner-installed setup and removal steps, and install or remove the user-level watchdog agent; it never runs `sudo` and never writes outside the person's own remi home and `~/Library/LaunchAgents`.

## Context

Read first, at your base: the merged L2-HUB endpoint (`power/level2-endpoint.ts`, the route beside `/local-secure-push`) and W1's `level2-commands.ts` (`setupText`, `removalText`, `watchdogPlist`, `WATCHDOG_LABEL`) and `watchdog-script.ts` (`buildWatchdogScript`).

What the code does today (`develop` `bbcec7d6`, checked by the lead on 2026-11-17; P1A changes the same lines, so recheck at your base):
- Subcommands are listed in `cli/arg-parser.ts:13-41`; verbs with operands are collected for the subcommands in `SUBCOMMANDS_WITH_ARG_LIST` (lines 63-66), stopping at the first flag that is not in that subcommand's own list (lines 444-459); P1A adds `profile` to both and changes that loop.
- `cli/help.ts` holds one entry list per subcommand (for example `unstick` at lines 269-274).
- `cli/cmd-config.ts` is the model for a testable handler (`runConfigCommand(arg, config, io, paths)`).
- CLI clients find the hub and its token through `cli/daemon-target.ts` (`resolveDaemonWsTarget`) and `auth/capability-token.ts` (`readCapabilityToken`, header `x-remi-capability` at line 38); `cli/capability-client.ts:23-29` builds the header.
- `remi --install` writes the hub's LaunchAgent and runs `launchctl bootout` then `launchctl bootstrap gui/UID PATH` (`cli.ts:600-650`); it is the model for the watchdog's install.
- The owner's answer to Q1 (plan section 6) is in the live facts; this card implements answer (a): level 2 starts only by an explicit action.

## Scope

May change:
- new `packages/daemon/src/cli/cmd-keep-awake.ts`;
- `packages/daemon/src/cli/arg-parser.ts` (`keep-awake` in the subcommand list and in `SUBCOMMANDS_WITH_ARG_LIST`), `cli/help.ts`, and the minimal dispatch lines in `cli.ts`;
- tests under `packages/daemon/tests/cli/` and `packages/daemon/tests/power/`, and a new `packages/daemon/tests/integration/keep-awake-cli.test.ts`;
- `docs/agent-reference/keep-awake.md`;
- the PR body.
Evidence (not committed): `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/L2-CLI/r1/`.
Not in scope: the hub, the endpoint, the controller, configuration keys, the protocol, the apps.

## Decided design

Settled:

1. **Verbs** (positional operands only, so the shared flag loop of `arg-parser.ts` needs no new flag): `remi keep-awake` and `remi keep-awake status`; `remi keep-awake start [HOURS]`; `remi keep-awake extend HOURS`; `remi keep-awake stop`; `remi keep-awake setup`; `remi keep-awake watchdog install`; `remi keep-awake watchdog uninstall`.
   `HOURS` is a whole number; anything else is refused before any request.
   Unknown verbs print the subcommand's help and exit 2.
2. **status, start, extend, stop** POST `{ v: 1, action, hours }` to `http://127.0.0.1:PORT/local-keep-awake` of the hub found by the existing target resolution, with the local capability header, a 5 s timeout; no hub prints `No remi hub is running (start one with remi start).` and exits 1.
   `status` prints, one per line: level 2 state and reason, the configured `level2` value, started and expiry times, battery, thermal, the flag, other apps holding the Mac awake (process names), and the last refusal or revert reason; then three local facts that need no hub and no privileges: whether `/etc/sudoers.d/remi-keep-awake` exists, whether `/Library/LaunchDaemons/com.yooz.remi.keep-awake-boot.plist` exists, and whether the watchdog is loaded (`launchctl print`, the reader from L2-CORE).
   A refused `start` or `extend` prints the reason string and a one-line hint for each reason (for example `watchdog-missing`: run `remi keep-awake watchdog install`), and exits 1.
3. **setup** prints `setupText({ user, remiHome })` and `removalText()` from `level2-commands.ts` for the current user (`os.userInfo().username`; an unsafe name prints the refusal and asks the person to write the rule by hand) and exits 0; it runs nothing.
4. **watchdog install** writes `REMIHOME/keep-awake/watchdog.sh` (mode 0700, atomic) from `buildWatchdogScript({ remiHome })` with the default tools and revert argument (never a test's), writes `~/Library/LaunchAgents/com.yooz.remi.keep-awake-watchdog.plist` (mode 0644) from `watchdogPlist` with `StartInterval` from `watchdog_interval_seconds` and the log at `REMIHOME/keep-awake/watchdog.log`, then runs `launchctl bootout gui/UID/com.yooz.remi.keep-awake-watchdog` (failure ignored, as `--install` does) and `launchctl bootstrap gui/UID PLIST`, and reports the outcome; `watchdog uninstall` runs the bootout and removes both files.
   Both `launchctl` calls go through an `exec` dependency of the handler (default: the real `Bun.spawnSync` of `/bin/launchctl`), so tests record them and never reach launchd.
5. **Help and docs**: `help.ts` lists each verb with one line; `keep-awake.md` gains "Using level 2", the order the owner follows: `remi keep-awake setup` (install the two root pieces by hand), `remi keep-awake watchdog install`, set `[awake] level2 = true` and restart the hub, then `remi keep-awake start`; plus how to remove everything.
The implementer may choose: output wording other than the reason strings and the no-hub line, the handler's internal split, test names.

## Acceptance

Evidence folder: `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/L2-CLI/r1/`.
1. Parser tests: each verb of item 1 parses to `subcommand: 'keep-awake'` with its operands; `remi keep-awake start 2.5`, `start -1`, `extend` without hours and an unknown verb are refused by the handler without a request; `remi profile ...` parsing (P1A's) is unchanged (its tests pass).
2. Through the real CLI entry against a real test hub (`env -i`, temporary `HOME` and `REMI_HOME`, a port from `reserveRange`, `[awake] level2 = true`, precondition `sleepDisabled: 'no'` as in L2-HUB's test): `remi keep-awake status` prints `level2: off` and the three local facts and exits 0; `remi keep-awake stop` with nothing on exits 0; `remi keep-awake setup` prints the exact `sudoersLine` for the test user and the removal commands; with no hub running, `status` prints the no-hub line and exits 1.
   No test sends `start` or `extend` to a hub with the real switch.
3. Handler tests with a recording `exec` and a temporary `HOME`: `watchdog install` writes both files with modes 0700 and 0644, the property list passes `plutil -lint`, the script is byte-identical to `buildWatchdogScript({ remiHome })` with defaults, and the recorded calls are exactly the bootout then the bootstrap with `gui/UID`; `uninstall` records the bootout and removes both files; a failing bootstrap is reported and exits 1.
4. Handler tests against an in-process endpoint over the recording switch (L2-HUB's test setup): `start 2` prints the expiry; each refusal prints its reason and hint and exits 1.
5. `mkdir -p /private/tmp/remi-canon-L2-CLI && env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin TMPDIR=/private/tmp/remi-canon-L2-CLI/ bun test packages/daemon/tests/power packages/daemon/tests/cli packages/daemon/tests/integration/keep-awake-cli.test.ts packages/daemon/tests/integration/keep-awake-level2-hub.test.ts` ends with `0 fail` and no skipped power or keep-awake test on this Mac.
6. Revert checks, each with its failing log and a `revert-index.md` line: build the printed sudoers line from a literal instead of `sudoersLine` (a setup test fails); run `bootstrap` before `bootout` (item 3 fails); accept `start 2.5` (item 1 fails).
7. The PR body states what ships and how a person enables level 2, that the root pieces are installed by the person from printed commands, what is unverified until OG-L2, and "Part of #1773".

## Gates

`bunx biome check .` ends with no errors; `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests` and `bun run typecheck:signaling` pass; `bun scripts/third-party-notices.ts --check` passes; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; Acceptance 5 passes in the canonical environment; hosted CI's `Test worker 0` to `2`, `Test` and the `local-relay` soak pass on the final head.

## Stop conditions

A test or run would call the real `launchctl bootstrap`, `bootout` or anything writing to launchd, or `sudo`; PR #1798 is not merged at your base; the hub's endpoint contract differs from L2-HUB's card; the owner's Q1 answer in the live facts is not (a).

## Report

The preamble's report; one line per acceptance item goes into `report-details.md` in the evidence folder.
