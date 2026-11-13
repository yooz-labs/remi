# Card L12: legacy route writer characterization tests (#1641), only if Q6 says land

Status: dropped (Q6, owner 2026-11-12: fold into the first #1641 implementation PR; branch kept); kept for reference only
Tier: worker
Timebox: S, 4 hours; escalate at 1 day
Needs: xcode
Depends: none; not dispatched (Q6 answered fold)
Branch: feature/issue-1641-native-wss-route (no PR; head `0c075a28`, 28 behind develop)
Worktree: `/Volumes/S1/worktrees/remi/native-wss-route` (exists, clean)
Plan: plan.md section 1, #1641 row

## Goal

`NativeWSSLegacyWriterCharacterizationTests.swift` lands as a test-only PR that pins the shipped route reader and writer's behavior with unknown secure fields, as the migration hazard #1641's design must handle.

## Context

- One file, 92 lines, three tests with isolated `UserDefaults` keys; the #1641 issue's "N2a migration checkpoint" comment records that they passed on 2026-10-31 and what they show (unknown secure fields are dropped by the old writer; a stale loaded writer can overwrite an incompatible sentinel).
- #1720 (L07) adds lines to `MachineConfigurationStore.swift`, which these tests call; `git merge-tree` showed no conflict.

## Scope

May change: the merge commit from `origin/develop`; the one test file only if the develop merge breaks its compilation; the PR.

## Decided design

Settled: the tests describe current behavior; the file's doc comment and the PR body say they will change deliberately when #1641's secure route schema lands.
The implementer may choose: nothing else.

## Acceptance

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit --filter NativeWSSLegacyWriterCharacterizationTests` passes after the develop merge (3 tests); a PR into `develop` with "Part of #1641".

## Gates

`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock swift test --package-path packages/native/RemiKit`; `typos`; `git diff --check origin/develop...HEAD`.

## Stop conditions

A test fails on the merged head (the shipped behavior changed: report it, do not edit the expectation).

## Report

The preamble's report.
