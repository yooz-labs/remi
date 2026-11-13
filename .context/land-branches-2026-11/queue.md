# Queue: slots and collisions

The board's Steps order is the dispatch priority; `manager_board.py status` places each ready step on the first slot (in Slots order) that takes its tier and can do what it needs.
This file lists, per slot, the cards in priority order with their entry condition, and every pair of steps that can touch the same files.

## Per slot

| Slot | Cards in order | Entry condition |
| --- | --- | --- |
| codex-terra (1) | L03, L06, L08, L09 | L03 after Q2; L06 after L03 merges and Q3 approves; L08 after L03 and L06 merge; L09 after L01, L07, L08 (Q1: phone gate kept, so it merges only after the owner's check) |
| codex-luna (2) | L01, L02, L04, L05, L07, L13 (plus Q9's Luna reviewers for L03, L06, L08-R4) | L01, L02 now; L04 after Q2; L05 after L03; L07 after L03, L04, L05; L13 after L99; L11, L12 dropped (Q5, Q6) |
| claude-opus (1) | P01, A01, A03, lead wakes, advisor consults | P01 and A01 after L99; A03 after A02 |
| claude-fable (1) | A02 | after A01 |
| claude-sonnet (2) | reviewers and synthesis agents, never a step | runbook section 8, reviewer concurrency |

The Xcode lock serializes native gate runs across all slots (runbook section 8).

## Collisions

Observed with `git merge-tree --write-tree` on 2026-11-12 (sequential merges simulated in the planned order).

| Pair | Shared files | Rule |
| --- | --- | --- |
| L03, L08 | `Transport/RemiConnection.swift` (conflicts) | L08 after L03 merges; L08's worker resolves against #1724's child-authority fence; chunk L08-R4 reviews the resolution |
| L03, L06 | `Transport/RemiConnection.swift` (merges clean in simulation) | L06 after L03; L06 merges develop before its final gates |
| L06, L08 | `Transport/RemiConnection.swift` (L08 conflicts after L03 + L06) | L08 after L06; one resolution covers both |
| L03, L05, L07 | `Store/MachineStore.swift` | L05 and L07 after L03; each merges develop before its gates |
| L05, L07 | `iPhone/PhonePreferences.swift`, `Store/MachineStore.swift` | L07 after L05 |
| L04, L07 | `Tests/RemiKitTests/SessionAddressingTests.swift` (conflicts: identical test added twice) | L07 after L04; L07's merge keeps develop's copy and drops the branch's duplicate |
| L03, L04 | `Tests/RemiKitTests/ChildRouteOriginTests.swift` (merges clean) | may run together; the second to merge takes develop in and reruns its gates |
| L04, L05 | `Mac/MacLiveRootView.swift` (L04 changes its question lookup; L05 already conflicts there) | may run together; L05 merges develop after L04 merges if L04 lands first, and the advisor's resolution check covers both |
| L01, L09 | `AGENTS.md` (conflicts) | L09 after L01; L09's merge keeps the split layout and moves any #1512 AGENTS.md text to the matching `docs/agent-reference/` file |
| L09, all | `.github/workflows/*` (Bun pin) | L09 last among code steps: after it merges, CI runs on Bun 1.4.2, and any open PR must merge develop and rerun |
| L05 | `Mac/MacLiveRootView.swift` (conflicts with develop today) | L05's worker resolves; advisor verifies the resolution (no third review round) |
| P01, P02 | `RemiUI/RemiBoard.swift`, `RemiUI/RemiLayoutMode.swift` | P02 after the owner approves P01 |
