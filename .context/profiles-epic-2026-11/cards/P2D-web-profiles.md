# Card P2D: the web client's badge, picker, filter chip and Profiles section; the Telegram label (issue #1749, slice 4 of 4) (OUTLINE)

Status: outline
Tier: worker
Timebox: L, 1.5 days; escalate at 3 days or two failed approaches
Needs: none
Depends: P2C
Branch: `feature/issue-1749-web-profiles` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/profiles-p2d`
Plan: plan.md section 2 (P2D); issue #1749 "Web client" and its web acceptance items; ADR 0051 A2 to A6, A13, A14

## Goal

The web client shows a profile badge on the session card and chat header (none on cards while only the default is shared), offers only selectable profiles in the new-session sheet with the hub's default and reason preselected, narrows the session list with a profile filter chip, and has a Profiles section in Settings with sign-in, Check, read-only settings, defaults and copyable guides; Telegram shows the label.

## Context

Verified on `develop` `c9e13967`; re-verify at CP1.
- `packages/web/src/components/session/SessionCard.tsx:47, 86` (harness label), `components/session/NewSessionModal.tsx` (no harness picker; recent or typed directory), `components/settings/SettingsPanel.tsx:455-570`, `components/chat/ChatHeader.tsx:60-82`, `hooks/useConnectionManager.ts:192, 1152` (`hubSupport`).
- The web type checks are `bun run typecheck:web` and `bun run typecheck:web-tests`; shared code must avoid ES2024 built-ins (the web compiles it).
- Two-sided conformance tests construct the real daemon handler and the real web decoder (ADR 0014).

## Scope

Draft: `packages/web/src/` components, hooks and decoders for the P2B and P2C messages, the Telegram adapter's label, web component tests, PR body.

## Decided design

Draft for the CP1 lead: component placement following ADR 0051 A5 and A6 for the web; the copy action; how the unknown-value fixture renders (A8).

## Acceptance

From #1749, to be made literal at CP1: against a daemon without the capability the picker is hidden; the picker offers only selectable profiles and preselects the hub's default with its reason; the filter chip narrows only the session list; no badge on cards while only the default is shared; the web renders an unknown expectation as unknown, never signed in; two-sided conformance with the real daemon handler.

## Gates

`bunx biome check .`, all four type checks, notices, `typos`, the web tests named at CP1.

## Stop conditions

A daemon change is needed (stop; it belongs to P2B or P2C).

## Report

The preamble's report.
