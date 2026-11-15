# Card P5A-PREP: prepare the owner's usage-limit capture for #1752 (OUTLINE)

Status: outline
Tier: worker
Timebox: S, 4 hours
Needs: none
Depends: CP1 (the lead completes this card there)
Branch: `docs/issue-1752-capture-guide` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/profiles-p5a-prep`
Plan: plan.md section 2 (P5A-PREP); issue #1752 "Test approach" ("Agents may prepare the capture configuration")

## Goal

An owner-facing capture procedure in `.context/` lets the owner, the next time a real session reaches a usage limit in normal work, record remi's hook trace and a PTY capture for each #1752 question, with redaction steps, so the characterization needs no agent at capture time.

## Context

Verified on `develop` `c9e13967`; re-verify at CP1.
- Opt-in diagnostics exist: `REMI_HOOK_DEBUG` (`packages/daemon/src/hooks/hook-server.ts`), `REMI_QUESTION_TRACE=1` (`session/question-trace.ts`, writes `question-trace.jsonl` under the remi home), and the PTY capture of `pty/pty-capture.ts`; `debug/provenance.ts` describes them.
- #1752's questions (Claude hooks and screen at a limit, the hub child as "your own terminal", the stop path; Codex TUI and frames; whether `/model` or `/usage-credits` can be sent) and its acceptance (signatures with negative controls, a go or no-go per harness, no credential file opened).
- Captures can hold prompts, output and account details: the procedure ends with redaction before anything is committed, and nothing is committed by an agent from a real capture.

## Scope

Draft: one new `.context/profiles-5a-capture.md` (procedure, environment variables, where files land, redaction checklist, what to hand back), the PR body; no product code unless the CP1 lead finds a capture gap that needs a small, separately reviewed change.

## Decided design

Draft for the CP1 lead: which switches are set on which process (hub, child), how long captures are kept, and the hand-back format that a later agent turns into fixtures.

## Acceptance

To be made literal at CP1: the procedure names each #1752 question and the file that answers it; `typos` is clean; no em dashes (`rg '\x{2014}'` prints nothing).

## Gates

`typos` on the file; `git diff --check origin/develop...HEAD`.

## Stop conditions

The procedure would need an agent to run a real session, read a credential or keep an unredacted capture.

## Report

The preamble's report.
