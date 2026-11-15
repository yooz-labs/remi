# Card A4: profiles in the apps 4: compact a session and read its handoff brief (issue #1791) (OUTLINE)

Status: outline
Tier: worker
Timebox: L, 1.5 days; escalate at 3 days or two failed approaches
Needs: xcode
Depends: CPA4 (after CP4 and A3 merged; the lead completes this card there)
Branch: `feature/issue-1791-apps-profiles-4` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/profiles-a4`
Plan: plan.md section 2 (A4); issue #1791 (all of it); ADR 0051 A10, A13, A15

## Goal

From an iPhone, an iPad, a Mac or the web, a person compacts a session or reads its handoff brief from the session's actions menu, each shown only when the machine lists its capability; summaries and briefs are held in memory only.

## Context

Verified on `develop` `c9e13967`; re-verify at CPA4. The iPhone "Session actions" menu (`packages/native/iPhone/SessionScreen.swift:418`), the Mac session detail, the web chat header menu (`packages/web/src/components/chat/ChatHeader.tsx:60-82`); the P4A and P4B fixtures; this slice touches native and web, so it runs the native gates and all four type checks; the app documentation gate links to the guide section fixed by DOCS-P4.

## Scope

Draft: native and web menu items, request handling, result sheets, tests, previews, PARITY.md, PR body.

## Decided design

Draft for the CPA4 lead: the in-flight guard; the container listing in the integration test.

## Acceptance

From #1791, to be made literal at CPA4 (each checkbox a named test or command), including native gates under the Xcode lock and `bunx biome check .`, all four type checks and `bun test` for the web part. Also, from ADR 0051 (pack review D24): the session detail says "Default sign-in" while only the default is shared (Q3), and every interface text says "profile", never "account" except for the provider's account itself (Q4), checked by a source scan of the new strings.

## Gates

As A1, plus the preamble's TypeScript gates; `-derivedDataPath /Volumes/S1/derived/remi-profiles-a4`.

## Stop conditions

As A1.

## Report

The preamble's report.
