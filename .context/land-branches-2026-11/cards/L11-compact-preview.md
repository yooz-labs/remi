# Card L11: compact preview feasibility probes (#1711), only if Q5 says land

Status: ready
Tier: worker
Timebox: S, 4 hours; escalate at 1 day
Needs: none
Depends: none; dispatched only when Q5's answer is "land"
Branch: feature/issue-1711-compact-preview (no PR; head `fda985af`, 79 behind develop)
Worktree: `/Volumes/S1/worktrees/remi/compact-preview` (exists, clean)
Plan: plan.md section 1, #1711 row

## Goal

The six feasibility files land under `scripts/preview-proof/` as clearly labeled, reproducible research tooling that follows the repository's tooling rules, with a README that says what they show and what they do not.

## Context

- Files: `scripts/preview-proof/corpus.py`, `render.py`, `sandbox-control.py`, `sandbox-targeted-control.py` (Python, importing system Pillow and calling Poppler), `sandbox-probe.c`, `tree-limit.c`.
- `render.py`'s own header: "Local feasibility only: system Pillow/Poppler are not a contained helper."
- The #1711 issue comments record the results and limits (seatbelt read diagnostic, no renderer chosen); receipts are in `/Volumes/S1/yooz/remi/artifacts/preview-qualification-1711-20261030/` and `preview-probe-1711-20261030/`.
- The owner's rules: Python runs through uv only.

## Scope

May change: `scripts/preview-proof/` only (add a README, add PEP 723 inline script metadata so each Python script runs with `uv run --script`); the merge commit from `origin/develop`; the PR.

## Decided design

Settled: no production caller; no CI job runs these; each Python script declares its dependencies inline (Pillow) and is run with `uv run --script`; the README states "feasibility only, not a contained helper", the commands, and the receipts' folder.
The implementer may choose: README wording.

## Acceptance

`uv run --script scripts/preview-proof/render.py --help` or, if the script has no help, `uv run --script scripts/preview-proof/corpus.py` against a temporary folder, runs without import errors (quote the last line); `typos` is clean; a PR into `develop` with "Part of #1711".

## Gates

`typos`; `git diff --check origin/develop...HEAD`; `uvx ruff check scripts/preview-proof` (report findings; fix only syntax errors).

## Stop conditions

A script needs a dependency other than Pillow and the system Poppler binaries; running any script touches files outside a temporary folder.

## Report

The preamble's report.
