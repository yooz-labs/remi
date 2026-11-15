# Checkpoints

Each checkpoint wakes the intermittent lead (runbook section 9).
The lead reads only what its row lists, completes the cards it names (re-verifying every path and line against the current `origin/develop` and running `manager_board.py card` on each), updates `risks.md` if needed, and rewrites `lead.md`; the manager runs the anticipation pass and the batched questions, notifies the owner with the five-line digest, and pushes the pack branch.
No step after a checkpoint is dispatched before the owner's go is recorded (`decide ... --by owner`).

| ID | Trigger | Lead reads | Lead produces | Owner |
| --- | --- | --- | --- | --- |
| CP0 | before the first tick | the whole pack, the two pack reviews | dispositions in plan Appendix A | approves the plan and its defaults; answers J1a to J18; the lead or the owner records one `CP0:` line per answer and `CP0: plan approved ...`, then sets CP0 `done` (runbook section 2) |
| CP1 | P1B and DOCS-P1 `done` | `status`, the P1A, P1C and P1B PRs and reports, OG-P1 status, `risks.md` R1 to R5, the ADR 0051 PR #1785 | the completed cards P2A, P2B, P2C, P2D, DOCS-P2 and P5A-PREP; an ADR 0049 amendment commit if J12 was yes; `CP1:` | reviews phase 1; approves #1785 (D51); go for phase 2 |
| CP2 | P2D and DOCS-P2 `done` | `status`, the phase 2 PRs, OG-P2 status, the fixtures added | the completed cards P3A, P3B, P3C, DOCS-P3; `CP2:` | go for phase 3 |
| CPA1 | CP2 `done` | the #1788 body, phase 2's fixtures, `packages/native/AGENTS.md`, `VISUAL-ACCEPTANCE.md` | the completed card A1, including the visual capture plan (J10) and the docs URL base; `CPA1:` | go for Apps 1 |
| CP3 | P3C and DOCS-P3 `done` | `status`, the phase 3 PRs, OG-P3 status | the completed cards P4A, P4B, DOCS-P4; `CP3:` | go for phase 4 |
| CPA2 | A1 `done` | A1's PR and visual evidence, the #1789 body | the completed card A2; `CPA2:` | go for Apps 2; a TestFlight build only if the owner asks (go and build number from the owner) |
| CPA3 | CP3 and A2 `done` | A2's PR, phase 3's fixtures and push kind, the #1790 body | the completed card A3; `CPA3:` | go for Apps 3; signed-device recheck OG-A3 after A3 merges |
| CP4 | P4B and DOCS-P4 `done` | `status`, the phase 4 PRs, OG-P4 status | `CP4:`, a one-page note of what shipped and what the owner gates showed | reviews phase 4 |
| CPA4 | CP4 and A3 `done` | A3's PR, phase 4's fixtures, the #1791 body | the completed card A4; `CPA4:` | go for Apps 4 |
| CP5 | OG-5A `done` (the owner recorded #1752's result) | #1752's recorded characterization, ADR 0049 D5 and D8, `.context/account-switching-epic.md` phase 5 draft | a go or no-go note per harness for phase 5; nothing is filed or dispatched | decides whether phase 5 is filed and a new plan written; phase 6 stays not approved (ADR 0049 D9) |

Digest format (five lines, the skill's `references/escalation.md`): what merged, the critical-path item and its date, idle capacity, budget used against limits, the decisions waiting.
