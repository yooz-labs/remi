# Card A3: profiles in the apps 3: usage with Refresh, the usage warning and Claude Code's limit wait (issue #1790) (OUTLINE)

Status: outline
Tier: worker-hard
Timebox: L, 2 days; escalate at 4 days or two failed approaches
Needs: xcode
Depends: CPA3 (after CP3 and A2 merged; the lead completes this card there)
Branch: `feature/issue-1790-apps-profiles-3` off `origin/develop`
Worktree: `/Volumes/S1/worktrees/remi/profiles-a3`
Plan: plan.md section 2 (A3); issue #1790 (all of it); ADR 0051 A7 to A9, A12 to A14 and the "Usage section, view and Refresh" and "Session badge" state tables

## Goal

A person sees each profile's usage per window with source, age and reset time, refreshes it, gets one `usage_warning` (on by default, with the plaintext-exposure footnote of the owner's Q7), and sees when Claude Code waits for a reset; nothing is invented, extrapolated or summed.

## Context

Verified on `develop` `c9e13967`; re-verify at CPA3.
- The sealed push codec maps each kind to one byte and rejects an unknown byte as malformed (`packages/native/RemiKit/Sources/RemiPush/NativePushCodec.swift:10-19`); an informational payload has no category (no lock-screen actions); `usage_warning` gets a new byte matching P3B's `PUSH_KIND_BYTE`.
- The P3B fixtures and the daemon's real sealed-push encoder and shared text builder are the test inputs; the owner's signed-device recheck of the panel against `/usage` and `/status` is an owner gate (owner-gates.md OG-A3).
- Visual gate, consent rule and app documentation gate as in A1 (the usage view links to the guide's "Usage" section, fixed by DOCS-P3).

## Scope

Draft: RemiKit models for `profile_usage_response`, `profile_usage_update`, refresh outcomes, `limitWait`, the codec kind, the usage section and view, Refresh, markers, the per-device switch in iPhone Preferences and Mac Settings registered on `register_device_token`, the Inbox notice row, tests, previews, PARITY.md, PR body.

## Decided design

Draft for the CPA3 lead: the codec byte (must equal P3B's); a fixed clock for every age and reset test.

## Acceptance

From #1790, to be made literal at CPA3, including the codec test (a capsule from the daemon's real encoder decodes with the shared builder's title and body and no actions; an unknown byte is still malformed), the threshold marker table test, the neutral tone of the notice row, and the native gates and visual receipt as in A1; `privacy` lens in review. Also, from ADR 0051 (pack review D24): the session detail says "Default sign-in" while only the default is shared (Q3), and every interface text says "profile", never "account" except for the provider's account itself (Q4), checked by a source scan of the new strings.

## Gates

As A1, with `-derivedDataPath /Volumes/S1/derived/remi-profiles-a3`.

## Stop conditions

As A1, plus: the codec byte or text builder output differs from P3B's.

## Report

The preamble's report.
