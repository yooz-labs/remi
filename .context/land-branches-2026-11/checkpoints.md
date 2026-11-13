# Checkpoints

Each checkpoint wakes the intermittent lead (runbook section 9).
The lead reads only what its row lists, decides, updates cards if needed, and rewrites `lead.md`; the manager runs the anticipation pass and the batched questions, and pushes the pack branch.

| ID | Trigger | Lead reads | Lead produces | Owner |
| --- | --- | --- | --- | --- |
| CP0 | before the first tick | the whole pack | pack-review dispositions (plan Appendix A) | approves the plan, Parity, Slots, Budget, merge authority; answers Q1 to Q10 |
| CP1 | L01 to L06 each `done` or `dropped` | `status`, the merged PR list, any open advisor rulings, `risks.md` R1 to R4 | go or adjust for L07 and L08 (chunk cards still right after the develop merges?) | digest only |
| CP2 | L99 `done` | `status`, `risks.md`, the L13 command list | confirm the late phases may start; P01 and A01 to `todo` | runs L13's commands |
| CP3 | P01's design PR is ready | the design doc, the simulator evidence | the P02 card (implementation slices, visual acceptance gate) | approves or changes the design; merges the design PR or tells the manager to |
| CP4 | A03's PR is ready | the ADR, the epic draft, the A02 findings and their dispositions | final note of what is decided and what is not | approves; files the epic and issues by the listed commands |

Digest format (five lines, skill's `references/escalation.md`): what merged, the critical-path item and its date, idle capacity, budget used against limits, the decisions waiting.
