# Archive

Development documents that recorded a moment rather than a standing rule.
They are kept for history, not for guidance:
nothing here is guaranteed to describe the current system,
and where an archived note disagrees with the live docs, the live docs win.

Standing decisions live in [`../decisions/`](../decisions/) as Architecture Decision Records (ADRs).
Current state and the roadmap live in [`../plan.md`](../plan.md).

## 2026-h1

Written between January and May 2026, covering roughly v0.3 through v0.5.
Archived 2026-07-28, during the 0.7.4 development line.

| File | What it is | Superseded by |
|---|---|---|
| [`2026-h1/ideas.md`](2026-h1/ideas.md) | Design concepts and early architecture sketches, last touched 2026-05-01. The product vision at the top still holds; the technical shape described below it does not. | ADRs 0001-0008, and `AGENTS.md` for the current architecture |
| [`2026-h1/research.md`](2026-h1/research.md) | Investigation notes, last touched 2026-03-21. Notably the transcript-format discovery that led to transcript-based content, and the early PTY/ANSI parsing findings. | ADR 0001 (transcript path as source of truth); `TranscriptBinder` in `packages/daemon/src/transcript/` |
| [`2026-h1/scratch-history.md`](2026-h1/scratch-history.md) | Failed attempts and their root causes, last touched 2026-05-01. Still the best record of *why* several guards exist; the `wss://` vs `https://` push bug at the top is the clearest example. | Nothing; kept as the lessons record. The fixes themselves live in the code |

### Reading these safely

Two things in `2026-h1` are actively wrong as of 0.7.3 and will mislead you:

- **Ollama** is retired. Any note describing an Ollama provider, an `11434` port, or a `gemma4`/`qwen3.5` tag pulled through Ollama describes a path that no longer exists. Local evaluation now runs against the Yooz Engine helper on `127.0.0.1:19924` (epic #809).
- **The per-session exclusive lock** is gone. Notes describing one-writer-per-session, FIFO promotion, or `NOT_ACTIVE_CONNECTION` describe removed machinery (#795). Any attached client can write; safety comes from the per-session serialized PTY write queue.

## 2026-h2

Archived 2026-10-06, when the roadmap moved to `../plan.md` and the issue tracker was triaged.
Most of these describe remi's own permission judgment, removed in #1125 ([ADR 0030](../decisions/0030-defer-permission-judgment-to-the-harness.md)), or the notification flow before the held-hook relay (#1126, [ADR 0031](../decisions/0031-held-hook-answers-with-native-dialog-visible.md)).

| File | What it is | Superseded by |
|---|---|---|
| [`2026-h2/handoff.md`](2026-h2/handoff.md) | The working snapshot after the 0.7.3 release (2026-07-28). | `../plan.md` |
| [`2026-h2/notification-and-session-flow.md`](2026-h2/notification-and-session-flow.md) | The question and notification flow diagram as of 2026-04-12. | `AGENTS.md`, "Question Detection and Notifications"; #1145 tracks a new diagram |
| [`2026-h2/approval-rate-baseline-2026-08.md`](2026-h2/approval-rate-baseline-2026-08.md) | Approval-rate and latency baseline of the judge; the evidence ADR 0030 cites. | ADR 0030 |
| [`2026-h2/adherence-baseline-2026-08.md`](2026-h2/adherence-baseline-2026-08.md) | The judge's model-adherence baseline. | ADR 0030 |
| [`2026-h2/permission-bank.md`](2026-h2/permission-bank.md) | The read-only auto-approve replay harness. | ADR 0030 |
| [`2026-h2/plan-eval-quality-and-question-lifecycle.md`](2026-h2/plan-eval-quality-and-question-lifecycle.md) | Evaluation quality and question lifecycle plan. | ADR 0030; the question lifecycle work continues in #888 |
| [`2026-h2/plan-readonly-session-approval.md`](2026-h2/plan-readonly-session-approval.md) | Read-only approval and session precedent plan. | ADR 0028 and ADR 0030 |
| [`2026-h2/plan-semantic-intent-approval.md`](2026-h2/plan-semantic-intent-approval.md) | Semantic intent approval plan. | ADR 0029 and ADR 0030 |
| [`2026-h2/auq-tui-interaction-model.md`](2026-h2/auq-tui-interaction-model.md) | The AskUserQuestion keystroke model of the #627 spike. | ADR 0031 (answers through the held hook, #1127) |
