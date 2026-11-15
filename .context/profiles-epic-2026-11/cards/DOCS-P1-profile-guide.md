# Card DOCS-P1: the profile guide and command reference for phase 1 (issue #1748, docs gate)

Status: ready
Tier: worker
Timebox: M, 6 hours; escalate at 1 day or two failed approaches
Needs: docs
Depends: P1B merged into `develop` and its version-bump commit on `origin/develop`
Branch: `docs/remi-profiles` in `yooz-labs/yooz-docs`, off `origin/main` (or the existing branch of an open, unmerged profiles docs PR, named in the live facts)
Worktree: `/Volumes/S1/worktrees/yooz-docs-profiles` (yooz-docs; the manager creates it) and `/Volumes/S1/worktrees/remi/profiles-docs-build` (remi, detached at the live facts' `DEV_SHA`; the manager creates or updates it)
Plan: plan.md section 2 (DOCS-P1); issue #1748 "Additions" documentation checkbox; ADR 0051 A4 "Documentation"

## Goal

A draft pull request in `yooz-labs/yooz-docs` adds `docs/tools/remi/guides/profiles.md` and `docs/tools/remi/commands/profile.md`, documenting exactly what phase 1 ships (the built-in default that changes nothing, the selection precedence, where remi creates a profile's directories, the `[profiles]` keys, `remi profile ls|add|show|login`, `--remi-profile` and `REMI_PROFILE`, and the refusals), where every command and its output come from running the remi build of `DEV_SHA` against a temporary `REMI_HOME`.

## Context

- The docs site is Docusaurus 3.9 (`yooz-docs`, default branch `main`, Bun); remi's pages live under `docs/tools/remi/` (`commands/`, `guides/`, `reference/`; open PR #25 adds `setup/`). Read `AGENTS.md` and two existing pages (`docs/tools/remi/commands/sessions.md`, `docs/tools/remi/guides/hub-mode.md`) for front matter and tone, and `sidebars.ts` for how pages are listed (it lists remi pages explicitly on PR #25's branch; follow what the base branch does).
- The issue's documentation checkbox: `gh issue view 1748 --repo yooz-labs/remi` (section "Additions").
- What phase 1 ships: read `docs/agent-reference/profiles.md` and `packages/daemon/src/profiles/` at `DEV_SHA` in the remi build worktree; the refusal texts and command lines on the pages are copied from that source and from the runs, never paraphrased into something the build does not print.
- The page paths are the ones the issues name; the owner has not confirmed them (plan J4). If the owner's answer differs, the lead changes this card before dispatch.
- Section headings below are fixed because the apps will link to their anchors (A1, A2).
- The docs PR merges for the remi release that ships phase 1 and not before; it is marked ready only at REL-DOCS, and the owner merges it (plan J2). Keep it a draft.

## Scope

May change in `yooz-docs`: new `docs/tools/remi/guides/profiles.md`, new `docs/tools/remi/commands/profile.md`, `sidebars.ts` (only to list the two pages, if the base branch lists remi pages explicitly), `docs/tools/remi/commands/index.md` (one line linking the new reference, if it lists commands), a `[profiles]` section in a remi configuration reference page if the base branch has one, and one `REMI_PROFILE` entry in `docs/tools/remi/reference/environment.md` (it exists on `main`; follow that page's entry format).
May change in remi: nothing (the build worktree is detached and read-only apart from `bun install --frozen-lockfile` and `bun run build:binary`, which writes its own `dist/remi`).
Evidence (not committed): `/Volumes/S1/yooz/remi/artifacts/profiles-epic-2026-11/DOCS-P1/r1/`.

## Decided design

Settled:
1. **Build and run.** In `/Volumes/S1/worktrees/remi/profiles-docs-build`: `git rev-parse HEAD` equals `DEV_SHA`, then `bun install --frozen-lockfile` and `bun run build:binary`; use only that worktree's `dist/remi` (never `/opt/homebrew/bin/remi`, never the main checkout's `dist/`). Each recorded run uses a new temporary directory `$T` and `env -i HOME=$T PATH=$T/bin:/usr/bin:/bin REMI_HOME=$T/remi TERM=xterm-256color`, with `$T/bin/remi` a symlink to that `dist/remi`.
   For `ls` and `show`, `$T/bin` also links the installed `claude` (`/Users/yahya/.local/bin/claude`), with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` in the `env -i` line: against the new, empty profile directories it only reports "not signed in" (the read-only check of ADR 0049 V2); no account is involved.
   For Codex, link the installed `codex` (`/Users/yahya/.local/bin/codex`) only if P1C's note says keychain sign-ins are "separated"; otherwise every recorded Codex profile's home gets a `config.toml` with `cli_auth_credentials_store = "file"` before the run (the build's own refusal text says to add it, and the page shows that step), so no run can read the owner's real keychain entry (pack review D22).
   For `login`, `$T/bin` holds fake `claude` and `codex` scripts that print nothing and exit 0, so only remi's own lines are captured; the page shows the command, remi's lines, and says that the harness's own sign-in follows in the terminal (it is not reproduced).
   No run uses the owner's `~/.remi`, and no run signs in.
2. **The guide** (`guides/profiles.md`), with these `##` headings in this order: "What a profile is", "The built-in default", "How a new session picks a profile", "Create a profile", "Sign in to a profile", "Start a session in a profile", "Profile settings in config.toml", "When remi refuses to start a session", "What remi never does". It covers: the built-in default changes nothing; the precedence (`--remi-profile`, `REMI_PROFILE`, the longest folder mapping, `[profiles] default`, the built-in default) with one example of a folder boundary; where remi creates a profile's directories (`<remi home>/p/<id>/claude` and `.../codex`, never renamed or deleted) and adopting an existing directory; every `[profiles]` key from the build's validator; the email-label refusal text; each refusal text of P1B's design item 3 and 5 as the build prints it; "What remi never does": reads, copies, stores or relays a credential, runs a sign-in from a phone, and reads, stores or shows the email in its own interface (ADR 0049 D10, in plain words); and, so the page does not overclaim (ADR 0011), that the terminal view shows exactly what the harness prints, which can include the email (for example Claude Code's own `/status`), and that "signed in" means the harness reports a stored sign-in, not that remi verified the account. It states the limits of this build where a person would otherwise expect something (for example that a profile cannot be chosen from the phone in this build), and never describes a planned feature.
3. **The command reference** (`commands/profile.md`), one `##` section per command: `remi profile ls`, `remi profile show`, `remi profile add`, `remi profile login`, and "Choosing a profile for a session" (`--remi-profile`, `REMI_PROFILE`); each with its synopsis from the build's help text, every option, one example, and its real output.
4. **Code blocks:** every command a person types is alone in a fenced `bash` block (the site's copy button covers it); output goes in a separate `text` block; nothing in a command block is output or a prompt sign.
5. **Path normalization (one rule for both sides):** in `runs.txt` and on the pages, the literal temporary directory `$T` is replaced by `/tmp/remi-docs`; the check script applies the same replacement before comparing, so "verbatim" means verbatim after that one substitution and nothing else.
6. **Prose source:** semantic line breaks (one sentence per line), American English, no em dashes, the word "profile" everywhere (ADR 0051 Q4), never an email address, never a real path of the owner's machine (use the normalized `/tmp/remi-docs` form of item 5, or `~/...`).
7. **The PR:** a draft into `main`, title "Remi docs: profiles (phase 1)", body: what the pages cover, "Do not merge before the remi release that ships yooz-labs/remi#1748", the remi commit `DEV_SHA`, and a collapsed section with every recorded command, its exit code and its output; it refers to the remi issue only as "Part of yooz-labs/remi#1748".
The implementer may choose: the wording of the prose, the examples' ids and labels (no email shapes), the order of options within a section.

## Acceptance

1. `git -C /Volumes/S1/worktrees/remi/profiles-docs-build rev-parse HEAD` equals `DEV_SHA` before and after the runs, and `git -C /Volumes/S1/worktrees/remi/profiles-docs-build status --porcelain --untracked-files=no` prints nothing.
2. The evidence folder holds `runs.txt` with every command shown on the two pages, each with its `env -i` line, exit code and full output, and every output block on the pages is a verbatim excerpt of `runs.txt` after design item 5's normalization (a check script, `check-output-blocks.ts` in the evidence folder, applies it, compares them and prints "all output blocks found"; REL-DOCS reuses that script).
3. Both pages have the headings of design items 2 and 3 exactly, and `rg -n '^## ' docs/tools/remi/guides/profiles.md docs/tools/remi/commands/profile.md` in the docs worktree lists them.
4. `bun install` then `bun run build` in `/Volumes/S1/worktrees/yooz-docs-profiles` ends without errors, and the build output contains `tools/remi/guides/profiles/index.html` and `tools/remi/commands/profile/index.html` (or the paths the site's routing produces, quoted).
5. `typos docs/tools/remi/guides/profiles.md docs/tools/remi/commands/profile.md` is clean, `rg '\x{2014}' docs/tools/remi/guides/profiles.md docs/tools/remi/commands/profile.md` prints nothing, and `rg -i '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' docs/tools/remi/guides/profiles.md docs/tools/remi/commands/profile.md /Volumes/S1/yooz/remi/artifacts/profiles-epic-2026-11/DOCS-P1/r1/runs.txt /Volumes/S1/yooz/remi/artifacts/profiles-epic-2026-11/DOCS-P1/r1/pr-body.md` prints nothing (the PR body, written to `pr-body.md` before `gh pr create --body-file`, is public and holds every recorded output).
6. The draft PR is open in `yooz-labs/yooz-docs` with the body of design item 7.

## Gates

`bun run build` in the docs worktree passes; `typos` on the changed files is clean; `git -C /Volumes/S1/worktrees/yooz-docs-profiles diff --check origin/main...HEAD` prints nothing; `git -C /Volumes/S1/worktrees/yooz-docs-profiles diff --name-only origin/main...HEAD` lists only files in this card's Scope.

## Stop conditions

Any run prints a signed-in state or anything shaped like an email (stop at once, remove that output from the evidence and the PR body draft, report: a run reached a real sign-in); the build's behavior differs from P1B's card or `docs/agent-reference/profiles.md` (report the difference; do not document either side's claim); a page would need output from a real sign-in or a real account; the base branch's layout makes the issue's paths impossible (report; the lead or owner decides).

## Report

The preamble's report, with `pr` set to the yooz-docs PR number, plus the list of commands recorded and the build route paths.
