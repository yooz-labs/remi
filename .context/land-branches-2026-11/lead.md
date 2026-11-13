# Lead continuity (cap: 40 lines, 3,000 characters; prune, never append history)

## Decisions in force
2026-11-12: Owner approved Parity, Slots, Budget and develop-only merge authority (merge commits).
2026-11-12: Owner: Codex full access for native cards only, in a clean worktree; others workspace-write.
2026-11-12: Owner: Luna second reviewer on L03, L06, L08-R4 only, on top of Sonnet.
2026-11-12: Owner: #1512 phone gate kept; image-availability folded; #1711 parked; #1641 folded.
2026-11-12: Path chunks, not commit ranges, for L07 and L08 review (commits interleave).
2026-11-12: Fresh round 1 for #1728, #1657, #1512 (earlier reviews not on the PR); none for #1707.
2026-11-12: Native gates run under the Xcode lock; slots do not serialize Xcode.
2026-11-12: Fable only for A02; ordinary advice stays on Opus.

## Open risks
2026-11-12: L08 RemiConnection.swift resolution against #1724's fence (R3).
2026-11-12: Local Mac xcodebuild test stall (R2, Q2).
2026-11-12: Pack review by two independent reviewers in progress; dispositions go to plan Appendix A.

## Next intentions
2026-11-12: CP1 after L01 to L06: confirm chunk cards still fit after develop merges.

## Pending owner questions
2026-11-12: Q2 (Mac test gate) blocks L03 and L04.
2026-11-12: Q3 (#1731 fix) blocks L06.
2026-11-12: Q7 (#1727 local files) blocks L10.
