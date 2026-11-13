# Checkpoints

Each checkpoint wakes the intermittent lead (runbook section 9).
The lead reads only what its row lists, decides, updates cards if needed, and rewrites `lead.md`; the manager runs the anticipation pass and the batched questions, and pushes the pack branch.

| ID | Trigger | Lead reads | Lead produces | Owner |
| --- | --- | --- | --- | --- |
| CP0 | before the first tick | the whole pack | pack-review dispositions (plan Appendix A) | approved the defaults and answered Q1, Q4, Q5, Q6, Q8, Q9, Q10 on 2026-11-12; Q2, Q3, Q7 open |
| CP1 | L01 to L06 each `done` or `dropped` (board step CP1) | `status`, the merged PR list, any open advisor rulings, Q11 and Q12 answers, `risks.md` R1 to R5 and R11 | a `decide` line starting `CP1:` (go, or adjust with card edits) for L07 and L08; any dropped-dependency rulings | digest; Q11 and Q12 if still open |
| CP2 | L99 `done` | `status`, `risks.md`, the L13 command list | confirm the late phases may start; P01 and A01 to `todo` | runs L13's commands |
| CP3 | P01's design PR is ready | the design doc, the simulator evidence | the P02 card (implementation slices, visual acceptance gate) | approves or changes the design; merges the design PR or tells the manager to |
| CP4 | A03's PR is ready | the ADR, the epic draft, the A02 findings and their dispositions | final note of what is decided and what is not | approves; files the epic and issues by the listed commands |

Digest format (five lines, skill's `references/escalation.md`): what merged, the critical-path item and its date, idle capacity, budget used against limits, the decisions waiting.
