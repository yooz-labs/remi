# Card A01: account switching across sessions, design draft (no code)

Status: ready
Tier: lead
Timebox: M, 1 day; escalate at 2 days
Needs: none
Depends: L99 (all landing steps done or dropped)
Branch: `feature/issue-1157-account-switching-design` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/account-switching-design` (create it per the preamble)
Plan: plan.md section 5.2; followed by A02 (Fable review) and A03 (owner checkpoint CP4)

## Goal

A draft ADR and a phased epic (titles and bodies of the issues, not filed) for remi sessions that move between Claude Code and Codex accounts, grounded in what the installed CLIs and their documentation actually expose, with no implementation code.

## Context

- Owner idea: track usage per account; at about 98 percent, notify the user and compact the session, then switch smoothly to another account the user has and continue the work; let sessions with different scopes use different logins.
- Existing issue #1157 "Profiles: per-session subscriptions and settings bundles" (open, owner idea of 2026-10-03, with verified facts about `CLAUDE_CONFIG_DIR`); `.context/issue-1595-backend-plan.md` lists "Login/settings profiles" as approved-but-unbuilt; `packages/daemon/src/cli.ts` already reads `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, and `harness/codex/codex-socket.ts` resolves the app-server socket under `CODEX_HOME`. Build on these; do not restart them.
- Installed on 2026-11-12: Claude Code 2.1.323 (`claude --version`), codex-cli 0.167.0 (`codex --version`).
- Harness seam: ADR 0032 and ADR 0033 (`.context/decisions/`), `AGENTS.md` "Architecture" and `docs/agent-reference/harnesses-and-codex.md`.
- Competitive context for A02: `.context/competitive-review-2026-10.md`.

## Scope

May change (new files only): `.context/decisions/NNNN-account-switching.md` (NNNN = the next free number in `.context/decisions/` on `origin/develop` at dispatch, 0049 or later; add it to the decisions README index), and `.context/account-switching-epic.md` (the epic and its phase issues, each body one paragraph per line, ready for `gh issue create --body-file`).
No source, test, config or workflow changes.

## Decided design

Settled:
- Research before design: every statement about a CLI's usage signal, login, compaction, session resume or config location cites one of: the command and its output (help text, `--version`, a status command that prints no secret), the vendor documentation URL with the date read, or remi source with file and line.
- Never read, print or copy credentials, tokens, keychain items or the contents of `~/.claude` or `~/.codex` auth files; list file names only if needed.
- Separate verified from proposed; a gap is written as a gap, not filled.
- Cover: usage signals per CLI (what exists, its granularity and latency); what "98 percent" can be measured against; compaction (who triggers it, what is preserved); switching (new process with another config directory, resume of the same session id or a new session with a summary); scopes (per project, per session group, per remote request); what a phone shows and when; failure modes (switch mid-turn, held prompts, approvals in flight, a second account also near its limit, a revoked login); and provider terms of service on multiple accounts and automatic switching, quoted with URLs.
- The epic's phases are ordered so the first phase is useful alone (for example per-session profiles from #1157) and automatic switching comes last, behind an owner decision.
The lead may choose: the architecture and the phase boundaries.

## Acceptance

1. `claude --help`, `codex --help`, `codex login --help` and every other non-secret command used are quoted in an appendix with their versions.
2. The ADR has sections: Context, Verified facts (with citations), Options considered, Proposed decision (marked proposed, not accepted), Consequences, Open questions for the owner (each with a recommended option).
3. The epic file lists the epic and at least three phase issues with acceptance criteria and test approach (no mocks that replace business logic).
4. A draft PR into `develop` ("Part of #1157"), never marked ready by this card; the manager records its number for A02.

## Gates

`typos .context/decisions .context/account-switching-epic.md` is clean; `git diff --check origin/develop...HEAD` prints nothing; `git diff --name-only origin/develop...HEAD` lists only the two new files and the decisions README.

## Stop conditions

A needed fact can only be learned by reading a credential or by an account-backed model call (list it as unverified instead); the design needs a provider capability that does not exist (say so; do not invent one).

## Report

The preamble's report, plus the ADR number and the list of owner questions.
