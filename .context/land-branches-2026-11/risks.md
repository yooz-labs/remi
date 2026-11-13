# Risks (pre-registered)

| ID | Risk | Observation | Read by | If it reads bad | Decides |
| --- | --- | --- | --- | --- | --- |
| R1 | Hosted native job flakes (#1634: signal 11 in the test helper, deadline timing) | a `Build and Test (Native)` failure that passes on rerun | every native PR | one rerun; second flake in seven days: lead diagnosis card | manager, then lead |
| R2 | Local Mac `xcodebuild test` stalls before loading a bundle (seen on #1728) | the L03 bounded attempt times out | L03 | Q2 decides the gate for every native step | owner |
| R3 | The L08 `RemiConnection.swift` resolution weakens #1724's child-authority fence or the image-begin authority | L08-R4 findings; the merge's `git show --cc` | L08 review | Critical: fix before merge; contested: advisor | advisor |
| R4 | Codex sandbox blocks SwiftPM or xcodebuild writes under `~/Library` | the first native Codex dispatch | L03 | Q10 answered (2026-11-12): native cards run with full access in a clean worktree; other Codex cards stay workspace-write | owner |
| R5 | Review bandwidth (2 Sonnet sessions) makes L07 and L08 wait days | reviewers queued for more than one tick | L07, L08 | do not start both chunked reviews at once; finish L07's round before L08's | manager (literal), lead at CP1 |
| R6 | A merge turns `develop` red | the first `develop` run after each merge | every merge | stop merging; advisor; revert only by the owner's decision | advisor, owner |
| R7 | #1512 changes CI to Bun 1.4.2 while PRs are open; #1206 (a 1.4.2 hang) is still open | `Test` jobs after L09 merges | L09 | L09 stays last; if a hang recurs, file it on #1206 and ask the owner whether to revert | owner |
| R8 | A PR body overstates what ships (native-images ships gated off; #1720 and #1707 lack signed-device acceptance) | the body at the merge gate | L05, L07, L08 | send back inside the round: the body says what ships and what is unverified | manager (literal) |
| R9 | The local Bun (1.4.4) differs from CI's pin (1.3.11) | a local TS gate passes and CI fails, or the reverse | L02, L09 | hosted CI is authoritative; record both | manager |
| R10 | Disk on `/Volumes/S1` (1.1 TB free on 2026-11-12) fills with DerivedData | `df -h /Volumes/S1` under 100 GB | each checkpoint | ask the owner before deleting anything not created by this plan | owner |
