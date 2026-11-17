# Plan: keep-awake level 2 and its guard rails (2026-11)

Lead: Claude Opus, 2026-11-17.
Status: written on the owner's instruction of 2026-11-17 ("write the level 2 cards, and start working on it"); the first cards are dispatchable now, the owner questions of section 6 are open.
Issue: #1773 (reopened by the owner on 2026-11-17: PR #1782 closed it by a commit message; level 2 and the guard rails were not built).
Pack: `.context/awake-level2-2026-11/` on branch `docs/issue-1773-awake-level2-plan` (worktree `/Volumes/S1/worktrees/remi/awake-l2-plan`), never on `develop`.
Decisions this plan does not reopen: ADR 0050 (`.context/decisions/0050-keep-the-mac-awake.md`), accepted as the direction with the owner's eight decisions of 2026-11-14.

## Summary

**Goal.** Ship ADR 0050 slice 2 (guard rails: power readings, the lease and watchdog, the level 1 battery floor) and slice 3 (level 2, the lid-closed mode through one exact sudoers rule), tested without privileges wherever possible, then verified on the owner's MacBook by the owner.

**Order.** Guard rails first, then level 2.
Dispatchable now (no privileges, no file shared with any open PR): G0, G1, W1 and L2-POL; the owner can run OG-CAP now.
G2 (the battery floor) follows G1 and OG-CAP; level 2 (L2-CORE, L2-HUB, L2-CLI) follows the lead's checkpoint CP-L2; the owner's hardware gate OG-L2 closes it; the phone surface (L2-APP) and, only if needed, the third sudoers rule (L2-SLEEPNOW) are outlines completed at CP-HW.

**Least sure about.**
1. Whether `disablesleep 0` with the lid already closed makes the Mac sleep (ADR 0050 line 103, UNVERIFIED and load-bearing).
   Only OG-L2 step (b) can tell; if it does not, the fallback is the `pmset sleepnow` rule (owner decision 6, card L2-SLEEPNOW).
2. Whether any read-only source reports the password-on-wake setting without a password (G0).
   If none does, level 2 refuses to start unless the owner sets `require_password_on_wake = false`, which decision 7 makes the owner's call.
3. The laptop formats: the `pmset -g batt` battery line, `AppleClamshellState` and the assertions of a video and a call are unverified until OG-CAP; G2 and L2-CORE stop rather than guess.
4. The idle revert's signal: the hub reads each session's `sessionStatus` and pending questions, and a turn that only reasons reads `idle` there (ADR 0050 line 109); with a 30-minute default this should be rare, but it is not measured.
5. Capacity: these steps share the owner's slots and reviewers with the profiles plan, whose daemon lane (P1A in review as PR #1798, P1B next) touches `config.ts` and `cli.ts`.
6. Coverage: every macOS power test is skipped by hosted CI (Ubuntu); the workers' local runs and DV-AWAKE are their only authority.
7. The crash rail's own integrity: the pack review found that the watchdog could watch the wrong remi home, hang on a child command, or be unable to revert under an edited sudoers rule; the cards now check the watchdog's identity on every heartbeat, give its commands deadlines and check the revert permission before every enable, but none of it runs on hardware before OG-L2 (b0), (b1) and (b).

## 0. How the manager uses this plan

### 0.1 Start prompt

```text
You are the manager of yooz-labs/remi awake-level2-2026-11.
Run one tick of the profiles runbook pinned at commit e18eac02 (read it with `git -C /Volumes/S1/worktrees/remi/profiles-epic-plan show e18eac02:.context/profiles-epic-2026-11/runbook.md`), exactly as written, with the deltas in section 0.2 of /Volumes/S1/worktrees/remi/awake-l2-plan/.context/awake-level2-2026-11/plan.md, using the project:manager-loop skill.
The state is the board at /Volumes/S1/worktrees/remi/awake-l2-plan/.context/awake-level2-2026-11/board.md.
Your manager id is mba-claude-sonnet, the same on every tick.
Do not write product code.
Do not change the plan, a card, a gate, the parity, or a budget limit.
When the runbook says to stop or to ask, or does not cover what you see, record it on the board, ask the owner with a structured question, and stop that thread of work.
```

The profiles manager may instead run this pack from its own loop; the deltas are the same.

### 0.2 Deltas from the profiles runbook

Apply the pinned profiles runbook's sections 4, 5, 6, 10, 12 and 13; from section 7, items 1, 3, 4 and 5; from section 8, the Order rule, the checkpoint paragraph of "Rule steps" (as item 8 below says) and the Outline steps rule.
Do not apply: sections 1 to 3 and 11 (profiles-only), section 7 item 2 (this pack has no `lead.md`; the lead records its decisions with `decide --by lead`), section 8's "Not before approval" (this plan has no CP0: the owner's instruction of 2026-11-17 is the approval to dispatch the ready cards), its J-questions, parked steps, native lane, docs lane and phase-completion rules, section 9's `lead.md` format (the lead brief is in section 4 below), and merge gate item 6 (profiles step extras; items 7 and 8 below replace it).
These changes apply:
1. **Board, first tick.** Before section 7 item 1's `MB tick`, run `MB init BOARD --title "Keep-awake level 2 (awake-level2-2026-11)" --plan PACK/plan.md --repo yooz-labs/remi --branch develop`, then add the steps of section 2 in that order with their tiers, Depends and timeboxes (`MB set BOARD Steps ID ... --new`), and commit `board.md` and `board-log.md` on this pack's branch only (never on `develop`).
   Copy the Parity rows from the profiles board; copy its Slots rows with `codex-terra` at Max 0 (Q6: `codex-terra` stays with the profiles daemon lane); copy its Budget rows with Used 0.
   States at start: G0, G1, W1 and L2-POL `todo`; OG-CAP `owner` (send the owner the OG-CAP section of [owner-gates.md](owner-gates.md) on this first tick); G2, L2-CORE, L2-HUB and L2-CLI `todo` behind their Depends; CP-L2, OG-G2, OG-L2 and CP-HW `blocked` with their trigger in Next; L2-SLEEPNOW and L2-APP `outline`.
   Record Q1 to Q8 with `MB ask BOARD QN --question TEXT --options OPTIONS --default none`, using the short "Ask text" and "Options" of section 6, and ask Q1 to Q4 in the first batch (they gate the earliest merges), then Q5 to Q8.
2. **Paths.** Wherever the profiles runbook says `PACK`, `BOARD` or `EVID`, read `PACK` as `/Volumes/S1/worktrees/remi/awake-l2-plan/.context/awake-level2-2026-11`, `BOARD` as `PACK/board.md` and `EVID` as `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/STEP/rROUND/`; `MAIN` and `MB` keep their meaning.
   Cards and preamble: this pack's `cards/`; evidence root `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/` (replace the profiles artifacts root in the Codex `writable_roots`); worktrees and branches as each card names them, created with `git -C "$HOME/Documents/git/yooz/remi" fetch origin && git -C "$HOME/Documents/git/yooz/remi" worktree add --no-track -b BRANCH WT origin/develop`, then `cd WT && bun install`.
3. **Platform.** G1, G2, L2-CORE, L2-HUB and L2-CLI run real `pmset -g`, `ioreg`, `notifyutil`, `launchctl print` and `caffeinate` in tests: dispatch them on Claude slots when one is free; on Codex, a sandbox denial in the log is handled by the profiles runbook's full-access rule.
4. **After every worker run**: the profiles checks 1 to 3, where a merge into `develop` or an issue closing done by the profiles manager (a PR or issue named on `/Volumes/S1/worktrees/remi/profiles-epic-plan/.context/profiles-epic-2026-11/board.md` or its `board-log.md`) counts as a merge or closing the manager made, and check 2 pauses this plan's dispatching instead of profile steps.
   Also record at dispatch and compare after the run: (a) `ioreg -r -c IOPMrootDomain -d 1 | grep '"SleepDisabled"'`, which must print `"SleepDisabled" = No`; (b) `ls -l /etc/sudoers.d/remi-keep-awake /Library/LaunchDaemons/com.yooz.remi.keep-awake-boot.plist "$HOME/Library/LaunchAgents/com.yooz.remi.keep-awake-watchdog.plist" 2>&1`; (c) `launchctl print "gui/$(id -u)/com.yooz.remi.keep-awake-watchdog" >/dev/null 2>&1; echo $?`.
   Any change in (a) to (c) stops all dispatching of this plan and goes to the owner at once.
5. **Live facts** (profiles runbook section 6) add, for L2-CORE, L2-HUB and L2-CLI, the `CP-L2:` decision lines and the owner's answers to Q1 to Q3; for L2-CLI, the state of PR #1798.
6. **Merge gate** (profiles runbook section 10).
   Item 3, fresh base, as the owner relaxed it on 2026-11-17 (profiles `board-log.md`, Decisions): commits that `develop` gained since a PR's checks ran count as a fresh base when they are docs-only files or version bumps (merge commits of docs-only PRs included) or `config/app-release.json`; any code, config, workflow or test change on `develop` still makes the worker merge `origin/develop` and the checks rerun.
   Item 6 is replaced by item 7: the manager reruns the card's canonical-environment `bun test` command from its Acceptance in the step's worktree at the final head, and it ends with `0 fail` and no skipped test under `packages/daemon/tests/power/` or in a `keep-awake-*` test.
   Item 8: the owner answers a card names for its merge are recorded (L2-POL: Q1, Q2 and Q3; G2: Q2 and Q4).
7. **After a merge**: DV-AWAKE (`cards/DV-awake-develop-verify.md`) replaces DV for every merge of a PR that changes `packages/`; G0 (a `.context` note only) needs none.
   Before the first DV-AWAKE, create its worktree once: `git -C "$HOME/Documents/git/yooz/remi" fetch origin && git -C "$HOME/Documents/git/yooz/remi" worktree add --detach /Volumes/S1/worktrees/remi/awake-develop-verify DEV_SHA && cd /Volumes/S1/worktrees/remi/awake-develop-verify && bun install --frozen-lockfile`.
   DV-AWAKE is an agent row (`DV-AWAKE-PR`), not a Steps row, as the profiles board runs DV.
8. **Rule steps.** OG-G2 and OG-L2 are set `owner` when their Depends are done, and the owner gets that section of [owner-gates.md](owner-gates.md); the owner's result is recorded with `decide ... --by owner`, then the gate is `done` (passed) or the lead is woken (failed).
   CP-L2 and CP-HW follow the runbook section 8 checkpoint paragraph without J-questions: wake the lead with the brief of section 4; when `board-log.md` holds the lead's `CP-L2:` (or `CP-HW:`) line, run the anticipation pass, then `MB ask BOARD QCP-L2 --question "CP-L2: go for level 2 (L2-CORE, L2-HUB, L2-CLI)?" --options "Go (Recommended) / Hold" --default none --step CP-L2` (for CP-HW: `QCP-HW`, "CP-HW: go for the cards the lead completed?"); on "Go", `MB decide BOARD "CP-L2: owner go" --by owner` and set the checkpoint `done`.
   The lead sets the cards it completed from `outline` to `todo` with `MB set`.
9. **Owner answers** (replacing section 11): `MB decide BOARD "QN answered: ANSWER" --by owner` and set the question `closed`; when the answer differs from the section 6 recommendation, wake the lead before dispatching or merging anything that question blocks.
10. **Conditions outside the board's Depends**, written in each step's Next: CP-L2 wakes the lead only when Q1 to Q3 are `closed`; L2-CLI is dispatched only when `gh pr view 1798 --repo yooz-labs/remi --json state --jq .state` prints `MERGED`; L2-POL and G2 merge only under item 6's gate item 8.

### 0.3 Precedence

The owner's later instructions override this plan and are logged with `decide ... --by owner`.
`AGENTS.md` overrides this plan, with the profiles plan's exception 1 (never rebase a pushed branch; merge `origin/develop` instead).
ADR 0050 and the owner's decisions in it are final; a card never reopens them; a gap is an owner question (section 6).

### 0.4 Merge authority

As in the profiles plan section 0.4 (the owner's authority of 2026-11-13): the manager merges a step PR into `develop` with `gh pr merge N --repo yooz-labs/remi --merge --match-head-commit SHA` only when the merge gate passes; never `main`, never a release, never a force-push.
Never merged by the manager: a PR that relaxes a gate's assertion (to the lead), L2-POL or G2 before their owner answers (gate item 8).

### 0.5 Question classes that may take a default

None.
Silence is never an answer.

### 0.6 Routing and capacity

Roles and models as in the profiles plan section 0.6.
These steps share the owner's slots and budget with the profiles plan (Q6).
Slots: before each implementer dispatch, run `MB status` on both boards and dispatch only when the slot's active implementers on both boards together are below its Max on the profiles board; worker-hard steps of this plan go to `claude-opus` (this board's `codex-terra` is Max 0), worker steps to `codex-luna` or `claude-sonnet`.
Budget: every dispatch spends on both boards (`MB spend` on this board's row and on the same row of the profiles board); a refusal on either board stops dispatching on that row and asks the owner.
Reviewers and DV are extra to the slots, as in the profiles plan.

## 1. Inputs, verified on `develop` `bbcec7d6` (0.9.1-dev.4, 2026-11-17)

- ADR 0050 in full, including the table of keys (lines 162-185) and owner decision 8 (every tunable is a key; a key lands with the slice that uses it).
- Level 1 as shipped by PR #1782: `packages/daemon/src/power/awake-policy.ts`, `awake-session.ts`, `awake-holder.ts`, `awake-wiring.ts`; tests in `packages/daemon/tests/power/` and `packages/daemon/tests/integration/keep-awake-daemon-smoke.test.ts`; `docs/agent-reference/keep-awake.md`; the 0.9.0 changelog bullet (`CHANGELOG.md:7`).
- `[awake]` validation: `validateAwakeTable` refuses any key outside `level1`, `question_hold_minutes`, `idle_grace_seconds`, `stuck_busy_minutes`, `ttl_minutes` (`packages/daemon/src/config/config.ts:458-478`), and an invalid config makes every `remi` command exit 1 at load (`cli.ts:396-403`; only `migrate-permissions` runs before it); `deepMerge` drops a key missing from the defaults (`config.ts:327-336`); so a `level1_battery_floor_percent` line in `config.toml` makes every `remi` command exit 1 today (`packages/daemon/tests/power/awake-config.test.ts:87-91` asserts the refusal), and preamble item 9 makes every new key land whole, in one commit.
- Hub facts: `serveMode` (`cli.ts:475`), the live-sessions registry (`cli.ts:778`, `session/session-registry-file.ts:278`), `performCleanup` (`cli.ts:3219`), the `exit` listener (`cli.ts:1760`), the daemon-mode signal handlers (`cli.ts:3692-3703`; SIGUSR1 reload, SIGUSR2 unstick), `remi stop`'s 5 s (`cli/daemon-manager.ts:470`), the local-only endpoint precedent `/local-secure-push` (`server/websocket-server.ts:343-354`, `server/peer-helpers.ts:43-53`).
- This Mac (Mac mini Mac16,11, macOS 27.2 build 26B123), read-only, 2026-11-17: `pmset -g batt` prints only `Now drawing from 'AC Power'`; `ioreg -r -c AppleSmartBattery -d 1` shows `"BatteryInstalled" = No`; `"SleepDisabled" = No`; no `AppleClamshellState`; thermal pressure level 0; `plutil -extract KEY raw` reads JSON fields; `ps -o lstart=` gives a comparable start time.
- CI: every job in `.github/workflows/ci.yml` runs on `ubuntu-latest`; `local-relay` (`relay-r7.yml`) runs the soak for daemon PRs.
- Open PRs on 2026-11-17: #1798 (profiles P1A: `config.ts`, `cli.ts`, `cli/arg-parser.ts`, `cli/help.ts`, `AGENTS.md`, `pty-child-env-secrets.test.ts`), drafts #1799 (CI optimization, docs) and #1802 (message board, docs).

## 2. Steps

Board order is dispatch priority.

| ID | Card | Goal | Tier | Depends | Timebox | Acceptance gate (literal) |
| --- | --- | --- | --- | --- | --- | --- |
| G0 | [G0](cards/G0-password-on-wake.md) | settle the read-only source of the password-on-wake setting | worker | - | 3h | the note has five sections with every command's quoted output; `typos .context/awake-password-on-wake.md` clean; only that file changed |
| G1 | [G1](cards/G1-power-readings.md) | parsers and bounded readers for assertions, thermal pressure and the root domain | worker | - | 1d | `env -i ... bun test packages/daemon/tests/power/readings` (canonical) ends `0 fail`, no skip on this Mac; every item of the card |
| W1 | [W1](cards/W1-lease-and-watchdog.md) | root-boundary constants, the lease, the watchdog script and property lists, tested without privileges | worker-hard | - | 1d | `env -i ... bun test` of the three W1 test files (canonical) ends `0 fail`, no skip; every item of the card |
| L2-POL | [L2-POL](cards/L2-POL-level2-policy.md) | the pure level 2 reducer, settings validator and foreign-holder classifier; merges only after Q1, Q2 and Q3 are answered | worker-hard | - | 1d | `env -i ... bun test` of the three L2-POL test files (canonical) ends `0 fail`; every item of the card |
| OG-CAP | rule | the owner's MacBook captures in seven states | owner | - | 30m | [owner-gates.md](owner-gates.md) OG-CAP recorded; the seven folders exist under `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/captures/OG-CAP/` |
| G2 | [G2](cards/G2-level1-battery-floor.md) | the level 1 battery floor; `level1_battery_floor_percent` and `battery_check_seconds` supported; merges only after Q2 and Q4 are answered | worker-hard | G1, OG-CAP | 1d | `env -i ... bun test packages/daemon/tests/power packages/daemon/tests/integration/keep-awake-daemon-smoke.test.ts` (canonical) ends `0 fail`, no skip; every item of the card |
| OG-G2 | rule | the owner checks the floor on the MacBook | owner | G2 | 30m | owner-gates.md OG-G2 recorded |
| CP-L2 | rule | lead checkpoint before level 2; starts only when Q1 to Q3 are also answered | lead | G0, G1, W1, L2-POL, G2, OG-CAP | - | a `decide` line starting `CP-L2:` (section 4) |
| L2-CORE | [L2-CORE](cards/L2-CORE-switch-and-controller.md) | the switch and the hub's controller, not wired | worker-hard | CP-L2 | 1.5d | `env -i ... bun test packages/daemon/tests/power` (canonical) ends `0 fail`, no skip; every item of the card |
| L2-HUB | [L2-HUB](cards/L2-HUB-config-and-hub.md) | level 2 keys, hub ownership, exit reverts, the local endpoint | worker-hard | L2-CORE | 1.5d | the card's Acceptance 6 command ends `0 fail`, no skip; every item of the card |
| L2-CLI | [L2-CLI](cards/L2-CLI-keep-awake-command.md) | `remi keep-awake` status, start, extend, stop, setup, watchdog; dispatched only once PR #1798 shows `MERGED` | worker-hard | L2-HUB | 1d | the card's Acceptance 5 command ends `0 fail`, no skip; every item of the card |
| OG-L2 | rule | the owner's setup and hardware tests (a) to (h) | owner | L2-CLI | 2h | owner-gates.md OG-L2 recorded |
| CP-HW | rule | lead checkpoint after the hardware tests | lead | OG-L2 | - | a `decide` line starting `CP-HW:` |
| L2-SLEEPNOW | outline | the third exact rule, only if OG-L2 (b) failed | worker-hard | CP-HW | 6h | completed at CP-HW |
| L2-APP | outline | the phone surface: status, `allow_phone`, start and stop (web first) | worker-hard | CP-HW | 2d | completed at CP-HW |

Reviewer cards: [RV-panel](cards/RV-panel.md) and [RV-delta](cards/RV-delta.md).
After each code merge the manager dispatches [DV-AWAKE](cards/DV-awake-develop-verify.md) (worker, 1 hour) as an agent, not as a board step, the way the profiles board runs DV.
Board states at start: G0, G1, W1, L2-POL `todo`; OG-CAP `owner`; G2 `todo` behind G1 and OG-CAP; CP-L2, OG-G2, OG-L2 and CP-HW `blocked`; L2-CORE, L2-HUB, L2-CLI `todo` behind their Depends; L2-SLEEPNOW and L2-APP `outline`.

```text
now          G0 ─────────────┐
             G1 ──┬──────────┤
             W1 ──┼──────────┤
             L2-POL ─────────┤ (merge after Q1 to Q3)
owner        OG-CAP ─┐       │
                     G2 ─────┤ (merge after Q2, Q4) ── OG-G2
                             CP-L2 (+ Q1) ── L2-CORE ── L2-HUB ── L2-CLI (+ #1798 merged) ── OG-L2 ── CP-HW ─┬─ L2-SLEEPNOW (if needed)
                                                                                                              └─ L2-APP
```

### Files and collisions

| Step | Files it changes |
| --- | --- |
| G0 | `.context/awake-password-on-wake.md` |
| G1 | new `packages/daemon/src/power/readings/` (`run-reading.ts`, `assertions.ts`, `thermal.ts`, `root-domain.ts`), new tests and fixtures under `packages/daemon/tests/power/`, `docs/agent-reference/keep-awake.md` |
| W1 | new `packages/daemon/src/power/level2-commands.ts`, `level2-lease.ts`, `watchdog-script.ts`, new tests and fixtures, `docs/agent-reference/keep-awake.md` |
| L2-POL | new `packages/daemon/src/power/level2-settings.ts`, `level2-policy.ts`, `level2-foreign-holders.ts`, new tests, `docs/agent-reference/keep-awake.md` |
| G2 | new `power/readings/battery.ts`; `power/awake-policy.ts`, `awake-session.ts`, `awake-wiring.ts`; the `[awake]` parts of `config/config.ts`; tests; `keep-awake.md`, `AGENTS.md:248`, ADR 0050 (status line, one table row) |
| L2-CORE | new `power/level2-switch.ts`, `level2-controller.ts`, `level2-census.ts`, `level2-readings.ts`, `readings/screen-lock.ts`, `readings/launchd.ts`; `readings/run-reading.ts`, `readings/assertions.ts` (if needed), `level2-commands.ts` (one constant); tests; `keep-awake.md` |
| L2-HUB | the `[awake]` parts of `config/config.ts`; `cli.ts` (hub construction, cleanup, `exit` listener, handler); `server/websocket-server.ts`, `adapters/websocket-adapter.ts`, `adapters/connection-adapter.ts`; new `power/level2-endpoint.ts`; tests; `keep-awake.md`, `AGENTS.md:248`, ADR 0050 |
| L2-CLI | new `cli/cmd-keep-awake.ts`; `cli/arg-parser.ts`, `cli/help.ts`, dispatch lines in `cli.ts`; tests; `keep-awake.md` |

| Pair | Shared | Rule |
| --- | --- | --- |
| G1, W1, L2-POL | `keep-awake.md` (each adds a section) | may run together; the second and third to merge take `origin/develop` in and keep every section |
| G1, G2 | `power/readings/` | G2 after G1 (Depends) |
| G2, P1A (#1798) | `config/config.ts` (P1A: imports, `RemiConfig`, `DEFAULT_CONFIG` above `awake`, `deepMerge`, the `loadConfigWithNotices` split, the generated header; G2: the `[awake]` parts), `AGENTS.md` (P1A adds a line three lines above line 248) | may run together; the second to merge takes `origin/develop` in, keeps both, reruns its gates |
| L2-HUB, P1B | `cli.ts` (P1B: the launch paths; L2-HUB: hub construction, cleanup, `exit` listener) | may run together; the second to merge takes `origin/develop` in, reruns its gates and its smoke tests |
| L2-HUB, G2 | `config/config.ts` `[awake]` | L2-HUB after G2 (through CP-L2) |
| L2-CLI, P1A | `cli/arg-parser.ts` (the subcommand list, `SUBCOMMANDS_WITH_ARG_LIST`, the operand loop P1A rewrites), `cli/help.ts`, `cli.ts` dispatch | L2-CLI only after #1798 merged (section 0.2 item 9) |
| L2-APP, profiles P2B, P2C, P3B, P4A, P4B | `packages/shared/src/protocol.ts`, `protocol-version.ts`, `cli/capabilities.ts`, the fixture builders | never `active` together; the second to merge regenerates fixtures |
| any step, `pty-child-env-secrets.test.ts` | an upper-case string literal under `packages/daemon/src` containing SECRET, TOKEN, PASSPHRASE, PASSWORD or PRIVATE_KEY fails it (lines 116-129); `require_password_on_wake` is lower case and does not | no step needs that file; a step that does stops and reports |

## 3. Review policy, merge gate and hosted checks

Every PR follows `project:pr-review-toolkit`'s `review-convergence.md`: round 1, an optional delta round (RV-delta), never a third; every finding fixed or rejected with a reason, none deferred.

| Step | Round 1 lenses ([RV-panel](cards/RV-panel.md)) |
| --- | --- |
| G0 | `docs` |
| G1 | `contract`, `verification`, `privacy` |
| W1 | `contract`, `verification`, `privilege`, `failsafe` |
| L2-POL | `contract`, `verification`, `failsafe` |
| G2 | `contract`, `verification`, `maintainability`, `failsafe` |
| L2-CORE | `contract`, `verification`, `privilege`, `failsafe` |
| L2-HUB | `contract`, `verification`, `privilege`, `failsafe`, `maintainability` |
| L2-CLI | `contract`, `verification`, `privilege`, `maintainability` |

A finding on a `privilege` or `failsafe` path that the implementer contests goes to the advisor before any fix; a fix round with an accepted `privilege` or `failsafe` finding is worker-hard.
Merge gate: section 0.2 item 6.
Hosted checks on the final head (profiles runbook section 10, merge gate item 4): `CI Scope`, `Lint`, `Type Check`, `Test` (and `Test worker 0` to `2`), `Spelling`, `Relay Scope` and `local-relay`; every step except G0 changes `packages/daemon/`, so `local-relay` must be the real soak (more than 3300 seconds, about 65 minutes per head).
None of these runs a darwin-only test, hence gate item 7 and DV-AWAKE.

## 4. Checkpoints and owner gates

**CP-L2** (the lead, when G0, G1, W1, L2-POL and G2 are merged, OG-CAP is recorded and Q1 to Q3 are answered): read G0's note, the OG-CAP folder list and the answers; re-verify every path and line that L2-CORE, L2-HUB and L2-CLI cite on the current `develop` (P1A and P1B move `config.ts` and `cli.ts`); edit those cards where an answer, G0's result or the code changed; run `manager_board.py card` on them; record `CP-L2: ...` with `decide --by lead`.
If G0 is "not settled", the decision line says that level 2 will refuse until the owner sets `require_password_on_wake = false` and asks the owner whether to proceed.
**CP-HW** (the lead, after OG-L2): read the owner's OG-L2 record; decide whether L2-SLEEPNOW is needed (step (b)); complete L2-APP (and L2-SLEEPNOW if needed); file issues for any failed step; record `CP-HW: ...`.

Lead brief for a checkpoint or an escalation (one message; `MB` is `python3 $HOME/.claude/plugins/cache/research-skills/project/0.12.0/skills/manager-loop/scripts/manager_board.py`):

```text
You are the lead of yooz-labs/remi awake-level2-2026-11 (read-only for product code).
Read first: /Volumes/S1/worktrees/remi/awake-l2-plan/.context/awake-level2-2026-11/plan.md sections 2 to 6, then `MB status BOARD`, then only what this wake names.
Wake reason: CP-L2, CP-HW or the event, with links.
Decide, then: edit cards or the plan only where the decision requires it, in one commit on docs/issue-1773-awake-level2-plan; re-verify every path and line a card you complete cites against the current origin/develop; run `MB card` on each completed card; record each decision with `MB decide BOARD "TEXT" --by lead`.
Do not dispatch, merge, or edit the board's Parity, Slots or Budget.
```
**Owner gates** ([owner-gates.md](owner-gates.md)): OG-CAP (now, about 30 minutes), OG-G2 (after G2), OG-L2 (after L2-CLI: setup with the owner's own `sudo`, then tests (a) to (h)).
No agent installs the sudoers file, the boot daemon or (on the owner's machine) the watchdog, and no agent runs `sudo`, a power-changing `pmset` or a writing `launchctl`.

## 5. Risks

| ID | Risk | Read by | If it reads bad | Who decides |
| --- | --- | --- | --- | --- |
| R1 | `disablesleep 0` with the lid closed leaves the Mac awake | OG-L2 (b) | L2-SLEEPNOW at CP-HW (owner decision 6) | lead, owner |
| R2 | no read-only password-on-wake source | G0 | level 2 refuses unless `require_password_on_wake = false`; ask the owner at CP-L2 | owner |
| R3 | a reading's format differs on the MacBook | OG-CAP, G2, L2-CORE | the card stops; the lead adapts the parser rule at CP-L2 | lead |
| R4 | a test reaches the real switch, `sudo` or `launchctl` | every review (`privilege`), the after-run check of section 0.2 item 4 | stop all dispatching; ask the owner | owner |
| R5 | an unknown `[awake]` key on an older binary (a downgrade, or a config copied to the MacBook's older remi) stops every `remi` command | Q4 | as answered | owner |
| R6 | two remi homes on one Mac see each other's level 1 holders as another app's and refuse level 2 | OG-L2 setup | documented in L2-HUB's docs; the ignore list or idle sessions avoid it | lead |
| R7 | collisions with the profiles daemon lane slow both | each merge | the merge-second rule of section 2 | manager |
| R8 | a release ships level 2 code before OG-L2 | Q7 | as answered | owner |
| R9 | the crash rail itself fails: the watchdog watches another remi home, hangs, or cannot revert | L2-CORE tests 2k and item 1, W1 item 5, OG-L2 (b0), (b1), (b) | a fix card before any release that enables level 2 | lead, owner |

## 6. Owner questions

Each has the lead's recommendation; the cards follow it, and a different answer makes the lead correct the card before dispatch or merge.

| ID | Question | Blocks | Recommendation |
| --- | --- | --- | --- |
| Q1 | How does a level 2 period start? (a) only by an explicit action: `remi keep-awake start [HOURS]` at the Mac now, the phone later (L2-APP); (b) armed: with `level2 = true` the hub turns it on at the first real work and keeps it for `level2_default_hours`, and after any revert it stays off until an explicit start | CP-L2, merge of L2-POL | (a): the smallest root use and an explicit action at the Mac for each period (any process of the same user, the agent included, can take that action too, as ADR 0050's threat model says); the phone cannot start it after the lid closed anyway, because the Mac is asleep by then |
| Q2 | Do the battery limits apply only on battery power: the level 1 floor (decision 3 is "Level 1 on battery") and level 2's start, revert and time limits, with AC power exempt and unplugging below a limit acting at the next check? | merges of G2 and L2-POL | Yes |
| Q3 | Level 2 on a Mac with no battery (a desktop): refuse (`no-battery`), or allow? | merge of L2-POL | Refuse: a desktop has no lid, and level 1 covers idle sleep |
| Q4 | An unknown `[awake]` key: keep stopping every `remi` command at config load (today's rule; it also catches a typo in a safety limit), or warn and ignore the keys ADR 0050 names that this build lacks? | merge of G2 | Keep it; every key lands whole (preamble item 9), and the error names the key and the file |
| Q5 | ADR 0050 gives level 1 no total time limit (only the question cap and the stuck bound); add one? | none (CP-L2) | No: an agent with real work should keep its Mac awake; the lid, the battery floor and the stuck bound bound it |
| Q6 | Capacity: run this plan beside the profiles plan on the same slots, worker-hard steps on `claude-opus` and worker steps on `codex-luna` or `claude-sonnet`, with this board's budget rows copied from the profiles board? | none (applied as recommended until answered) | Yes |
| Q7 | Release: may a release contain L2-HUB and L2-CLI before OG-L2 passed? (a) yes, with `level2` off by default and `remi keep-awake setup` and the docs marked experimental and unverified until CP-HW removes the mark; (b) hold every release that contains them until OG-L2 (b) passed, which also holds the profiles releases; (c) the owner runs OG-L2 on a build of the reviewed, unmerged L2-CLI branch stacked on L2-HUB, and both merge after it passes | L2-CLI's merge | (a): honest marking keeps releases moving; nothing turns level 2 on without the owner's own sudo setup |
| Q8 | ADR 0050 decision 4 records 35 percent (start) and 30 percent (revert) as level 2's defaults, while the issue comment of 2026-11-14 called that reading "awaiting the owner's confirmation": confirm them? | none (L2-HUB's defaults) | Yes; both are configurable |

Short texts for `MB ask` (each under 200 characters):

| ID | Ask text | Options |
| --- | --- | --- |
| Q1 | Q1: How does a level 2 period start? (a) only by an explicit start (remi keep-awake start now, the phone later); (b) armed by level2 = true at the first real work | (a) explicit start (Recommended) / (b) armed |
| Q2 | Q2: Do the battery limits (level 1 floor; level 2 start, revert and time limits) apply only on battery power, with AC power exempt? | Yes (Recommended) / No, also on AC |
| Q3 | Q3: Level 2 on a Mac with no battery (a desktop): refuse it or allow it? | Refuse (Recommended) / Allow |
| Q4 | Q4: An unknown [awake] key: keep stopping every remi command at config load, or warn and ignore ADR 0050 keys this build lacks? | Keep stopping (Recommended) / Warn and ignore |
| Q5 | Q5: Add a total time limit to level 1? ADR 0050 gives it only the question cap and the stuck bound. | No (Recommended) / Yes |
| Q6 | Q6: Run this plan beside the profiles plan on shared slots and budget, worker-hard steps on claude-opus, codex-terra left to the profiles lane? | Yes (Recommended) / Other |
| Q7 | Q7: May a release contain level 2 (off by default, marked experimental) before the MacBook gate OG-L2 passes, or hold such releases? | (a) ship marked experimental (Recommended) / (b) hold releases / (c) gate an unmerged branch |
| Q8 | Q8: Confirm ADR 0050's level 2 battery defaults: refuse to start below 35 percent, revert at 30 percent (both configurable)? | Yes (Recommended) / Other values |

Lead decisions under ADR 0050 decision 8 (every tunable is a key), which the owner may override: two keys the ADR's table lacks, `battery_check_seconds` (default 60, G2) and `lease_stale_seconds` (default 120, the ADR's "heartbeat older than 120 s", L2-POL and L2-HUB); `level1_battery_floor_percent = 0` turns the floor off; the level 2 battery revert rule needs a time estimate only when one is shown; level 2 refuses to start without the watchdog loaded; the password setting and the watchdog are checked at start and extend only; the Mac-side controls use a local-only HTTP endpoint on the hub (the `/local-secure-push` gate), not new protocol messages, so no protocol change happens before L2-APP; the idle revert counts a session as working from level 1's own `awakeHold` verdict, published in its status file (so it inherits the question cap and the stuck bound); remi's processes are the hub, the live sessions and all their descendants (a narrowing of "remi's process tree": a shared process such as Codex's app-server is foreign); level 1 keeps a `none` battery reading for the daemon's lifetime and releases a hold only after two consecutive unknown readings (fail toward sleep, without dropping a turn on one slow read); the watchdog's identity (this remi home's script, this build's bytes) is checked at start, extend and every heartbeat; sleep is never turned off unless `sudo -n -l` shows the revert command is allowed; the printed setup stages root content only in a root-owned directory.

## 7. What ADR 0050 assigns where (for the "time limits" question)

Slice 2 (guard rails) has one key, `level1_battery_floor_percent`, plus the readings, the watchdog script with its dry-run tests and the password-on-wake read (ADR 0050 lines 144 and 158); this plan adds `battery_check_seconds` under decision 8.
Level 1's time limits, the question cap and the stuck bound, shipped in slice 1; level 1 has no per-session or total time limit (Q5).
Level 2's time limits (`level2_default_hours`, `level2_cap_hours`, `level2_idle_revert_minutes`, `thermal_moderate_revert_minutes`, `foreign_holder_revert_minutes`) are slice 3 (L2-POL, L2-HUB).
`allow_phone` is slice 4 (L2-APP).
Linux (`systemd-inhibit`) is out of scope (ADR 0050 line 137).

## Appendix A: pack review (2026-11-17)

Two fresh reviewers read the pack before the first dispatch: an executability reviewer (Sonnet) and a design and safety reviewer (Opus).
Every finding was accepted; none was rejected.

Executability, fixed in commit `181757ae`: checks 1 and 3 would stop on the profiles manager's merges (0.2 item 4); the checkpoint go flow and owner answers were undefined (0.2 items 8 and 9); the board could not be built literally (0.2 item 1, `30m` timeboxes, DV out of the Steps table, short ask texts); the relaxed fresh-base rule was not written where the manager reads (0.2 item 6) and the runbook was not pinned (0.1, commit `e18eac02`); G0's stderr answer had no runner path (G1 `captureStderr`); shared slots and budget were unenforceable (0.6); DV-AWAKE's worktree was never created (0.2 item 7); `launchctl` had no constants (W1 `LAUNCHCTL_PATH`, L2-CLI argv builders and guard scan); test `AwakeConfig` literals would break typecheck (G2, L2-HUB); whole test directories in gates (L2-CLI names its files; L2-HUB's hub starts under `env -i`); OG-CAP's first-tick trigger, `init` before `tick`, `stop` while off (L2-POL); one wrong citation (G2).

Design and safety, fixed in the next commit: the watchdog was not bound to its remi home (identity check at start, extend and every beat; `watchdog uninstall` refuses with a lease; OG-L2 reinstalls from the daily home); the revert permission was never checked (`sudoListArgv` before every enable; setup checks both commands; removal stops first and ends with the owner's own revert); the printed setup staged root content in user-writable files (root-owned `sudo mktemp -d` staging); OG-L2 (b) could pass for the wrong reason (the level 1 holder is checked before the kill, the pass needs a Sleep entry after the revert, (b') without an idle assertion, (b1) for the reconcile path); stale leases with the flag `No` (the watchdog deletes them without acting, deletes only the lease it read, the hub rewrites the whole lease); the census ignored level 1's caps (`awakeHold`); `ps` start times in local time (`TZ=UTC0`) and a backward clock step (future heartbeat counts as stale); one unknown battery reading dropped holds on desktops (sticky `none`, two unknowns); releases blocked by Q7 (Q7 reworded with three options) and Q1 now gates L2-POL; L2-CORE may adjust the watchdog's battery rule; untested `exit`-listener path (a real child-process test), reconcile on hardware ((b1)), hung watchdog children (deadlines); departures from ADR 0050 stated (process tree, the dry-run flag, the loud warning for `require_password_on_wake = false`, Q8 for the 35 and 30 percent defaults); the threat model's wording in Q1 and the endpoint docs; the black-box hub test no longer plants a lease.
