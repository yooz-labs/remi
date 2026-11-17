# Card L2-HUB: level 2 keys, the hub's ownership and a local-only control endpoint (issue #1773, slice 3)

Status: ready
Tier: worker-hard
Timebox: L, 1.5 days; escalate at 3 days or two failed approaches
Needs: none (no Xcode, no simulator); macOS host
Depends: L2-CORE
Branch: `feature/issue-1773-level2-hub` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/awake-l2hub` (the manager creates it with `git worktree add --no-track -b` and runs `bun install`)
Plan: plan.md section 2 (L2-HUB); ADR 0050 "Fail-safe design for level 2" items 1 to 5 and 7, the table (lines 162-185), owner decision 8

## Goal

The hub (`remi serve`), and only the hub, owns level 2: it builds the L2-CORE controller with the real switch, reconciles a leftover lease before it serves, reverts on every clean exit path, answers `POST /local-keep-awake` only for a loopback client holding the local capability token, and the level 2 keys of ADR 0050's table become supported, all in one commit, with `level2 = false` by default.

## Context

Read first, at your base (the CP-L2 lead re-verified these; P1A, PR #1798, and P1B of the profiles plan change `config.ts` and `cli.ts`, so recheck every line): the merged L2-CORE modules, ADR 0050 lines 90-104 and 148-185, `docs/agent-reference/keep-awake.md`.

What the code does today (`develop` `bbcec7d6`, checked by the lead on 2026-11-17):
- `cli.ts`: `serveMode` at line 475, `cliDaemonMode` at 476; the hub-only status file rule `serveMode && process.env['REMI_SPAWNED_CHILD'] !== '1'` at line 96; `liveSessionsRegistry` at 778; level 1's `AwakeWiring` at 1184-1190; the synchronous `exit` listener at 1760-1765 (runs `awakeWiring.disposeAll()`); the local capability token loaded at 2832-2841 and passed to the server at 2997; `cleanup()` and `performCleanup()` at 3214-3219; the daemon-mode SIGINT and SIGTERM handlers at 3692-3703 (both run `cleanup()` then exit); SIGUSR1 is the config reload (3704-3714) and SIGUSR2 is `remi unstick`, so no new signal is free.
- `remi stop` sends SIGTERM and waits 5 s before SIGKILL (`cli/daemon-manager.ts:461-485`, `timeout = 5000` at line 470).
- The local-only HTTP precedent: `server/websocket-server.ts:343-354` serves `POST /local-secure-push` only when `shouldSkipAuthForPeer(true, peer, { hasCapability })` holds (`server/peer-helpers.ts:43-53`: a valid capability token over real TCP loopback), forwarding to `events.onLocalPushForward` (`websocket-server.ts:93`, `adapters/websocket-adapter.ts:107-108`, `adapters/connection-adapter.ts:86`, handled at `cli.ts:2784-2786`); its body reader caps size and time (`notifications/local-push-forward.ts:14-60`); its tests are `packages/daemon/tests/notifications/local-push-forward.test.ts`.
- `config/config.ts`: the `[awake]` parts listed in G2's card, as G2 left them.

## Scope

May change:
- `packages/daemon/src/config/config.ts` (the `[awake]` parts only);
- `packages/daemon/src/cli.ts` (the hub construction, the reconcile before serving, the cleanup and `exit` paths, the endpoint handler);
- `packages/daemon/src/server/websocket-server.ts`, `adapters/websocket-adapter.ts`, `adapters/connection-adapter.ts` (the route and its event, beside `/local-secure-push`);
- new `packages/daemon/src/power/level2-endpoint.ts` (request parsing and responses);
- tests under `packages/daemon/tests/power/`, `packages/daemon/tests/config/` if one exists for `[awake]`, and a new `packages/daemon/tests/integration/keep-awake-level2-hub.test.ts`; the L2-CORE guard test (now one `new SudoPmsetSwitch(` in `cli.ts`);
- `docs/agent-reference/keep-awake.md`, ADR 0050's status line (slice 3 keys shipped; `lease_stale_seconds` row added to the table), `AGENTS.md:248`;
- the PR body.
Evidence (not committed): `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/L2-HUB/r1/`.
Not in scope: the `remi keep-awake` command (L2-CLI), `allow_phone` and any protocol message (L2-APP), session daemons' behavior, `arg-parser.ts`, `help.ts`.

## Decided design

Settled:

1. **Keys** (preamble item 9, one commit): every key of L2-POL's `Level2Settings`, with its defaults, ranges and relations, validated by calling `validateLevel2Settings` from `validateAwake` (and so from `applyEnvOverrides` too); `foreign_holder_ignore` is the only array (check that `deepMerge` copies it as given).
   `allow_phone` stays unsupported (it lands with L2-APP).
   The generated `[awake]` section documents each key in one comment line with its range, `level2 = false` first, and says that level 2 also needs the sudoers rule, the boot daemon and the watchdog (`remi keep-awake setup`, from L2-CLI).
   `formatConfig` prints every key; `foreign_holder_ignore` prints its count only.
2. **Ownership**: only a process with `serveMode && process.env['REMI_SPAWNED_CHILD'] !== '1'` on `darwin` builds `Level2Controller` with `new SudoPmsetSwitch()` (the only construction in `packages/daemon/src`), `MacLevel2Readings`, the census over `liveSessionsRegistry` and the hub's pid; whatever `level2` says (a lease left by an earlier run with `level2 = true` must still be reverted).
   `reconcileAtStartup()` completes before the server listens.
   Every other process has no controller.
3. **Exit paths**: `performCleanup()` first awaits `controller.shutdown()` (bounded at 3 s, inside `remi stop`'s 5 s) when a controller exists; the `exit` listener calls `controller.shutdownSync()` before `awakeWiring.disposeAll()`.
   A SIGKILL is the watchdog's (W1) and the boot daemon's job.
4. **Endpoint**: `POST /local-keep-awake`, same gate as `/local-secure-push` (`shouldSkipAuthForPeer(true, peer, { hasCapability })`; 403 otherwise; 405 for other methods; 503 in a process with no controller).
   Body at most 4096 bytes and 2 s: `{ "v": 1, "action": "status" | "start" | "stop" | "extend", "hours"?: integer }`; anything else is 400 with `{ v: 1, ok: false, error: 'invalid' }` (no echo of the body).
   Response 200 with `{ v: 1, ok, status }` where `status` is the controller's `status()` and `ok` is false when the request was refused (the refusal reason is `status.lastRefusal`).
   No other route, header or query changes the controller.
5. **Logs**: the controller's `[Awake2]` lines go to the hub's log; the endpoint logs one line per request with the action and outcome, never the body.
6. **Docs**: `keep-awake.md` gains "Level 2 (lid-closed mode)": who owns it, every key with its default, every refusal and revert reason, the exit and crash behavior, the endpoint's gate, and a "Not verified" list (nothing on a MacBook until OG-L2: the lid, `disablesleep 0` with the lid closed, the boot daemon, `displaysleepnow` without root); the generated config, `AGENTS.md:248` and ADR 0050's status line agree with it.
The implementer may choose: where in `cli.ts` the construction sits (it must be after `liveSessionsRegistry` and the config exist and before the server listens), names inside `level2-endpoint.ts`, test names.

## Acceptance

Evidence folder: `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/L2-HUB/r1/`.
1. Config tests: defaults load; each key's bounds and each relation of L2-POL item 1 refuse with the key's name; the generated config round-trips to `DEFAULT_CONFIG.awake`; a config holding every key of ADR 0050's table except `allow_phone` loads; `allow_phone` is refused as unsupported.
2. Endpoint tests (in-process, the real server class with a controller over the recording switch): no capability header, a wrong token, and a GET each give the gate's answer and record no switch call; an oversized body, a non-JSON body, an unknown action and a fractional `hours` give 400; `status` returns the controller's status; a `start` that passes reaches the recording switch exactly once; the response never contains the request body.
3. Exit-path tests: with a controller in the `on` state over the recording switch, the code path `performCleanup()` runs records one disable before it resolves, and the `exit` listener path records one synchronous disable; with level 2 off, neither records anything.
   If `cli.ts`'s functions cannot be reached from a test, extract the level 2 part into a function in `power/` that `cli.ts` calls and test that function (no copy of the logic in the test).
4. Black-box hub test (darwin-only, `keep-awake-level2-hub.test.ts`): a real `cli.ts serve` under `env -i` with a temporary `HOME` and `REMI_HOME`, a port from `reserveRange` (above 18790), `--no-relay --no-telegram --no-mdns`, and `[awake] level2 = true` in its config.
   Precondition, asserted first: `readRootDomain()` reads `sleepDisabled: 'no'` (otherwise fail with that message; never continue).
   It asserts: a lease planted before start with a dead `hubPid` is gone after the hub listens; `POST /local-keep-awake` without the token is 403 and with the token (read from the temporary remi home) `status` answers with `level2: 'off'`; after SIGTERM the process exits within 5 s and no lease exists.
   It never sends `start` or `extend` (the real switch must not run in a test); the `[Awake2]` log lines are printed to the test output for the evidence.
5. The L2-CORE guard test now allows exactly one `new SudoPmsetSwitch(` in `packages/daemon/src`, in `cli.ts`, and still none without `spawnRoot` in tests.
6. `mkdir -p /private/tmp/remi-canon-L2-HUB && env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin TMPDIR=/private/tmp/remi-canon-L2-HUB/ bun test packages/daemon/tests/power packages/daemon/tests/integration/keep-awake-daemon-smoke.test.ts packages/daemon/tests/integration/keep-awake-level2-hub.test.ts packages/daemon/tests/notifications/local-push-forward.test.ts` ends with `0 fail` and no skipped power or keep-awake test on this Mac.
7. Revert checks, each with its failing log and a `revert-index.md` line: let the endpoint accept a request without the capability (2 fails); remove the `shutdown()` call from `performCleanup()` (3 fails); construct the controller in a session daemon too (a test asserting a session daemon has none fails; add it); drop one key from the supported set while keeping its default (1 fails).
8. The PR body says what ships (the keys, hub ownership, reconcile, exit reverts, the local endpoint; `level2` off by default), that nothing can start level 2 from the command line until L2-CLI, what is unverified until OG-L2, and "Part of #1773".

## Gates

`bunx biome check .` ends with no errors; `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests` and `bun run typecheck:signaling` pass; `bun scripts/third-party-notices.ts --check` passes; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; Acceptance 6 passes in the canonical environment; hosted CI's `Test worker 0` to `2`, `Test` and the `local-relay` soak pass on the final head.

## Stop conditions

`SleepDisabled` reads `Yes` on this Mac at any point (stop at once; preamble item 5); a test would need the real switch to run; the endpoint cannot reuse the `/local-secure-push` gate without changing that gate; the owner's Q1 answer in the live facts is not (a) (the lead rewrites this card first).

## Report

The preamble's report; one line per acceptance item goes into `report-details.md` in the evidence folder.
