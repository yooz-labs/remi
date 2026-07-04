# Transcript-binding e2e harness

A **manual / semi-automated** end-to-end harness that drives **real `claude`
sessions** under a **real remi daemon** and validates the session-binding +
transcript-watcher subsystem (the TranscriptBinder, epic #453) against the
historical failure modes.

Unlike `tests/integration/` (Docker, cross-machine `ls`/`attach` lifecycle) and
`tests/e2e/specs/` (Playwright web UI), this harness exercises the part that
needs a live model: a real `claude` writing real transcripts and rotating them
via `/clear` and `/compact`, observed from a separate client the way the phone
would.

It is **not wired into CI** — it needs an authenticated `claude` and a trusted
working directory, and it drives a TUI with timing-sensitive input. Run it by
hand when changing the binding/rotation code.

## What it validates

The `TranscriptBinder` has run as the single, unconditional binding path since
#503/#470 — there is no alternate path or shadow-comparison mode left to
distinguish scenarios by. Two scenarios remain, split by daemon topology:

| Scenario | Failure modes | Key checks |
|---|---|---|
| 1. Single daemon | fm-430, fm-438, fm-452, GAP-6 | binder drives the bind (`[Binder] Lock adopted from binding store`); `/clear` rotates exactly once, caught either by the hook path (`Claude restart detected`) or the re-arming dir-poll (`No-hooks rotation detected via dir poll`, the #452 backstop); rebound + watcher rearmed; follow-up routes to the new transcript; old transcript frozen; no "Transcript not found"; `/compact` does not rotate or over-fire the dir-poll |
| 2. Two daemons, same cwd | fm-427, fm-451 | distinct binds, content segregated (ALPHA↔D1, BETA↔D2), per-port `remi:<port>` markers; zombie sibling (dead claude child, live wrapper) does **not** poison the other daemon's binding |

Hooks are up in scenario 1, so whether the hook path or the dir-poll observes
a `/clear` rotation first is a genuine race (a local `readdir` tick vs. a hook
POST round-trip), not a bug either way — `run.sh` reports which mechanism won
as informational rather than requiring the dir-poll specifically. Only fm-452
(hooks forced **down**, manual-only) proves the dir-poll as the sole path; see
`failure-mode-matrix.md`.

See `failure-mode-matrix.md` for the full per-mode repro + oracle reference and
the two non-negotiable traps (assert the on-disk id actually changed; in the
zombie variant kill the inner claude child, never the wrapper).

## Prerequisites

1. **A remi binary built from the branch under test:**
   ```bash
   bun build --compile --outfile=/tmp/remi-tb/remi packages/daemon/src/cli.ts
   ```
2. **An authenticated `claude`** (`claude -p "say OK" --model haiku` returns).
3. **A claude-trusted working directory.** claude shows a one-time
   "Do you trust the files in this folder?" dialog in a new directory, which
   blocks an unattended session. Use a directory you have already opened claude
   in (`hasTrustDialogAccepted: true` in `~/.claude.json`). Trust is keyed by
   path, so an already-trusted scratch path can be recreated and reused. Do
   **not** disable the permission framework to work around this.

## Run

```bash
REMI_BIN=/tmp/remi-tb/remi \
E2E_TRUSTED=/private/tmp/your-trusted-scratch-dir \
  tests/e2e/transcript-binding/run.sh
```

Exit code = number of failed checks. Daemon logs and the captured client
renders are left in the printed `E2E_STATE` dir for inspection.

## How it works (notes for maintainers)

- `--daemon` mode does **not** forward `claude` args, so the model is set via
  `ANTHROPIC_MODEL=haiku` (the daemon's env is merged into the claude PTY).
- The driver is a persistent `remi attach` whose stdin is a FIFO held open by a
  background `sleep`; it is both the input channel and the observer (the real
  client path). claude's composer treats the first burst as a bracketed paste,
  so a prompt is submitted with a **separate** Enter keystroke.
- The oracle is the daemon log: the `[Binder] …` bind/rotation lines
  (`Lock adopted`, `Transcript from`, `Claude restart detected`, `No-hooks
  rotation detected via dir poll`) and `owned by port X, not Y; ignoring`
  (marker-based sibling/zombie defer), plus the on-disk `<id>.jsonl` files. See
  `failure-mode-matrix.md` → "The oracle" for the full list and how it
  changed after the shadow-mode differential harness was deleted (#470).
