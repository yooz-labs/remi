# Card A2: profiles in the apps 2: profile manager with sign-in, Check, settings and copyable commands (issue #1789) (OUTLINE)

Status: outline
Tier: worker-hard
Timebox: L, 2 days; escalate at 4 days or two failed approaches
Needs: xcode
Depends: CPA2 (after A1 merged; the lead completes this card there)
Branch: `feature/issue-1789-apps-profiles-2` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/profiles-a2`
Plan: plan.md section 2 (A2); issue #1789 (all of it); ADR 0051 A1 to A4, A13, A14 and the "Profiles list", "Profile detail: sign-in", "Profile detail: settings (read only)" and "Add, Rename, Remove and sign-in guides" state tables

## Goal

On an iPhone, an iPad or a Mac, a person sees each profile's sign-in per harness with its age, asks the machine to check again, reads the profile's settings, and adds, signs in to, renames, removes or lists profiles by copying commands the machine wrote; the app never writes configuration, runs a command or signs in.

## Context

Verified on `develop` `c9e13967`; re-verify at CPA2. A1's models and Profiles list; the P2C fixtures; `RemiMacCommandRules` (tests in `RemiKit/Tests/RemiKitTests/RemiMacCommandRulesTests.swift`) for the menu command's shortcut; the visual gate and consent rule as in A1; the app documentation gate (each guide links to the docs guide, headings fixed by DOCS-P2).

## Scope

Draft: RemiKit decoders for `profile_status_response`, `profile_settings_response`, `profile_guide_response`, `HubCapability.profileStatus`, the list and detail screens, guides with Copy (and Share on iPhone and iPad), picker warnings in A1's Profile row, the offline last-known list cleared by Forget machine, tests, previews, PARITY.md, PR body.

## Decided design

Draft for the CPA2 lead: the source guard that no new file executes a command; the persisted last-known list's shape (no path, email or environment value can be in it, since none is on the wire).

## Acceptance

From #1789, to be made literal at CPA2 (each checkbox a named test or command), including the unknown-value item (no "Expects a subscription" claim for an unknown `expects`), the planted-marker scan over received frames and the persisted store, and the native gates and visual receipt as in A1.

## Gates

As A1, with `-derivedDataPath /Volumes/S1/derived/remi-profiles-a2`.

## Stop conditions

As A1.

## Report

The preamble's report.
