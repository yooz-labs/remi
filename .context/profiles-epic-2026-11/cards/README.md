# Worker preamble (sent before every card)

You are a worker for the yooz-labs/remi profiles epic (profiles-epic-2026-11, parent issue #1157).
Repository rules: `AGENTS.md` and, for native work, `packages/native/AGENTS.md`, in the card's worktree; read "Verify before you describe" in `AGENTS.md` first.
The owner's global rules apply: Bun and Biome only (never npm, npx, ESLint or Prettier), no mocks that replace business logic, American English, no em dashes, no emojis, no AI attribution in commits or PRs.

1. One card, one branch, one PR, in the worktree the card names; absolute paths only (`$HOME` in this pack is the home directory; expand it with `echo "$HOME"` before giving a path to a tool that is not a shell).
   The manager creates the card's worktree before dispatch; if it is missing, stop and report (never create one yourself).
   Never touch the main checkout `$HOME/Documents/git/yooz/remi` beyond `git fetch`, and never another worktree.
   Your shell may start in the main checkout: begin every shell command with `cd WT &&` (WT is the card's worktree) or use `git -C WT`; never run a command with the main checkout as the working directory.
2. Only the manager merges.
   Push only the card's branch (`git push origin BRANCH`); never run `gh pr merge`, `gh pr close`, `gh release ...` or a writing `gh issue` verb (`create`, `edit`, `close`, `comment`, `reopen`, `delete`, `transfer`); reading with `gh issue view N --repo yooz-labs/remi` is allowed; never push to `develop` or `main`.
   Open the PR yourself when the card's work is pushed: `gh pr create --repo REPO --base BASE --head BRANCH --title TITLE --body-file BODY_FILE` (REPO `yooz-labs/remi` with BASE `develop`, or `yooz-labs/yooz-docs` with BASE `main`), ready for review unless the card says draft; on a fix round, extend the existing PR instead.
   Push once per round.
   Never force-push, never rebase a pushed branch: to update from `develop`, run `git fetch origin && git merge origin/develop`, resolve, rerun the gates.
3. Stay inside the card's Scope; anything else goes in the report as a patch note.
4. Run every gate yourself and quote its last output line; a computed value is never reported as measured.
5. **Real state is off limits.**
   - Never bind, connect to, or signal anything on ports 18765 to 18769 (the owner's real hub and its session daemons) or any process you did not start; no `pkill`, no `pgrep -f` patterns, only pids you hold.
   - Every daemon or hub you start runs as `env -i HOME=<tmp> PATH=<fake-bin>:/usr/bin:/bin REMI_HOME=<tmp>/remi ...` with an absolute temporary `REMI_HOME` and an explicit `--port` above 18790, or through the test helpers in `packages/daemon/tests/integration/hub-test-utils.ts` (its session-daemon helper `spawnDaemon` reserves a random port from 45000 to 49999; `findTestPort` hands out the lowest free port from 19200; neither can take 18765 to 18769).
   - Never run `remi`, `remi serve`, `remi profile ...` or `bun run daemon` without a temporary `REMI_HOME`; the owner's `~/.remi/config.toml`, `~/.remi/sessions.json`, `~/.claude/settings.json`, `~/.claude*`, `~/.codex*` and `~/.config/anthropic` are never written.
   - Never start a session that could run the real `claude` or `codex`: sessions run with fake executables first on a PATH of fakes plus `/usr/bin:/bin` (`packages/daemon/tests/helpers/fake-agent-clis.ts`). No test or gate prints a real CLI's raw output: hosted CI keeps test logs as downloadable artifacts of a public repository.
     The only real-CLI runs allowed are the read-only characterizations a card names (`claude auth status --json` or `codex login status` against EMPTY scratch directories, with placeholder strings, never a real account), as ADR 0049 V27 did.
   - Never connect to the real Codex app-server socket under `~/.codex`; use `packages/daemon/tests/helpers/fake-app-server.ts`.
   - Never run a login (`claude auth login`, `claude /login`, `codex login`), never read, copy, print or log a credential file, a keychain entry, a token, an email or an account identifier (ADR 0049 D10).
   - Apps: never launch the app in a simulator against a real hub; uninstall it from the simulator before the first launch; only the fixture hub on a port above 18790.
6. Native gates run under the shared Xcode lock, exactly as the card writes them (`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock ...`), with `-derivedDataPath /Volumes/S1/derived/remi-NAME` for every `xcodebuild`.
   Local baseline (owner, Q20 of land-branches-2026-11): `PairingAttemptTests` and `PairingSourceTests` fail locally with "owned empty launch directory required"; run the full suite with `--skip PairingAttemptTests --skip PairingSourceTests` and say so; hosted CI runs them.
7. TypeScript gates, when the diff touches TypeScript, JSON or config: `bunx biome check .`, `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests`, `bun run typecheck:signaling`, `bun scripts/third-party-notices.ts --check`, `typos`.
   The whole daemon suite's authority is hosted CI (`bun test --coverage`, 60 percent minimum, as `Test worker 0` to `2` and `Test`) on the PR's final head (owner, J19 (a)); do not run the full `bun test packages/daemon` locally as a gate: on this Mac it fails for environmental reasons (plan Appendix C). Locally, run only the focused tests the card names, always in the **canonical environment**, pasted as is with STEP set to the card's id and FILES to the test paths:
   `mkdir -p /private/tmp/remi-canon-STEP && env -i HOME="$HOME" PATH=/opt/homebrew/bin:/usr/bin:/bin TMPDIR=/private/tmp/remi-canon-STEP/ bun test FILES`
   (checked by the lead on 2026-11-17 in a worktree with `bun install` done: `packages/daemon/tests/tunnel/image-staging-service.test.ts` gave 54 pass, 0 fail; with the default macOS `TMPDIR` the same file fails 54 of 54). `/private/tmp` is a real directory, so remi's canonical-path checks accept roots under it.
8. Protocol changes follow ADR 0035: a capability is added (to `DAEMON_CAPABILITIES` and `PROTOCOL_CAPABILITIES`) by the change that ships its feature, `PROTOCOL_VERSION` never changes for an additive change, and every new message has golden fixtures generated with `bun packages/shared/tests/fixtures/protocol/generate.ts` then `bunx biome check --write packages/shared/tests/fixtures/protocol/`.
9. Commits: atomic, subject under 50 characters, imperative, ending with the issue number in parentheses, for example `Add profile resolver (#1748)`; never `[skip ci]` on a PR head; never hand-edit versions.
10. PR text: what changed, what was tested (with the commands), what is not verified, and what ships disabled or unfinished; no emojis, no AI attribution; one paragraph or list item per line (GitHub renders every newline).
    Extend an existing PR body, never replace it.
    Refer to issues only as "Part of #N".
    **Never write a closing word followed by an issue number** in a commit message, the PR title or the PR body: `close-on-develop.yml` closes issue N for close, closes, closed, fix, fixes, fixed, resolve, resolves or resolved followed by `#N` in any pushed commit (`packages/shared/src/issue-closing.ts`); the manager closes issues when a phase is complete.
11. Stop and report on any stop condition, or when the card seems wrong.
12. No computer use and no visible GUI runs unless the card says the owner announced consent for that run; no secrets; never read `~/.appstoreconnect`, `.p8` files, tokens or keychains.
13. The final message is the report: PR number and head commit hash; each gate with its quoted last line; evidence paths (under `/Volumes/S1/yooz/remi/artifacts/profiles-epic-2026-11/`); a revert check per fix; deviations; questions for the lead; patch notes. The 25-line cap applies to these report fields; per-item detail a card asks for (one line per acceptance item, a final list of names) goes into `report-details.md` in the card's evidence folder, named in the report's evidence paths.
