# Lead continuity (cap: 40 lines, 3,000 characters; prune, never append history)

## Decisions in force
2026-11-12: Pack review applied: CP1 gates L07 and L08; L14 added; L08 depends on L03 only.
2026-11-12: Merge gate: fresh base, named checks, closing-reference scan, DV after each merge.
2026-11-12: Never proceed with a missing review report; cross-chunk reviewer per big PR.
2026-11-12: A01 stays behind L99 (owner instruction; reviewer's capacity idea rejected).
2026-11-12: Owner approved Parity, Slots, Budget, develop-only merge authority.
2026-11-12: Owner: full access for native cards in a clean worktree; Luna second reviewer on L03, L06, L08-R4.
2026-11-12: Owner: #1512 phone gate kept; #1711 parked; #1641 folded. Q4 suspended by Q11.
2026-11-12: Native gates run under the Xcode lock; Fable only for A02.

## Open risks
2026-11-12: native-images commit 40fb479f would close #1313 (R11).
2026-11-12: develop has no CI on push; DV is the only check (R12).
2026-11-12: Local Mac xcodebuild test stall (R2, Q2).

## Next intentions
2026-11-12: CP1: go or adjust for L07 and L08 once Q11, Q12 are answered.

## Pending owner questions
2026-11-12: Q2 (Mac test gate) blocks L03, L04.
2026-11-12: Q3 (#1731) blocks L06; Q7 (#1727 files) blocks L10.
2026-11-12: Q11 (native-images vs image-availability) blocks L08, L14.
2026-11-12: Q12 (#1720 park or review-only) blocks L07.
2026-11-12: Q13 (review rounds) sets the review form of L02, L03, L09.
2026-11-12: Q14 (Codex rules install), Q15 (fix-PR merges).
