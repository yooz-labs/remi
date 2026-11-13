# Lead continuity (cap: 40 lines, 3,000 characters; prune, never append history)

## Decisions in force
2026-11-12: Owner: image-availability lands alone (L14); native-images parked as evidence (L08 dropped).
2026-11-12: Owner: #1720 parked until #1727 is resolved (L07 blocked as parked, not dropped).
2026-11-12: Owner: #1728, #1657, #1512 get one RV-delta review from their recorded heads.
2026-11-12: Owner: Mac test gate is one bounded attempt; on a stall, hosted swift test, logged.
2026-11-12: Owner: #1731 fix approved; L06 after L03 with the plan's negative controls.
2026-11-12: Owner: fix PRs may merge into a step's head branch only, after the same gate.
2026-11-12: Owner: Codex rules installed for the loop; the develop-unchanged check stays.
2026-11-12: Owner: full access for native cards in a clean worktree; Luna second reviewer on L03, L06.
2026-11-12: Owner: #1512 phone gate kept; #1711 parked; #1641 folded; defaults approved.
2026-11-12: Merge gate: fresh base, named checks, closing-reference scan, DV after each merge.
2026-11-12: A01 stays behind L99 (owner instruction).

2026-11-13: Owner: manager and lead (never workers) may file issues, open/edit/close PRs, push to develop, upload to TestFlight, delete done branches and worktrees. Not main, no force-push.

2026-11-13: Owner: worker slots on Codex and Claude both maximized (no Codex-to-Claude ban); reviewers Sonnet only, advisor Opus only (no Luna reviewer); the lead is this session.

## Open risks
2026-11-12: develop has no CI on push; DV is the only check (R12).
2026-11-12: L14 frame guard in RemiConnection.swift after #1724 (R3).

## Next intentions
2026-11-12: L01 fix round (findings in artifacts L01/r2); L02 round 3 and L04 running; L03 needs its Luna contract reviewer when a Luna slot frees.
2026-11-12: CP1 after L01 to L06: confirm landing state; rule on any dropped dependency.

## Pending owner questions
none open (Q16: no PR for #1727 yet; Q17: hosted native CI accepted for L03's local pairing baseline).
