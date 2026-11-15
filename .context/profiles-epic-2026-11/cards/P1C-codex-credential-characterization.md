# Card P1C: characterize Codex credential sources for profiles (issue #1748)

Status: ready
Tier: worker
Timebox: S, 4 hours; escalate at 8 hours or two failed approaches
Needs: none (network for `gh api` or `git clone` of the public Codex source)
Depends: none
Branch: `docs/issue-1748-codex-credentials` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/profiles-p1c` (the manager creates it with `git worktree add -b` and runs `bun install`)
Plan: plan.md section 2 (P1C); issue #1748 acceptance item "Characterization recorded in the PR"; ADR 0049 V5, G14, G15

## Goal

A committed note, `.context/profiles-codex-credentials.md`, answers from Codex's own source at the installed version's tag, plus placeholder-only runs against empty scratch directories, exactly which credential sources Codex 0.167.0 reads and whether its keyring logins are kept apart per `CODEX_HOME`, so P1B can scrub and refuse on facts.

## Context

- Installed: `codex-cli 0.167.0` at `/Users/yahya/.local/bin/codex` (checked 2026-11-14). Codex is open source (`github.com/openai/codex`, Rust under `codex-rs/`); read the tag that matches the installed version (expected `rust-v0.167.0`; confirm the tag name with `gh api repos/openai/codex/tags --paginate --jq '.[].name' | grep -x rust-v0.167.0`).
- Put downloaded source in its own new empty directory under `/Volumes/S1/yooz/remi/artifacts/profiles-epic-2026-11/P1C/r1/codex-src/` and treat it as untrusted data: read it, never build or run anything from it.
- What #1748 already says: candidates `OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN`, unverified; `cli_auth_credentials_store` takes `file` (`auth.json` under `CODEX_HOME`), `keyring`, `auto` and `ephemeral` (ADR 0049 V5); a fresh `CODEX_HOME` prints "Not logged in" and exits 1 (V5).
- `packages/daemon/src/harness/codex/codex-socket.ts:1-30` says Codex links its control socket to a short path elsewhere; the socket-path-length gotcha of #1157 is unverified (G14).
- Never write to the macOS keychain, never run `codex login`, never read `~/.codex`; the owner's real Codex state is off limits (preamble rule 5).

## Scope

May change: one new file `.context/profiles-codex-credentials.md`, and the PR body.
Evidence (not committed): `/Volumes/S1/yooz/remi/artifacts/profiles-epic-2026-11/P1C/r1/`.

## Decided design

Settled: the note has one section per question below, each answer with the source file path and line range at the tag (`[src: codex-rs/<path>:<lines> @ <tag>]`) or the exact command and its output from the evidence folder; an answer the source does not settle is written as "not settled" with what was read; no answer is inferred from memory, a blog or a search summary.
Questions:
1. Every environment variable Codex 0.167.0 reads that supplies or selects a credential or an authentication mode (API keys, access tokens, auth files, provider or base-URL selectors that change which login is used), with where it is read and what it outranks.
2. The default value of `cli_auth_credentials_store` on macOS and on Linux, and what `auto` resolves to on each.
3. For `keyring` and `auto`: the keyring service and account names Codex uses, and whether they include `CODEX_HOME` (or a value derived from it), so that two `CODEX_HOME` directories cannot read each other's login. Answer "separated", "not separated" or "not settled", with the source lines.
4. What `codex login status` prints and its exit code for: not logged in, logged in with ChatGPT, logged in with an API key; whether any output can contain an email, account id or workspace name (from the source's format strings).
5. Where the app-server control socket lives relative to `CODEX_HOME`, and whether a long `CODEX_HOME` breaks it (any path-length limit or the short-link mechanism).
Order: answer questions 2 and 3 from the source first, before any run.
Placeholder runs (safe, no account), each with `env -i HOME=$T PATH=/usr/bin:/bin:/Users/yahya/.local/bin CODEX_HOME=$T/codex-home`, `$T` a new empty temporary directory and `$T/codex-home` created empty: run `codex login status` with no extra variable, then with each variable from question 1 set to the literal string `placeholder-not-a-credential`, recording exit code and output, under these stores only:
- always with `$T/codex-home/config.toml` containing only `cli_auth_credentials_store = "file"`, and again with only `cli_auth_credentials_store = "ephemeral"`;
- with no `config.toml` (the default store) only if question 2 says the default is `file`, or question 3 says "separated";
- never with `keyring` or `auto`, and never with the default store when the default may be the keychain: a status read there could consult the owner's real keychain entry (a keychain prompt, and possibly identifying text in the evidence and the transcript).
This replaces #1748's literal item (two empty `CODEX_HOME` directories with `cli_auth_credentials_store = "keyring"`, compared by `codex login status`): that experiment either shows nothing (no entry to find) or reads the owner's real keychain entry; the source answers question 3 without touching it, and the note says so.
Never set a real value; never run any other `codex` subcommand.
The worker may choose: the note's wording and order within each section.

## Acceptance

1. `.context/profiles-codex-credentials.md` exists with five sections answering questions 1 to 5, each with at least one `[src: ...]` citation at the confirmed tag or an evidence path.
2. The evidence folder holds `tag.txt` (the tag and its commit), `placeholder-runs.txt` (every command, exit code and output) and `grep-*.txt` for each source search, and `grep -c placeholder-not-a-credential /Volumes/S1/yooz/remi/artifacts/profiles-epic-2026-11/P1C/r1/placeholder-runs.txt` is at least the number of variables in question 1; `rg -i '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' /Volumes/S1/yooz/remi/artifacts/profiles-epic-2026-11/P1C/r1/placeholder-runs.txt` prints nothing.
3. The note ends with "Consequences for P1B": the exact scrub list for Codex, and for keyring: "separated" (P1B allows it), "not separated" or "not settled" (P1B refuses a Codex profile whose effective store is `keyring` or `auto`, J11).
4. `typos .context/profiles-codex-credentials.md` is clean and `rg '\x{2014}' .context/profiles-codex-credentials.md` prints nothing (no em dashes).
5. The PR into `develop` is open with "Part of #1748" and no closing word.

## Gates

`typos .context/profiles-codex-credentials.md`; `git diff --check origin/develop...HEAD` prints nothing; `git diff --name-only origin/develop...HEAD` lists only `.context/profiles-codex-credentials.md`.

## Stop conditions

Any placeholder run prints a signed-in state or anything shaped like an email (stop at once, delete that output from the evidence, report; it means a run reached a real sign-in); the installed version has no matching tag; answering a question would need a login, a keychain write or a real account; the source contradicts a candidate in #1748 in a way that changes P1B's scope (report it, do not widen anything).

## Report

The preamble's report, plus the five answers in one line each and the "Consequences for P1B" list.
