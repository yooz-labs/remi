# Card L2-SLEEPNOW: the third exact sudoers rule, `pmset sleepnow` (issue #1773, conditional)

Status: outline
Tier: worker-hard
Timebox: S, 6 hours (set at CP-HW)
Needs: none
Depends: CP-HW, and only if owner gate OG-L2 step (b) showed that the Mac stays awake after the revert with the lid closed
Branch: `feature/issue-1773-sleepnow-rule` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/awake-sleepnow`
Plan: plan.md section 2 (L2-SLEEPNOW); ADR 0050 lines 103 and 157 (owner decision 6: agreed if the hardware test needs it)

## Goal

When a revert happens with the lid closed, remi also runs `sudo -n /usr/bin/pmset sleepnow` through a third exact rule the owner installs, so a cleared flag never leaves the Mac awake in a bag.

## Context

Completed by the CP-HW lead from OG-L2's recorded result (`pmset -g log` lines around the SIGKILL in step (b)).
Known now: the constants live in `packages/daemon/src/power/level2-commands.ts` (W1); the revert paths are the controller's `disable` (L2-CORE), the watchdog script (W1) and the boot daemon (W1, which runs before login and must not sleep the Mac at boot).

## Scope

To be set at CP-HW: `level2-commands.ts` (a `SLEEPNOW` constant, the sudoers line gaining a third command), `level2-switch.ts`, `watchdog-script.ts`, their tests, `keep-awake.md`, and the setup text.

## Decided design

Settled at CP-HW: when `sleepnow` runs (only after a successful `disablesleep 0` and only while the root domain reads the lid closed), its place in the watchdog, and whether the boot daemon is unchanged.

## Acceptance

Set at CP-HW, at least: the one-constant test covers three commands; `bun test packages/daemon/tests/power` passes in the canonical environment; a repeat of OG-L2 step (b) by the owner passes.

## Gates

The preamble's TypeScript gates, `typos`, and hosted CI with the `local-relay` soak.

## Stop conditions

Set at CP-HW.

## Report

The preamble's report.
