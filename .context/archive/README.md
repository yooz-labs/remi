# Archive

Development documents that recorded a moment rather than a standing rule.
They are kept for history, not for guidance:
nothing here is guaranteed to describe the current system,
and where an archived note disagrees with the live docs, the live docs win.

Standing decisions live in [`../decisions/`](../decisions/) as Architecture Decision Records (ADRs).
Current state lives in [`../handoff.md`](../handoff.md).

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
