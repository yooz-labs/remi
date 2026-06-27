# AskUserQuestion terminal-UI interaction model (#627 spike)

Captured 2026-06-27 from live Claude Code sessions (Opus 4.8) via `REMI_PTY_CAPTURE`
(see `packages/daemon/src/pty/pty-capture.ts`). Four captures, preserved as fixtures
in `packages/daemon/tests/fixtures/auq/`. This is the ground truth the answer driver
is built on. **Re-verify on Claude Code releases** — the renderer is undocumented
and can drift (cf. ExitPlanMode order, #598).

## Shape

AskUserQuestion renders an interactive **tabbed form**, NOT a numbered prompt:

```
←  ☐ Color   ☐ Fruits   ✔ Submit   →
```

- One tab per sub-question, in `tool_input.questions[]` order, **plus a trailing
  Submit (review) tab — but ONLY when there is more than one question OR a
  multi-select question** (see "Submit step is conditional").
- The checkbox next to each question tab is its answered state: `☐` → `☒`.

## Keys (footer: "Enter to select · Tab/Arrow keys to navigate · Esc to cancel")

| Intent | Key | Bytes |
|---|---|---|
| Switch question tab | `←`/`→`, `Tab`/`Shift-Tab` | `\x1b[D`/`\x1b[C`, `\t`/`\x1b[Z` |
| Move option cursor `❯` | `↑`/`↓` | `\x1b[A`/`\x1b[B` |
| Single-select: choose cursor option | `Enter` | `\r` |
| Multi-select: toggle cursor option `[ ]`↔`[✔]` | `Space` (also `Enter`) | `\x20` |
| Submit (on review tab "Submit answers") | `Enter` | `\r` |
| Cancel whole prompt | `Esc` | `\x1b` |

Cursor starts on the FIRST option when a tab opens; `↑`/`↓` move exactly one option.

## Per-mode behavior (observed)

- **Single-select**: `❯ 1. Red / 2. Green / 3. Blue`. `Enter` selects the cursor
  option. If more tabs remain it **auto-advances** to the next tab; if it is the
  last unanswered input it triggers submit (see below).
- **Multi-select**: `❯ [ ] Apple / [ ] Banana / … / [ ] Type something / Submit`.
  `Space` toggles the cursor option (does NOT advance). The trailing `Submit` item
  + `Enter` (or `→`/`Tab`) leaves the tab.
- **Review/Submit tab**: `Review your answers  ● <question> → <label>[, <label>…]`
  then `Ready to submit your answers?  ❯ 1. Submit answers  2. Cancel`. `Enter` on
  "Submit answers" submits. Result → transcript `User answered Claude's questions:`.

## Submit step is CONDITIONAL (the key finding)

| Configuration | Submit step? | Canonical keystrokes |
|---|---|---|
| 1 question, single-select | NONE — pick submits immediately | `↓×i`, `Enter` |
| 1 question, multi-select | yes (can't auto-submit a toggle) | toggle…, then Submit item/review `Enter` |
| 2+ questions | yes (explicit Submit tab) | answer each, then review `Enter` |

So the driver must NOT hardcode "send a final Enter": a lone single-select would get
a stray Enter into the shell. **Observe closure instead of predicting it.**

## Closure detection (drives the loop)

The daemon already sees both signals that the tool has CLOSED (answer accepted):

1. **`PostToolUse(AskUserQuestion)`** hook fires when the tool completes.
2. The PTY prints **`User answered Claude's questions:`**.

The driver answers, then watches for closure. If closed → done. If still open after
the per-question keystrokes → it is on the review screen → verify, then `Enter` to
submit. Loop until closed or timeout.

## Driver design (#627)

1. From the Phase 2 hook `questions[]` we know each sub-question's type
   (single/multi) and option count — no need to parse the option list off-screen.
2. Per question, send keystrokes open-loop from the target answer:
   - single-select target i: `↓×i`, `Enter` (auto-advances).
   - multi-select target set S: from cursor 0, for each s∈S ascending: `↓×(s-prev)`,
     `Space`; then advance toward the review (`→`/`Tab`).
3. After the keystrokes, monitor closure. If not closed, the review tab is up:
   parse `● <q> → <labels>` and compare to the target. **Only send the submit
   `Enter` when the review matches**; otherwise `Esc` + surface the raw prompt
   (graceful degradation — never submit a wrong answer; a stray remote answer is
   worse than "answer it in the terminal").
4. Bound by a max-iteration + timeout → `Esc` + surface raw.

## Never-stuck safeguards (the real goal — #627)

The priority is NOT "handle every variant" but "never leave the user stuck with a
blocked Claude they can't resolve remotely". Layers:

1. **Remote Escape/Cancel — always available.** Every question card exposes a
   Cancel control that sends `Esc` to the PTY, which cancels the AskUserQuestion
   (Claude proceeds with a cancelled tool result). This is the floor: whatever the
   state — driver failed, design-graphics variant, free-text, a future renderer we
   don't understand — the phone can always unblock Claude. The daemon sends `Esc`
   for the active prompt's session regardless of whether it understood the prompt.
2. **The driver NEVER auto-cancels the user's intended answer.** On timeout/failed
   verification it does NOT press `Esc` itself (that would discard what the user
   wanted). It leaves the prompt up and flips the card to "couldn't auto-answer —
   Cancel, or answer in terminal", handing the decision back to the user.
3. **Visible status + counter.** The card shows `auto-answering… (Ns)` →
   `submitted` / `needs you`, so a stall is observable, not silent.
4. **Bounded loop.** Max keystrokes + a hard timeout; the runner can never spin.

## Variants to TOLERATE (escalate to manual for v1)

- **Free-text "Type something"**: each question can carry a trailing free-text
  option; answerable later by navigating to it, `Enter`, typing the note, `Enter`.
  Out of scope for v1 select/multi-select driving — escalate (show raw) if chosen.
- **Design-graphics options**: a richer variant renders a TUI graphic per option
  (the assistant draws each design); the option bodies are not plain labels. The
  driver should detect it can't confidently map options → escalate (show raw),
  never guess.
