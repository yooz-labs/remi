# Risks (pre-registered)

| ID | Risk | Observation | Read by | If it reads bad | Decides |
| --- | --- | --- | --- | --- | --- |
| R1 | Hosted native job flakes (#1634: signal 11 in the test helper, deadline timing) | a `Build and Test (Native)` failure that passes on rerun | every native PR | one rerun; second flake in seven days: lead diagnosis card | manager, then lead |
| R2 | Local Mac `xcodebuild test` stalls before loading a bundle (seen on #1728) | the L03 bounded attempt times out | L03 | Q2 (owner): log the stall and rely on hosted `swift test` | owner |
| R3 | L14's `RemiConnection.swift` frame guard (after #1724 lands) weakens the child-authority fence; L08 is parked (Q11) | L14 contract findings; the develop merge's `git show --cc` | L14 review | Critical: fix before merge; contested: advisor | advisor |
| R4 | Codex sandbox blocks SwiftPM or xcodebuild writes under `~/Library` | the first native Codex dispatch | L03 | Q10 answered (2026-11-12): native cards run with full access in a clean worktree; other Codex cards stay workspace-write | owner |
| R5 | Review bandwidth (2 Sonnet sessions); now small, since L07 and L08 are parked | reviewers queued for more than one tick | every review | dispatch by the concurrency rule; ask the lead if queued two ticks | manager, lead |
| R6 | A merge turns `develop` red | the first `develop` run after each merge | every merge | stop merging; advisor; revert only by the owner's decision | advisor, owner |
| R7 | #1512 changes CI to Bun 1.4.2 while PRs are open; #1206 (a 1.4.2 hang) is still open | `Test` jobs after L09 merges | L09 | L09 stays last; if a hang recurs, file it on #1206 and ask the owner whether to revert | owner |
| R8 | A PR body overstates what ships (native-images ships gated off; #1720 and #1707 lack signed-device acceptance) | the body at the merge gate | L05, L07, L08 | send back inside the round: the body says what ships and what is unverified | manager (literal) |
| R9 | The local Bun (1.4.4) differs from CI's pin (1.3.11) | a local TS gate passes and CI fails, or the reverse | L02, L09 | hosted CI is authoritative; record both | manager |
| R11 | A commit message closes an issue on merge (`close-on-develop.yml`); native-images' `40fb479f` says "closed #1313" | merge gate item 5 output | every merge | owner told before the merge; reopen command after it | owner |
| R12 | `develop` turns red unseen (no CI on `develop` pushes; no required checks) | the DV card after each merge | every merge | stop merging; advisor; owner chooses fix forward or revert (RB) | owner |
| R13 | A full-access native worker merges, closes, posts or pushes outside its branch | `git ls-remote origin refs/heads/develop` and merged-PR list after each run | every full-access run | stop all dispatching; owner | owner |
| R10 | Disk on `/Volumes/S1` (1.1 TB free on 2026-11-12) fills with DerivedData | `df -h /Volumes/S1` under 100 GB | each checkpoint | ask the owner before deleting anything not created by this plan | owner |
