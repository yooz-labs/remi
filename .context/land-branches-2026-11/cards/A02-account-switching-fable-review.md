# Card A02: Fable advisor review of the account-switching draft (owner-requested)

Status: ready
Tier: frontier
Timebox: S, 4 hours
Needs: none
Depends: A01 (draft PR open)
Branch: none (read-only advisor)
Worktree: none; reads the A01 draft PR by its head commit from `/Users/yahya/Documents/git/yooz/remi`
Plan: plan.md sections 0.6 and 5.2

## Goal

An independent read of the A01 draft for technical nuance and for market position, whose findings the lead folds into the design (A03) before the owner sees it.

## Context

- Model: Claude Fable, dispatched with the Agent tool's `model: fable` (model id `claude-fable-5-2`); the owner asked for Fable for this review only; it is not a default anywhere else in this plan.
- Live facts: the A01 PR number and head commit, the ADR path and `.context/account-switching-epic.md`.
- Also read `.context/competitive-review-2026-10.md` (dated 2026-10-01; it marks its own unconfirmed items) and #1157.
- The brief format is the skill's advisor brief (`references/escalation.md`); output in its format.

## Scope

Read: the A01 ADR and epic at the head commit, the competitive review, #1157, and any public source needed to verify a claim.
Change: nothing; no commits, comments or messages.

## Decided design

Settled: the review answers, with evidence:
1. Usage signals per CLI: are the draft's claims about what Claude Code and Codex expose (and how fresh it is) right for the installed versions, and is "about 98 percent" measurable at all?
2. Compaction safety: what is lost or duplicated when a session is compacted and resumed under another account; held prompts, approvals and turns in flight.
3. Credential handling: where each CLI stores logins, what remi must never touch, and whether per-account config directories leak anything across accounts.
4. Terms of service: what each provider's current terms say about multiple accounts and automatic switching to continue work; quote with URLs and dates; flag anything that could put a user's accounts at risk.
5. Session continuity across accounts: whether resume works across accounts or must start a new session with a summary.
6. Failure modes the draft misses.
7. Market position: how competitors in the review (and any newer entrant) handle multiple accounts or profiles, each claim verified against a current source with URL and date, and whether this feature differentiates remi or creates risk for it.
The advisor may choose: the order and depth of each answer.

## Acceptance

The output follows `references/escalation.md` "Output format": VERDICT, findings table (id, severity, finding, concrete fix), ranked recommendations, top three risks, owner decisions as structured questions with a recommended option, and "Not verified by the advisor"; every competitor and terms claim has a URL and the date read; under 1,500 words.
The manager saves it to `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/A02/review.md` and spends `"Fable consults"`.

## Gates

`gh pr view PR --json headRefOid` (PR from the live facts) equals the head the advisor read; the saved file exists and contains the line `VERDICT:`.

## Stop conditions

The draft PR's head changes during the review: report the head that was read.

## Report

The review in the output format.
