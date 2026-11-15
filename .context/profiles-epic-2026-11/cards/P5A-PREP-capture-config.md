# Card P5A-PREP: prepare the owner's usage-limit capture for #1752

Status: ready
Tier: worker
Timebox: S, 4 hours; escalate at 8 hours or two failed approaches
Needs: none
Depends: CP0 (completed by the lead at CP0, pack review D18: a real usage limit can be hit before CP1, and this card does not depend on profiles)
Branch: `docs/issue-1752-capture-guide` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/profiles-p5a-prep` (the manager creates it with `git worktree add --no-track -b` and runs `bun install`)
Plan: plan.md section 2 (P5A-PREP); issue #1752 "Questions", "Acceptance criteria" and "Test approach" ("Agents may prepare the capture configuration")

## Goal

A committed owner-facing procedure, `.context/profiles-5a-capture.md`, lets the owner, the next time a real session reaches a usage limit in normal work, record remi's hook trace, question trace and a PTY capture that answer each #1752 question, redact them, and hand them back, so the characterization needs no agent at capture time.

## Context

Verified by the lead on `develop` `c9e13967`; re-check each line at the PR head:
- `REMI_HOOK_DEBUG=1` makes the hook server append every raw hook payload to `hook-diag.jsonl` in the remi home of the process (`packages/daemon/src/hooks/hook-server.ts:281-299`).
- `REMI_QUESTION_TRACE=1` appends question-lifecycle records to `question-trace.jsonl` in the remi home (`packages/daemon/src/session/question-trace.ts:1-30, 162`).
- `REMI_PTY_CAPTURE=/path/to/file` appends every byte written to and read from the agent's PTY to that file, bounded at 10 MB with `.1` and `.2` rotation and a `.lock` file (`packages/daemon/src/pty/pty-capture.ts:1-30`); point it at a file of its own.
- `packages/daemon/src/debug/provenance.ts` explains that these sinks are keyed on environment variables and are marked when written under `bun test`.
- No switch captures Codex app-server frames: no `REMI_` variable is read under `packages/daemon/src/harness/codex/` (grep at `c9e13967`). #1752's Codex frame questions are answered from the PTY capture and remi's daemon log, or recorded as a capture gap.
- A hub child inherits the hub's environment (`packages/daemon/src/cli/daemon-manager.ts:619-633`), so switches set on a hub reach its children; the owner's real hub runs from a LaunchAgent with its own environment.
- #1752's questions: the hooks that fire at a Claude limit and their order (`StopFailure` with `rate_limit`, `Notification` with `quota_auto_resume_*`, or neither); what the screen shows (the two footer lines, and the usage-limit options menu that `promptUp` would report as a numbered menu); whether Claude Code treats a hub child's PTY as "your own terminal"; whether a Stop (a forced close while a menu is up) leaves the transcript intact and resumable; for Codex, what the TUI shows, which frames arrive and whether an overlay waits for input; for both, whether `/model` or `/usage-credits` can be sent safely or only shown.
- Captures can hold prompts, output, account details and an email. Nothing from a real capture is committed by an agent, and nothing is committed before the owner redacts it.

## Scope

May change: one new file `.context/profiles-5a-capture.md`, and the PR body.
Evidence (not committed): `/Volumes/S1/yooz/remi/artifacts/profiles-epic-2026-11/P5A-PREP/r1/`.

## Decided design

Settled: the procedure has these sections, in this order:
1. "When to use this": opportunistically, when a session in normal work is near or at a usage limit; never by starting work to reach one.
2. "Set up a capture session": two recipes, each with the exact commands copied from the build's own `--help` at the PR head (verified, quoted in the evidence): (a) a wrapper session in the owner's terminal with `REMI_HOOK_DEBUG=1`, `REMI_QUESTION_TRACE=1` and `REMI_PTY_CAPTURE` pointing at a capture file of its own, for `remi` and for `remi codex` (each with its own capture file); (b) for the hub-child question, a second, separate hub with its own absolute `REMI_HOME` (for example `~/.remi-capture`) and a port above 18790, started with the same three variables, and a session started through it; the real hub on 18765 is not restarted or changed.
3. "What answers each question": a table with one row per #1752 question naming the file (`hook-diag.jsonl`, `question-trace.jsonl`, the PTY capture, the daemon log) and what to look for; the Codex frame row says that no switch captures them today and what the PTY capture can still show.
4. "The stop path": how to stop the session at the limit through remi (the Stop the apps send, which force-closes while a menu is up), and how to check afterwards that the transcript is intact and `--resume` works, all at the owner's terminal.
5. "Redact before anything is kept": remove prompts, agent output, file paths, account and plan details and any email; keep hook event names and their order, time deltas, and the footer and menu line shapes with clock times replaced by `HH:MM`; never open or copy a credential file.
6. "Hand back": the owner writes `.context/profiles-5a-result.md` (or gives the redacted files to an agent) with `claude --version`, `codex --version`, one answer per question, and the go or no-go per harness #1752 asks for; agents only turn a recorded signature into fixtures afterwards.
The worker may choose: wording, and examples that use invented names only.

## Acceptance

1. `.context/profiles-5a-capture.md` exists with the six sections of the decided design, and its question table has one row per #1752 question.
2. Every command in the file appears in the build's help output: the evidence folder holds `help.txt` from `env -i HOME=$T PATH=/usr/bin:/bin:$(dirname "$(command -v bun)") REMI_HOME=$T/remi bun packages/daemon/src/cli.ts --help` run in the worktree at the PR head (a new temporary `$T`), and each subcommand and flag the procedure uses is found in it (a short check, its output quoted).
3. `typos .context/profiles-5a-capture.md` is clean, `rg '\x{2014}' .context/profiles-5a-capture.md` prints nothing, and `rg -i '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}' .context/profiles-5a-capture.md` prints nothing.
4. The PR into `develop` is open with "Part of #1752" and no closing word.

## Gates

`typos .context/profiles-5a-capture.md`; `git diff --check origin/develop...HEAD` prints nothing; `git diff --name-only origin/develop...HEAD` lists only `.context/profiles-5a-capture.md`.

## Stop conditions

The procedure would need an agent to run a real session, read a credential, restart or reconfigure the owner's real hub, or keep an unredacted capture; a switch named in the Context no longer exists at the PR head (report; do not invent one).

## Report

The preamble's report.
