# Card P1B: every launch runs under the resolved profile (issue #1748, slice 2 of 2)

Status: ready
Tier: worker-hard
Timebox: L, 2 days; escalate at 4 days or two failed approaches
Needs: none (no Xcode, no simulator); macOS host
Depends: P1A merged into `develop`; P1C merged into `develop` (its note `.context/profiles-codex-credentials.md` is an input)
Branch: `feature/issue-1748-profile-launch` off `origin/develop` (after P1A and P1C merged)
Worktree: `/Volumes/S1/worktrees/remi/profiles-p1b` (the manager creates it with `git worktree add -b` and runs `bun install`)
Plan: plan.md section 2 (P1B); issue #1748 Scope and Acceptance criteria; ADR 0049 D1, D10; backend plan "Profile contract and wrapper settings (#1157)"

## Goal

A wrapper session (`remi`, `remi codex`), a hub child (`remi --daemon`) and a resume each run their agent under the profile the resolver picks, with a complete scrubbed environment, a refusal before anything is spawned when the profile's sign-in is not its own, the profile recorded with the session, and resume refusing a removed, changed or conflicting profile; with no `[profiles]` table every launch is byte-for-byte what it was.

## Context

Read first: issue #1748, `docs/agent-reference/profiles.md` and the `packages/daemon/src/profiles/` module from P1A (the resolver, `profile-env.ts`, `login-check.ts`, `config-warnings.ts`, the revision), P1C's `.context/profiles-codex-credentials.md` ("Consequences for P1B"), and the backend plan section "Profile contract and wrapper settings (#1157)" (lines 168-215).

What the code does today (`develop` `c9e13967`; re-check the lines after P1A merged):
- `PTYSession.start()` spawns with `withoutRemiSecrets({...process.env, ...this.config.env, FORCE_COLOR, TERM})` (`packages/daemon/src/pty/pty-session.ts:211-218`), so deleting a variable from `config.env` cannot remove it: the backend plan's "use a complete child environment".
- The Claude launch adds `buildClaudeChildEnv` (`cli/session-phases/pty-session-setup.ts:204-216`); a non-Claude launch passes `launch: {command, childEnv}` (same file, lines 118-138, 233-244).
- Codex: `CodexLaunchDeps.env` ("`CODEX_HOME` ... comes from here", `harness/codex/codex-session.ts:98-99`) is `() => process.env` at `cli.ts:2302`; `resolveCodexSocketPath(env)` reads `CODEX_HOME` (`harness/codex/codex-socket.ts:85-93`); `codexHarness.preflight(...)` runs at `cli.ts:2410-2415`.
- A hub child copies the hub's environment (`cli/daemon-manager.ts:619-633`); a child that exits before registering is reported as "Daemon process exited unexpectedly. Check logs: ..." (`cli/daemon-manager.ts:677`); the hub's starter is `startSession` in `cli/handlers/create-session-events.ts:276-350`, which `resume_session_request` also uses with `--resume` (`docs/agent-reference/hub-mode.md`).
- The session record (`session/session-store.ts:36-62`) carries an optional `harness` kept as a plain string so rewrites round-trip it; older daemons rebuild records from the keys they know and drop new ones (`session/legacy-writers.ts:1-40`).
- The session daemon builds one `TranscriptDiscovery` at module load with the default `~/.claude/projects` (`cli.ts:1171`; `transcript/transcript-discovery.ts:29, 33-34, 64` accepts `projectsDir`), and `ClaudeHarness.transcriptPath` asks it (`harness/claude.ts:47-49`).
- Download protection roots come from `process.env['CLAUDE_CONFIG_DIR']` and `process.env['CODEX_HOME']` (`cli.ts:1532-1540`, `tunnel/file-download-session-host.ts:22-51`).
- Boundary tests: `packages/daemon/tests/harness/harness-boundary.test.ts` (only `cli.ts` and `harness/` import the harness; `harness/codex/` may import only its allowlist, so it never imports `profiles/`: it receives the environment through `CodexLaunchDeps.env`), `license-boundary.test.ts`, `pty-child-env-secrets.test.ts`.
- Black-box helpers: `tests/integration/launch-characterization.test.ts` (real `cli.ts --daemon` with a fake `claude` recording argv, environment and pid), `tests/integration/hub-test-utils.ts`, `tests/integration/hub-create-session.test.ts`, `tests/helpers/fake-agent-clis.ts`, `tests/helpers/fake-app-server.ts`.

## Scope

May change: `packages/daemon/src/profiles/` (extend; the Codex scrub names from P1C); `packages/daemon/src/pty/pty-session.ts` (a complete-environment option); `packages/daemon/src/cli/session-phases/pty-session-setup.ts`; `packages/daemon/src/cli.ts` (resolution at boot and the wiring below); `packages/daemon/src/cli/arg-parser.ts` and `cli/help.ts` (`--remi-profile`); `packages/daemon/src/harness/claude.ts`, `harness/claude-session.ts`, `harness/codex/codex.ts` and `harness/codex/codex-session.ts` only to accept an environment or a projects directory handed in by `cli.ts` (no import of `profiles/` under `harness/codex/`); `packages/daemon/src/session/session-store.ts` and a new `session/session-profiles-file.ts`; `packages/daemon/src/cli/daemon-manager.ts` (the refusal exit code); tests under `packages/daemon/tests/profiles/`, a new `packages/daemon/tests/integration/profile-launch.test.ts`, and additions to `launch-characterization.test.ts` and `hub-create-session.test.ts`; `docs/agent-reference/profiles.md`; the PR body.
Not in scope: the protocol (`packages/shared/src/protocol*.ts`, fixtures), the profile on session-list entries and remote visibility (P2B), the hub's multi-profile transcript discovery, the status line installer, download protection of inactive profiles (all phase 2, P2A and P2B), the web client, the apps, `packages/signaling/`.

## Decided design

Settled:

1. **Pin first.** The first commit adds tests that record, on the unmodified source, the argv and environment the agent sees for: a wrapper Claude session, a `--daemon` Claude session (extend `launch-characterization.test.ts`), and a hub-created Codex session with the fake `codex` and the stand-in app-server (extend `hub-create-session.test.ts`). The environment is recorded as the presence and value of `CLAUDE_CONFIG_DIR` and `CODEX_HOME` and the names (never values) of every variable in `PROFILE_CREDENTIAL_ENV`, with the daemon's own environment setting all of them to planted values. These tests must pass before and after the change with no `[profiles]` table.
2. **Selection.** `--remi-profile <id>` is accepted by every session-starting form (`remi`, `remi claude`, `remi codex`, `remi --daemon`, `--resume`, `--recent`) and is never passed to the harness; `REMI_PROFILE` is read once at boot. Resolution runs once per session start, in the process that spawns the agent, with the session's working directory (after `--dir`), using P1A's resolver. The built-in `default` takes today's code path unchanged: no environment replacement, no check, no new record fields.
3. **A configured profile's launch.** In this order, and any refusal spawns nothing:
   Message templates below are in backticks; `<id>`, `<harness>`, `<source>` and `<reason>` are filled in by the code.
   a. Harness: an explicit `--harness` or `remi codex`/`remi claude`, else the profile's `harness`, else `[harness] default`; a harness the profile does not configure is refused: `Profile <id> does not configure <harness>.`
   b. Environment: P1A's builder, with `PROFILE_CREDENTIAL_ENV` extended by every Codex variable P1C lists.
   c. Codex store: if P1C's answer for keyring is "not separated" or "not settled", a Codex launch is refused when the effective `cli_auth_credentials_store` (the key in `<CODEX_HOME>/config.toml`, else the default P1C found) is `keyring` or `auto`: `Profile <id> keeps its Codex sign-in in the system keychain, which Codex does not keep apart per profile. Add this line to <CODEX_HOME>/config.toml and sign in again: cli_auth_credentials_store = "file"` (this is the person's own terminal, so the local path is shown). If P1C says "separated", no refusal.
   d. Check: P1A's `checkLogin` under the exact launch environment and directory; anything but `signed_in` is refused with: for `signed_out`, `Profile <id> is not signed in to <harness>. Run: remi profile login <id> --harness <harness>`; for `not_own_login`, `This profile's login is not what will be used (<source>).`; for `unknown`, `Could not confirm the sign-in of profile <id> (<reason>). Run: remi profile ls`.
   e. Warnings: P1A's configuration-level warnings are printed to stderr and the daemon log before the spawn, names only.
   f. Arguments: the profile's `args` are appended after remi's own arguments; for Codex they pass the same validation as user arguments after `--` (`harness/codex/codex-args.ts`), so its refusals (`-p/--profile`, `-c`, ...) stay.
   g. Spawn: `PTYSession` gains an option to use the given environment as complete (no `process.env` merge; `FORCE_COLOR`, `TERM` and `withoutRemiSecrets` still applied); the Claude launch's `buildClaudeChildEnv` values are laid over the profile environment; the built-in path keeps the merge exactly as today.
   h. Claude: the session daemon's `TranscriptDiscovery` and `ClaudeHarness.transcriptPath` use `<claude dir>/projects` for a Claude profile session (resolve the profile before `cli.ts:1171` builds the discovery, or build it after resolution); the status line is not installed into the profile's settings in this slice (P2A).
   i. Codex: `CodexLaunchDeps.env` returns the launch environment, so the socket resolution, the app-server client, `preflight` and the TUI's `childEnv` all use the profile's `CODEX_HOME`.
   j. Download protection: for a profile session, `cli.ts` passes the profile's Claude directory and Codex home as `claudeConfigDirectory` and `codexHome` instead of the process environment's values.
4. **Record and sidecar.** Before the spawn, at the point the binding is written today, the session record gains `profile` (the id) and `profileSnapshot` (`{revision, claudeDir?, codexDir?, claudeExpects?, codexExpects?}`), both optional and round-tripped as plain values like `harness`; and a new sidecar `<remiHome()>/session-profiles.json` (`{version: 1, sessions: {<remi session id>: {profile, revision}}}`, written to a temporary file and renamed, mode 0600, pruned with the records) records the same id and revision. An older remi that rewrites `sessions.json` does not know the sidecar, so a lost record field is detected at resume (owner call J9; if the owner chooses otherwise, the lead changes this item before dispatch). Neither file's profile data is ever sent on the wire in this slice.
5. **Resume** (by id or prefix, `--recent`, and a hub `resume_session_request`), reading the record and the sidecar; each refusal spawns nothing and names only the id:
   - neither has a profile: the built-in `default`, today's behavior;
   - the sidecar names a profile and the record does not, or they differ: `This session's profile information was changed by another remi process. Start a new session.`;
   - the profile is no longer configured: `This session was started in profile <id>, which no longer exists. Start a new session.`;
   - its current revision differs from the snapshot's: `Profile <id> changed after this session started. Start a new session.`;
   - `--remi-profile` or `REMI_PROFILE` names a different profile: `This session belongs to profile <id>. Resume it without --remi-profile, or with --remi-profile <id>.`;
   - otherwise the resume runs under that profile, with item 3's checks.
6. **Hub.** Children inherit the hub's environment as today and resolve their own profile (folder mapping, machine default, an inherited `REMI_PROFILE`); there is no protocol field in this slice. A child refused by item 3 or 5 exits with code 78 after logging its reason; the hub maps exit code 78 to the client-visible error "The session's profile could not start. Run remi profile ls on the machine." (no path), and keeps today's message for every other early exit.
7. **Documentation in the repository:** `docs/agent-reference/profiles.md` gains what this slice ships, the refusal texts, the sidecar and resume rules, and what is still missing until phase 2 (the profile on session-list entries and remote visibility, the hub's multi-profile transcript discovery, the status line in profile sessions, download protection of inactive profiles).
The implementer may choose: names, where in `cli.ts` resolution sits (before any harness or discovery is built), the shape of the complete-environment option, test names.

Never do: run the real `claude` or `codex` in a session; read a credential; write the owner's `~/.remi`, `~/.claude*` or `~/.codex*`; bind ports 18765 to 18769.

## Acceptance

Evidence folder: `/Volumes/S1/yooz/remi/artifacts/profiles-epic-2026-11/P1B/r1/`.
1. The pin tests of design item 1 pass on `origin/develop` (log in the evidence folder, run before any source change) and on the final head.
2. A Claude profile chosen by `--remi-profile`, by `REMI_PROFILE` and by a folder mapping each makes the fake `claude` record `CLAUDE_CONFIG_DIR` equal to the profile's directory and none of the `PROFILE_CREDENTIAL_ENV` names, while the daemon's own environment sets all of them.
3. A Codex profile makes the fake `codex` record `CODEX_HOME` equal to the profile's directory, and remi's app-server client connects to the stand-in app-server listening under that `CODEX_HOME`, not under the test `HOME`'s `.codex`.
4. With a fake `claude` that answers in the V27 `api_key_helper` shape when the profile directory's `settings.json` holds `apiKeyHelper` and in the claude.ai shape otherwise: a subscription profile with a placeholder `apiKeyHelper` is refused with "This profile's login is not what will be used (apiKeyHelper)." and nothing is spawned; with the placeholder removed the session starts.
5. Each configuration-level warning source prints its warning at launch, and planted values from those files appear in no output line.
6. A hub started with a folder mapping creates a child whose fake `claude` records the profile's directory; the child's record holds `profile` and `profileSnapshot`, the sidecar holds the same id and revision; a hub `resume_session_request` for it starts the fake with the same directory.
7. A signed-out profile is refused with `Run: remi profile login <id> --harness claude` (the test's id filled in) and the fake's invocation log stays empty, for a wrapper session and for a hub child (whose client sees the exit-78 message and no path).
8. An unknown profile id is refused naming `remi profile ls`; a harness the profile does not configure is refused; in both, nothing is spawned.
9. Each resume refusal of design item 5 prints its exact text and spawns nothing, including a record whose `profile` fields were removed by rewriting `sessions.json` without them (as an older remi would) while the sidecar still names the profile.
10. For a profile session the download roots include the profile's Claude directory and Codex home as required roots (test at the `cli.ts` call site's builder), and with no profile they are what `origin/develop` builds.
11. A Claude profile session's transcript path is under `<profile claude dir>/projects/`, and a synthetic transcript for the same working directory under the test `HOME`'s `.claude/projects` is never adopted by that session.
12. P1C's keyring rule: if its answer is not "separated", a Codex profile whose `config.toml` sets `cli_auth_credentials_store = "keyring"` is refused with design item 3c's text and nothing is spawned, and with `"file"` it starts.
13. `bun test packages/daemon/tests/pty-child-env-secrets.test.ts packages/daemon/tests/harness/harness-boundary.test.ts packages/daemon/tests/license-boundary.test.ts` passes.
14. Revert checks, each with an isolated failing log in the evidence folder: restore the `process.env` merge for profile launches (item 2 fails), skip the pre-launch check (item 4 fails), ignore the sidecar (item 9's older-writer case fails), drop the exit-78 mapping (item 7's hub case fails).
15. The PR body summarizes P1C's characterization with a link to the note (the issue's "Characterization recorded in the PR"), lists what is not covered until phase 2 (design item 7), names the owner gate OG-P1, states that the `claude.ai` value is unconfirmed until OG-P1, and uses only "Part of #1748".

## Gates

`bun test packages/daemon/tests/profiles packages/daemon/tests/integration/profile-launch.test.ts packages/daemon/tests/integration/launch-characterization.test.ts packages/daemon/tests/integration/hub-create-session.test.ts` passes; `bunx biome check .` ends with no errors; `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests` and `bun run typecheck:signaling` pass; `bun scripts/third-party-notices.ts --check` passes; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; a final `bun test packages/daemon` passes, or fails only in tests that also fail on `origin/develop`, each named in the report.

## Stop conditions

A launch path cannot follow the profile without changing the wire or the session-list entries (phase 2); `harness/codex/` would need to import `profiles/`; a test would need a mock that replaces the resolver, the check, the PTY or the hub starter; the built-in path's argv or environment changes; anything would touch a real login, a credential, the owner's state directories or ports 18765 to 18769; P1C's note is missing or does not answer keyring separation (report; do not guess).

## Report

The preamble's report, plus one line per acceptance item with its test or command, the final `PROFILE_CREDENTIAL_ENV`, and the head after one push.
