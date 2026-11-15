# Card P1A: the profile model and `remi profile ls|add|show|login` (issue #1748, slice 1 of 2)

Status: ready
Tier: worker-hard
Timebox: L, 1.5 days; escalate at 3 days or two failed approaches
Needs: none (no Xcode, no simulator); macOS host
Depends: none
Branch: `feature/issue-1748-profile-model` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/profiles-p1a` (the manager creates it with `git worktree add -b` and runs `bun install`)
Plan: plan.md section 2 (P1A); issue #1748 sections Scope, Acceptance criteria and Additions; ADR 0049 D1, D10, V2, V3, V27, V28

## Goal

remi can read, validate and resolve `[profiles]` from `config.toml`, check which credential each profile's harness would actually use without reading it, warn about configuration-level credential sources by name only, and offer `remi profile ls`, `add`, `show` and `login` in the person's terminal; no session launch changes yet (P1B wires launches).

## Context

Read first: issue #1748 (`gh issue view 1748 --repo yooz-labs/remi`), ADR 0049 sections "Account selection and login" (V1 to V5, V27, V28) and D1, D10, and `.context/issue-1595-backend-plan.md` section "Profile contract and wrapper settings (#1157)".

What the code does today (`develop` `c9e13967`):
- No profile exists anywhere; `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are read only at `packages/daemon/src/cli.ts:1538-1539` (download roots) and `packages/daemon/src/harness/codex/codex-socket.ts:91-93`.
- `config/config.ts` validates tables one by one (`validateHarnessTable`, `validateAwakeTable`, ... in `loadConfigWithNotices`, lines 392-450) and `deepMerge` (lines 325-360) keeps only keys of `DEFAULT_CONFIG`, so a `[profiles]` table is silently dropped today. Nothing writes `config.toml` except `initConfigFile` (lines 918-935). `generateDefaultConfig` (line 805) writes the commented default file.
- Subcommands: `SUBCOMMAND_LIST` in `cli/arg-parser.ts:13-41`; subcommands with a verb and operands are in `SUBCOMMANDS_WITH_ARG_LIST` (lines 63-66: `model`, `devices`). `cli/cmd-config.ts` is the model for a testable command handler (`runConfigCommand(arg, config, io, paths)`).
- remi's own secrets are removed from every agent environment by `withoutRemiSecrets` (`pty/child-env.ts:21-35`). The guard test `packages/daemon/tests/pty-child-env-secrets.test.ts:108-138` fails if any string literal under `packages/daemon/src` whose name matches `SECRET|TOKEN|PASSPHRASE|PASSWORD|PRIVATE_KEY` is not in `REMI_SECRET_ENV` or its `NOT_ENVIRONMENT` exemption set, and a second test fails if an exempted name is read as `env['NAME']` or `env.NAME`.
- `packages/shared/src/display-text.ts:53` exports `escapeUnsafeText`, which rewrites unsafe characters as visible text.
- `remiHome()` (`config/remi-home.ts`) is the only way to build a state path; tests run with `REMI_HOME` unset by a bunfig preload and use isolated `HOME`s.
- Fake executables for black-box tests: `packages/daemon/tests/helpers/fake-agent-clis.ts` (record argv, cwd, pid under `$FAKE_AGENT_DIR`).

Facts the lead read from the installed Claude Code 2.1.325 binary's embedded code (not observed with a login; ADR 0049 G12): `claude auth status --json` builds `{loggedIn, authMethod, apiProvider, analyticsDisabled, projectsDirectory, configDirectory, loginExpiresAt}`, adds `apiKeySource` when a key source is in use, and when `authMethod === "claude.ai"` also adds `email`, `orgId`, `orgName`, `subscriptionType`, `storedClaudeAiLogin` and `planTier`; it exits 0 when logged in, 1 otherwise. So the status output can carry an email: the parser is a privacy boundary.
Verified by ADR 0049 V27 (placeholders, no account): a placeholder `ANTHROPIC_API_KEY` gives `"authMethod": "api_key"`, `"apiKeySource": "ANTHROPIC_API_KEY"`, exit 0; a placeholder `apiKeyHelper` in the directory's `settings.json` gives `"authMethod": "api_key_helper"`, `"apiKeySource": "apiKeyHelper"`, exit 0; an empty directory gives `"loggedIn": false`, `"authMethod": "none"`, exit 1. Codex: a fresh `CODEX_HOME` prints "Not logged in" and exits 1 (V5).

## Scope

May change:
- new `packages/daemon/src/profiles/` (for example `profile-config.ts` schema, validation and limits; `resolve-profile.ts` the pure resolver; `profile-paths.ts`; `profile-env.ts` the probe and launch environment builder; `login-check.ts` the effective-login check; `config-warnings.ts`; `config-append.ts` the atomic append for `add`; `cmd-profile.ts` the command handler; names are yours);
- new `packages/shared/src/profile-label.ts` (label rules, including the email-shape test) and its export from the shared index;
- `packages/daemon/src/config/config.ts` (a `profiles` member of `RemiConfig` and `DEFAULT_CONFIG`, validation through the profiles module, `deepMerge`, a commented `[profiles]` example in `generateDefaultConfig`, and `formatConfig` printing ids and labels only);
- `packages/daemon/src/cli/arg-parser.ts`, `packages/daemon/src/cli/help.ts`, and the minimal dispatch lines in `packages/daemon/src/cli.ts` for the `profile` subcommand;
- `packages/daemon/tests/pty-child-env-secrets.test.ts` (the exemption for the profile scrub list);
- tests under `packages/daemon/tests/profiles/` and `packages/shared/tests/`;
- new `docs/agent-reference/profiles.md` and one pointer line in `AGENTS.md`;
- the PR body.
Not in scope: any launch path (`pty/`, `harness/`, `cli/session-phases/`, `cli/daemon-manager.ts`, `cli/handlers/`), the `--remi-profile` flag, the session store, the protocol, the web client, the apps, `packages/signaling/`.

## Decided design

Settled:

1. **Configuration.** Shape (keys are final; the guides and the apps will name them):
   ```toml
   [profiles]
   default = "work"                 # optional; must name a configured profile

   [profiles.work]
   label = "Work"                   # required
   harness = "claude"               # optional: claude | codex, the profile's default harness
   args = ["--model", "opus"]       # optional strings, appended to the harness argv by P1B
   folders = ["~/src/work"]         # optional; absolute or ~/ paths
   env = { AWS_PROFILE = "work" }   # optional string values, applied after the scrub by P1B

   [profiles.work.claude]
   dir = "~/.claude-work"           # optional; default <remi home>/p/<id>/claude
   expects = "subscription"         # required: subscription | api_key

   [profiles.work.codex]
   dir = "~/.codex-work"            # optional; default <remi home>/p/<id>/codex
   expects = "subscription"         # required: subscription | api_key
   ```
   Rules, each a load error naming the key path (never a value): at most 32 profiles; id matches `^[a-z0-9][a-z0-9-]{0,31}$`; `default` is reserved for the built-in profile and cannot be configured; at least one of `claude`, `codex`; `expects` is required in each harness table (never derived from the harness name: ADR 0051 A8 requires that a Claude Code profile is not assumed to be an Anthropic subscription); unknown keys are refused; `dir` and `folders` entries are absolute after expanding a leading `~/` against `os.homedir()` and are stored `path.resolve`d; one folder in two profiles is refused; `[profiles] default` must name a configured id; `env` names match `^[A-Za-z_][A-Za-z0-9_]*$`, a name in `REMI_SECRET_ENV` is refused, and a name matching `/(API_KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|PRIVATE_KEY)/i` is refused with "remi does not store credentials; use the harness's own sign-in" (ADR 0049 D10).
   Label (shared `profile-label.ts`, reused by phase 2's guide and the apps): trimmed, 1 to 64 code points, equal to `escapeUnsafeText(label)`, and not email-shaped, where email-shaped means it matches `/[^\s@]+@[^\s@]+\.[^\s@]+/`; the refusal text is exactly "Use a name such as Work, not an email address".
   A profile's revision (for P1B's snapshot and phase 2's `changed` state) is the SHA-256 hex of the canonical JSON (sorted keys) of `{harness, args, env, claude: {dir, expects}, codex: {dir, expects}}`; `label` and `folders` are not part of it.
   Without a `[profiles]` table, `loadConfig` returns exactly what it returns today plus an empty `profiles` member; every existing config test passes unchanged.
2. **Resolver** (pure, no I/O except an injected `realpath`): input `{flag?, envValue?, cwd, profiles}`; output `{id, source}` with `source` one of `flag`, `env`, `folder`, `machine_default`, `built_in`, or a refusal naming the unknown id and `remi profile ls`. Precedence: flag, then `REMI_PROFILE`'s value, then the longest `folders` entry that equals the canonical `cwd` or is a path-component prefix of it (`/a/b` matches `/a/b` and `/a/b/c`, never `/a/bc`), then `[profiles] default`, then the built-in `default`. Canonical means `fs.realpathSync` when the path exists, otherwise `path.resolve`. The literal id `default` in the flag or the variable selects the built-in profile.
3. **Environment builder** (`profile-env.ts`, used by `ls`, `login` and, in P1B, by launches): from a copy of the inherited environment, delete every name in one exported constant `PROFILE_CREDENTIAL_ENV` by iterating it (never write `env['NAME']` for these names, so the guard test's second check stays meaningful): `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_IDENTITY_TOKEN_FILE`, and for Codex `OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN` (P1B extends the Codex part from P1C's note); delete `ANTHROPIC_BASE_URL` unless the profile's `env` sets it; set `CLAUDE_CONFIG_DIR` and `CODEX_HOME` to the profile's directories for the harnesses it configures; apply the profile's `env`; then `withoutRemiSecrets` last. The result is a complete environment (no later merge with `process.env`).
   Extend `pty-child-env-secrets.test.ts`: names in `PROFILE_CREDENTIAL_ENV` are an exemption imported from the module (they are removed for profile launches, not remi's own secrets), each exempted name must be in that constant, and none may be read as `env['NAME']` or `env.NAME` anywhere under `packages/daemon/src`.
4. **Effective-login check** (`login-check.ts`): `checkLogin({harness, expects, env, cwd, timeoutMs = 10000})` returns `{login, source?, reason?, facts?}` with `login` one of `signed_in`, `signed_out`, `not_own_login`, `unknown`; `source` from the closed set `ANTHROPIC_API_KEY`, `apiKeyHelper`, `/login managed key`, `other`; `reason` from `harness_missing`, `timeout`, `not_checked`, `error`.
   Claude: spawn `claude auth status --json` with no shell, the given complete `env` and `cwd`, stdout capped at 64 KiB, stderr ignored; parse JSON and read only `loggedIn` (boolean), `authMethod`, `apiProvider` and `apiKeySource` (strings); every other field is dropped unread, and no part of stdout or stderr is ever logged, printed, stored or put in an error message (an unparsable answer is `unknown`/`error` and the log line says only "unparsable status output (N bytes)").
   Mapping for `expects = "subscription"`: `loggedIn !== true` is `signed_out`; `apiKeySource` present is `not_own_login` with that source (unknown names map to `other`); `authMethod === "claude.ai"` with no `apiKeySource` is `signed_in`; any other `authMethod` is `not_own_login`, source `other` (fail closed; the value `claude.ai` comes from the binary's code and is confirmed by the owner gate OG-P1).
   Mapping for `expects = "api_key"`: `signed_in` only when `loggedIn === true`, `authMethod` is `api_key` or `api_key_helper` and `apiKeySource` is present; `loggedIn !== true` is `signed_out`; anything else is `not_own_login`, source `other`.
   `facts` keeps only `authMethod` and `apiProvider` mapped to closed sets (`claude.ai`, `api_key`, `api_key_helper`, `none`, `other`; `firstParty`, `bedrock`, `vertex`, `foundry`, `gateway`, `other`) and `apiKeySource` as above; nothing else from the output survives.
   Codex: first read the profile Codex home's `config.toml` for the single key `cli_auth_credentials_store` (by key only); unless it is explicitly `"file"`, do not spawn anything and return `unknown`/`not_checked`, because until P1C answers whether Codex keeps keychain sign-ins apart per `CODEX_HOME`, a status read could consult the owner's real keychain entry (P1B relaxes this if P1C says "separated"). With `"file"`, spawn `codex login status` the same way and read only the exit code (0 is `signed_in`, 1 is `signed_out`, anything else `unknown`/`error`); stdout is not read. A missing executable is `unknown`/`harness_missing`; past the deadline the child is killed and the result is `unknown`/`timeout`.
5. **Configuration-level warnings** (`config-warnings.ts`, Claude only), read by name, never by value, with every root injectable for tests: the Anthropic configuration directory (`$XDG_CONFIG_HOME/anthropic` when set, else `~/.config/anthropic`) holding an `active_config` file or any entry in `configs/`; managed settings (the macOS path from code.claude.com/docs/en/settings, cited in a comment; read the page, do not guess) with keys `forceLoginOrgUUID`, `forceLoginMethod`, `apiKeyHelper` or a credential-named `env` key; the profile's user `settings.json` (`<claude dir>/settings.json`) and the project's `.claude/settings.json` and `.claude/settings.local.json` with `apiKeyHelper` or a credential-named `env` key. Credential-named means a name in `PROFILE_CREDENTIAL_ENV` or matching the pattern of item 1. A warning is `{source: anthropic_profile | managed_settings | user_settings | project_settings, key}` with `key` from the closed set of names above or `env`; its text names the source and the key, never a value; an unreadable or malformed file gives `could not read <source>` and nothing of its content.
6. **Commands** (`cmd-profile.ts`, testable like `runConfigCommand`, `profile` added to `SUBCOMMANDS_WITH_ARG_LIST`):
   - `remi profile ls`: the built-in first ("default (built-in): your existing sign-ins; remi changes nothing"), then each profile as `<id>  <label>` with "(machine default)" when it is, and one line per configured harness: `claude: signed in`, `signed out`, `not its own sign-in (<source>)` or `unknown (<reason>)`; checks run at most two at a time; never a path, an email or an `env` value.
   - `remi profile show <id>`: label, id, machine default or not, default harness, `args`, `folders` and per harness `dir` and `expects` (this is the person's own terminal, so local paths are shown), `env` names only (never values), the sign-in line as in `ls`, and the warnings.
   - `remi profile add <id> --label <text> [--claude] [--codex] [--expects subscription|api_key] [--claude-dir <path>] [--codex-dir <path>]`: at least one of `--claude`, `--codex` (a `--claude-dir` implies `--claude`, a `--codex-dir` implies `--codex`); `--expects` defaults to `subscription` and applies to every harness added; validation uses the same validators as loading; the new text is the existing file plus one appended block (a blank line, `[profiles.<id>]` with `label`, then one table per harness with `dir` only when given and `expects`), TOML-escaped, parsed and validated with the real loader before anything is written, then written to a temporary file in the same directory with the original file's mode (0600 for a new file), fsynced and renamed over `config.toml`; nothing else in the file changes. A refused `add` writes nothing. It creates the default directories (mode 0700) for harnesses without an adopted directory; an adopted directory must already exist and is never created or changed. It prints the next step, `remi profile login <id>`.
   - `remi profile login <id> [--harness claude|codex]`: refused unless standard input and output are terminals ("run this in your own terminal"); `--harness` is required when the profile configures both; creates the profile's default directory if missing; runs `claude auth login` or `codex login` with the item 3 environment, `stdio: inherit`, reading none of its output; returns its exit code. A Codex sign-in is refused, with nothing spawned, unless the profile Codex home's `config.toml` sets `cli_auth_credentials_store = "file"` explicitly, because `codex login` under a keychain store could overwrite a keychain entry shared by every `CODEX_HOME` (pack review D3; P1B relaxes this only if P1C says "separated"); the refusal text is P1B design item 3c's: `Profile <id> keeps its Codex sign-in in the system keychain, which Codex does not keep apart per profile. Add this line to <CODEX_HOME>/config.toml and sign in again: cli_auth_credentials_store = "file"`.
7. **Documentation in the repository:** `docs/agent-reference/profiles.md` says what this slice ships (configuration, resolver, check, warnings, the four commands) and what it does not (no launch follows a profile until P1B; no protocol), and `AGENTS.md` gets one pointer line to it.
The implementer may choose: file and function names inside `profiles/`, how the command handler is split, test names, the exact wording of `ls` and `show` lines other than the strings fixed above.

Never do: run a real login; read or print a credential, a keychain entry, `~/.claude*`, `~/.codex*` or `~/.config/anthropic` of the owner; write the owner's `~/.remi/config.toml`; log any part of a status command's output.

## Acceptance

Evidence folder: `/Volumes/S1/yooz/remi/artifacts/profiles-epic-2026-11/P1A/r1/`.
1. Configuration tests cover a full valid example and each refusal of design item 1 (bad id, reserved `default`, 33 profiles, email-shaped label with the exact text, unsafe label characters, missing `expects`, unknown key, relative `dir`, one folder in two profiles, an unknown `[profiles] default`, a credential-named `env` key, an `env` name in `REMI_SECRET_ENV`); a test shows a config without `[profiles]` loads exactly as on `origin/develop` apart from the empty `profiles` member.
2. The resolver matrix: flag over variable over folder over machine default over built-in; nested folders pick the longest; `/a/b` does not match `/a/bc`; a symlinked `cwd` resolves to its target; `default` selects the built-in; an unknown id is refused naming `remi profile ls`.
3. `login-check` with fake `claude` and `codex` executables printing the documented shapes covers every mapping row of design item 4, the timeout (a fake that sleeps past a 500 ms deadline returns `unknown`/`timeout` and leaves no child process: check the pid you spawned), and a missing executable; a fake printing a claude.ai-shaped answer with planted marker strings in `email`, `orgId`, `orgName`, `subscriptionType` and `planTier` returns `signed_in` and the markers appear in no return value, no captured log line and no file under the test's `REMI_HOME` (scanned).
4. A characterization test, skipped with a clear reason when `Bun.which('claude')` is null, runs the installed `claude auth status --json` under `env -i` with an empty scratch `CLAUDE_CONFIG_DIR` and gets `signed_out`, then with `ANTHROPIC_API_KEY=placeholder-not-a-credential` and `expects = "subscription"` gets `not_own_login` with source `ANTHROPIC_API_KEY`; its output is quoted in the evidence folder.
5. Each warning source of design item 5 produces its warning from a temporary directory, and planted values in those files (an `apiKeyHelper` command, `env` values) appear in no warning text.
6. Through the real CLI entry (`env -i HOME=$T PATH=$FAKES:/usr/bin:/bin REMI_HOME=$T/remi bun /Volumes/S1/worktrees/remi/profiles-p1a/packages/daemon/src/cli.ts profile add ...`): `add` appends exactly one block, the earlier bytes of an existing `config.toml` are unchanged (prefix comparison), the result loads, and the default directories exist with mode 0700; an email-shaped label, a taken id, a 33rd profile and a missing adopted directory are each refused and leave `config.toml` byte-identical (SHA-256 before and after).
7. Through the real CLI entry with fake executables: `ls` prints each sign-in state of design item 6 and the built-in first; `show` prints `env` names and never a planted `env` value; neither prints a planted email marker.
8. `remi profile login` run without a terminal is refused and the fake executable's invocation log stays empty; a Codex profile whose home has no `config.toml`, or one with `cli_auth_credentials_store = "keyring"`, is refused for `login --harness codex` with the item 6 text and reported `unknown (not_checked)` by `ls`, and the fake `codex`'s invocation log stays empty; with `"file"` both proceed (with a terminal simulated only through the handler's injectable terminal check, never a real login).
9. `bun test packages/daemon/tests/pty-child-env-secrets.test.ts packages/daemon/tests/harness/harness-boundary.test.ts packages/daemon/tests/license-boundary.test.ts` passes, and removing one name from `PROFILE_CREDENTIAL_ENV` while it is still used makes the guard test fail (revert check, log in the evidence folder).
10. Revert checks, each with its isolated failing log in the evidence folder: drop the email-shape test (item 1 fails), turn the folder boundary into a plain prefix (item 2 fails), accept any `authMethod` for `subscription` (item 3 fails), log the raw status output (item 3's marker scan fails).
11. The PR body states what ships (the model, the check, the warnings, four commands), what does not (no launch follows a profile until P1B; the `claude.ai` value is read from the 2.1.325 binary and unconfirmed until OG-P1), and uses only "Part of #1748".

## Gates

`bun test packages/daemon/tests/profiles packages/shared/tests` passes; `bunx biome check .` ends with no errors; `bun run typecheck`, `bun run typecheck:web`, `bun run typecheck:web-tests` and `bun run typecheck:signaling` pass; `bun scripts/third-party-notices.ts --check` passes; `typos` on the changed files is clean; `git diff --check origin/develop...HEAD` prints nothing; a final `bun test packages/daemon` passes, or fails only in tests that also fail on `origin/develop`, each named in the report.

## Stop conditions

The configuration cannot be added without changing how an existing table loads; a test would need a mock that replaces the loader, the resolver or the check; anything would read a real credential, the owner's Claude or Codex directories or `~/.remi`; the managed-settings path cannot be confirmed from Claude Code's documentation (report it; do not guess).

## Report

The preamble's report, plus one line per acceptance item with its test or command, the final `PROFILE_CREDENTIAL_ENV`, and the head after one push.
