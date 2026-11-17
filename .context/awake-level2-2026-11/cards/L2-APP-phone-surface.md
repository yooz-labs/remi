# Card L2-APP: the phone surface for keep-awake (issue #1773, slice 4)

Status: outline
Tier: worker-hard
Timebox: L, 2 days (set at CP-HW; may split into a protocol card and a web card)
Needs: none for the protocol and web parts; the native apps are later work
Depends: CP-HW (OG-L2 passed)
Branch: `feature/issue-1773-keep-awake-app` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/awake-app`
Plan: plan.md section 2 (L2-APP); ADR 0050 slice 4 (line 146), the `allow_phone` row, ADR 0012, ADR 0014, ADR 0024, ADR 0035, ADR 0037

## Goal

The phone sees whether the Mac is held awake, by which level, why and for how long, and whether level 2 is armed, disarmed or on (and whether a period started automatically), and, only after the owner set `allow_phone = true` on the Mac, an authorized device can start, arm and stop level 2.

## Context

Completed by the CP-HW lead.
Known now: ADR 0050 slice 4 names `keep_awake_status` and start and stop messages in the registry (ADR 0012), a `keep_awake` capability (ADR 0035) added by the change that ships it, conformance with both endpoints constructed (ADR 0014), and a phone start that needs `allow_phone = true` on the Mac and an authorized device (ADR 0024, 0037); web first, native after.
Armed mode (Q1 (b), plan section 6a): the status carries the state (`disabled`, `armed`, `disarmed`, `starting`, `on`, `reverting`), the origin of a running period and the last refusal; Q11 decides whether an automatic start and its end push to the phone; Q10 (b), if chosen, uses the same remote-client information this card exposes.
Collision: the profiles plan's protocol steps (P2B, P2C, P3B, P4A, P4B) change `packages/shared/src/protocol.ts`, `protocol-version.ts`, `packages/daemon/src/cli/capabilities.ts` and the fixture builders; this card runs only when none of them is `active` or `review`, and the second to merge regenerates fixtures.

## Scope

To be set at CP-HW: `packages/shared/src/protocol.ts` and its fixtures, `cli/capabilities.ts`, the hub's handler beside the L2-HUB endpoint, `config/config.ts` (`allow_phone`, one commit per preamble item 9), the web client's settings or status surface, docs.

## Decided design

Settled at CP-HW, from OG-L2's results and the owner's answer on where the state shows.

## Acceptance

Set at CP-HW, at least: golden fixtures generated; conformance tests construct both endpoints; a device without `allow_phone` is refused; `bun test packages/shared/tests` and the power tests pass in the canonical environment.

## Gates

The preamble's TypeScript gates, `typos`, and hosted CI with the `local-relay` soak.

## Stop conditions

Set at CP-HW.

## Report

The preamble's report.
