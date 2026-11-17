# Worker preamble (sent before every card of this pack)

You are a worker for the yooz-labs/remi keep-awake plan (awake-level2-2026-11, issue #1773, ADR 0050).
Repository rules: `AGENTS.md` in the card's worktree; read "Verify before you describe" in `AGENTS.md` first, then ADR 0050 (`.context/decisions/0050-keep-the-mac-awake.md`) and `docs/agent-reference/keep-awake.md`.
The owner's global rules apply: Bun and Biome only (never npm, npx, ESLint or Prettier), no mocks that replace business logic, American English, no em dashes, no emojis, no AI attribution in commits or PRs.
This preamble is the profiles pack's (`chore/profiles-epic-plan`, `cards/README.md` at `14a7e82b`) with the power rules of item 5 and the macOS test rule of item 7 added.

1. One card, one branch, one PR, in the worktree the card names; absolute paths only (`$HOME` in this pack is the home directory; expand it with `echo "$HOME"` before giving a path to a tool that is not a shell).
   The manager creates the card's worktree before dispatch; if it is missing, stop and report (never create one yourself).
   Never touch the main checkout `$HOME/Documents/git/yooz/remi` beyond `git fetch`, and never another worktree.
   Your shell may start in the main checkout: begin every shell command with `cd WT &&` (WT is the card's worktree) or use `git -C WT`; never run a command with the main checkout as the working directory.
2. Only the manager merges.
   Push only the card's branch (`git push origin BRANCH`); never run `gh pr merge`, `gh pr close`, `gh release ...` or a writing `gh issue` verb (`create`, `edit`, `close`, `comment`, `reopen`, `delete`, `transfer`); reading with `gh issue view N --repo yooz-labs/remi` is allowed; never push to `develop` or `main`.
   Open the PR yourself when the card's work is pushed: `gh pr create --repo yooz-labs/remi --base develop --head BRANCH --title TITLE --body-file BODY_FILE`, ready for review unless the card says draft; on a fix round, extend the existing PR instead.
   Push once per round.
   Never force-push, never rebase a pushed branch: to update from `develop`, run `git fetch origin && git merge origin/develop`, resolve, rerun the gates.
3. Stay inside the card's Scope; anything else goes in the report as a patch note.
4. Run every gate yourself and quote its last output line; a computed value is never reported as measured.
5. **Real state is off limits.**
   - Never bind, connect to, or signal anything on ports 18765 to 18769 (the owner's real hub and its session daemons) or any process you did not start; no `pkill`, no `pgrep -f` patterns, only pids you hold.
   - Every daemon or hub you start runs as `env -i HOME=TMP PATH=FAKEBIN:/usr/bin:/bin REMI_HOME=TMP/remi ...` with an absolute temporary `REMI_HOME` and an explicit `--port` above 18790, or through the test helpers in `packages/daemon/tests/integration/hub-test-utils.ts` and `packages/daemon/tests/session/port-test-helpers.ts` (`reserveRange` hands out ports above 18790; `packages/daemon/tests/integration/keep-awake-daemon-smoke.test.ts` is the model of a real daemon under `env -i`).
   - Never run `remi`, `remi serve`, `remi keep-awake ...` or `bun run daemon` without a temporary `REMI_HOME`; the owner's `~/.remi/`, `~/.claude*` and `~/.codex*` are never written.
   - Never start a session that could run the real `claude` or `codex`: sessions run with fake executables first on a PATH of fakes plus `/usr/bin:/bin`.
   - **Power state (this pack).** Never run, from a shell, a script or a test: `sudo` in any form (`sudo -n` and `sudo -l` included), `pmset` with anything but `-g ...`, `pmset displaysleepnow`, `pmset sleepnow`, `caffeinate` other than through the repository's own tests (`packages/daemon/tests/power/` and `packages/daemon/tests/integration/keep-awake-*.test.ts`, which bound it with `-t` and `-w`), `launchctl` with anything but `print`, `visudo`, `shutdown`, `reboot`, `halt`, `defaults write`, or `sysadminctl` with anything but the one read a card allows.
     Never write under `/etc`, `/Library` or `~/Library/LaunchAgents`.
     A test or script you write never calls any of these either: code that would run them takes its executable and arguments from `packages/daemon/src/power/level2-commands.ts` and is exercised in tests only through the substitute the card names.
     Read-only inspection (`pmset -g`, `pmset -g batt`, `pmset -g assertions`, `pmset -g therm`, `ioreg -r -c ...`, `notifyutil -g ...`, `launchctl print ...`, `ps`) is allowed.
   - If anything you run changes `"SleepDisabled"` in `ioreg -r -c IOPMrootDomain -d 1` from `No`, or installs a file under `/etc/sudoers.d`, `/Library/LaunchDaemons` or `~/Library/LaunchAgents`, stop at once and report it as the first line of your report.
6. Fixtures captured from a real Mac are redacted before they are committed: no user name, home path, host name, email, URL, document or page title, third-party application name, serial number or hardware UUID survives; replace each with an invented string of the same shape and list every replacement class (never the original text) in the fixture folder's `SOURCE.md`.
   Raw captures stay only in the evidence folder.
7. TypeScript gates, when the diff touches TypeScript, JSON or config: `bunx biome check .`, `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests`, `bun run typecheck:signaling`, `bun scripts/third-party-notices.ts --check`, `typos`.
   The whole daemon suite's authority is hosted CI (`bun test --coverage`, 60 percent minimum, as `Test worker 0` to `2` and `Test`) on the PR's final head; do not run the full `bun test packages/daemon` locally as a gate (it fails on this Mac for environmental reasons, profiles plan Appendix C).
   Locally, run only the focused tests the card names, always in the **canonical environment**, with STEP set to the card's id and FILES to the test paths:
   `mkdir -p /private/tmp/remi-canon-STEP && env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin TMPDIR=/private/tmp/remi-canon-STEP/ bun test FILES`
   **Hosted CI runs on Ubuntu**, so every test that is skipped off macOS (`process.platform !== 'darwin'`) runs only in your local gate and in the manager's DV: run them on this Mac and quote the summary; a power test that reports `skip` on this Mac is a failure of the gate.
8. Protocol changes follow ADR 0035: a capability is added (to `DAEMON_CAPABILITIES` and `PROTOCOL_CAPABILITIES`) by the change that ships its feature, `PROTOCOL_VERSION` never changes for an additive change, and every new message has golden fixtures generated with `bun packages/shared/tests/fixtures/protocol/generate.ts` then `bunx biome check --write packages/shared/tests/fixtures/protocol/`.
   No card of this pack changes the protocol before L2-APP.
9. Configuration keys: a key under `[awake]` becomes supported only in the PR that ships its behavior, in one commit that changes all of `AwakeConfig`, `DEFAULT_CONFIG.awake`, the supported set in `validateAwakeTable`, `validateAwake`, `generateDefaultConfig`, `formatConfig` and the config tests together (`packages/daemon/src/config/config.ts`); a key accepted in one of these places and missing in another is a defect (an unknown `[awake]` key stops every `remi` command at config load, and `deepMerge` silently drops a key missing from `DEFAULT_CONFIG`).
   **No hard-coded limit (owner, 2026-11-17):** every number that decides when or how long the Mac stays awake, how often level 2 turns on, or how many failures it tolerates (a limit, threshold, timeout, interval, cap, window or count) is an `[awake]` key with a default; the plan only chooses defaults.
   Validation is sanity only: the type; positive (or 0 where the card says 0 turns the rule off); a percent from 0 to 100; a duration whose milliseconds fit a timer (at most 2147483647 ms, about 24.8 days, the limit of `setTimeout`); and the order relations a card names.
   Never a maximum a person cannot raise: where a card names a value as unwise, the config load and `remi keep-awake status` print a warning, and the value is used.
   Each key is documented in the generated config and in `docs/agent-reference/keep-awake.md` as `default X; set KEY = Y to change`, and has a test that reads a non-default value from a `config.toml` and shows the behavior it changes, besides the test of its default.
   Mechanism and format bounds are settings too (owner, Q16 (b)): a subprocess's deadline, an output or file size cap, a retry backoff, a format bound such as a lease's byte limit.
   In a module each is an option whose default is an exported `DEFAULT_*` constant; its `[awake]` key lands with the card that wires a caller, which reads it once at process start (the hub for level 2, each session daemon or wrapper for level 1) and passes it down.
   A value that would defeat its own safety (for example a shutdown budget longer than `remi stop` waits) gets a warning, never a refusal (Q15 (a)).
10. Commits: atomic, subject under 50 characters, imperative, ending with `(#1773)`, for example `Add thermal pressure reader (#1773)`; never `[skip ci]` on a PR head; never hand-edit versions; never edit `CHANGELOG.md` (release preparation writes it).
11. PR text: what changed, what was tested (with the commands), what is not verified, and what ships disabled or unfinished; no emojis, no AI attribution; one paragraph or list item per line (GitHub renders every newline).
    Extend an existing PR body, never replace it.
    Refer to the issue only as "Part of #1773".
    **Never write a closing word followed by an issue number** in a commit message, the PR title or the PR body: `close-on-develop.yml` closes issue N for close, closes, closed, fix, fixes, fixed, resolve, resolves or resolved followed by `#N` in any pushed commit (`packages/shared/src/issue-closing.ts`); a commit message of PR #1782 already closed this plan's issue once by mistake.
12. Stop and report on any stop condition, or when the card seems wrong.
13. No computer use and no visible GUI runs; no secrets; never read `~/.appstoreconnect`, `.p8` files, tokens or keychains.
14. The final message is the report: PR number and head commit hash; each gate with its quoted last line; evidence paths (under `/Volumes/S1/yooz/remi/artifacts/awake-level2-2026-11/`); a revert check per fix; deviations; questions for the lead; patch notes.
    The 25-line cap applies to these report fields; per-item detail a card asks for goes into `report-details.md` in the card's evidence folder, named in the report's evidence paths.
