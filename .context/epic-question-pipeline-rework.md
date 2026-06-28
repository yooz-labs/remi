# Epic: Question pipeline rework — one gate, structured questions, real summaries

Status: DRAFT (design, pending sign-off) — 2026-06-27

## Why

Two user-reported problems, both rooted in the same architectural flaw.

1. **Phantom questions.** The phone gets permission notifications for actions that
   were already auto-approved by a rule or the LLM.
2. **The new `AskUserQuestion` format is mishandled.** Multi-question design prompts
   (header + per-option descriptions + multiSelect + submit) are not shown properly
   and are not answered properly on a remote phone session.

### Evidence (live log `~/.remi/remi.log`, full history)

| Event | Count |
|---|---|
| Auto-approve **approve** (user should NOT be bothered) | 10,155 |
| Auto-approve **escalate** (user genuinely needed) | 2,903 |
| Auto-approve **deny** | 24 |
| "Question detected" (hook + PTY scrapers firing) | 10,483 |
| Pushes actually sent | ~1,811–2,000 |
| `pending-question cap (8) exceeded` (registry flooding) | 2,458 |
| AskUserQuestion escalations | 393 |
| `cursor seen but <2 options; not surfaced` (AUQ options lost) | 758 |
| **Pushes fired immediately after an `approve`** (confirmed phantoms) | **1,184+** |

"Question detected" text is dominated by PTY screen-scrape garbage:
`Doyouwanttoproceed?` / `Do you want to proceed?` (~2,224), `⏺`/`?`/`[?` (~640),
`Claude needs your permission to use Bash` (3,256).

## Root cause

Three independent emitters push questions to the client and do NOT truly gate each
other:

1. `HookEventBridge` — structured `PermissionRequest` hook (reliable).
2. `OutputProcessor` — scrapes the terminal screen ("Do you want to proceed?"),
   ANSI garbage included.
3. `AutoApproveGate` — the component that actually decides approve/escalate/deny.

A fragile timing layer was grown to reconcile them: `QuestionPresenceTracker`
buffer-window, cross-source `QuestionDedup`, slow-eval push timers, delivery gates.
Under real multi-session load (67 sessions, one daemon) it races and leaks: the PTY
scraper emits + pushes *after* the gate already approved at 0 ms.

The complexity IS the bug. The fix removes sources; it does not add coordination.

## Ground truth: the current AskUserQuestion payload

From a real transcript tool_use input (2026):

```jsonc
{
  "questions": [                       // up to 4
    {
      "question": "Who is the Other Significant Contributor ...?",
      "header": "Collab PI",           // short topic chip
      "multiSelect": false,
      "options": [
        { "label": "Scott Makeig (SCCN/UCSD)",
          "description": "EEGLAB founder; long-standing NIH support ..." },
        ...
      ]
    },
    { "question": "Which tools should this center on?",
      "header": "Software focus", "multiSelect": true, "options": [...] },
    ...
  ]
}
```

Implications:
- Each option already carries an authored `description`. **The "summarize the
  options" content the user wants already exists in the payload** — for
  AskUserQuestion we do NOT need an LLM to summarize; we just stop discarding it.
- `multiSelect: true` exists (pick several).
- `header` is a real per-question field (today it is flattened into the text).
- The tool implicitly allows "Other" free-text.

Today `tool-question.ts` takes only `questions[0]`, treats options as plain strings
(drops `description`), ignores `multiSelect`, and prefixes `header` into the text.

## Answer mechanics (researched + verified against code)

- There is **no hook-response path to answer** an AskUserQuestion. Hooks only
  allow/deny/ask. The answer MUST be injected into the interactive terminal UI as
  keystrokes (the daemon's existing PTY-input channel).
- The current code answers by `submitInput(digit)` — correct for the OLD single
  numbered prompt, wrong for the NEW interactive multi-question UI (arrow / space
  to toggle multiSelect / move between questions / submit).
- The exact key model is version-dependent and undocumented → needs a live capture
  spike, then a closed-loop driver (drive → read PTY back → confirm → submit;
  abort + surface raw on mismatch = graceful degradation).

## Target architecture: one gate, hook-sourced, escalate-only

Lifecycle:
1. `PermissionRequest` hook fires — the ONLY trigger for a client question.
2. Auto-approve gate evaluates → `approve | deny | escalate | pick`.
3. **Only `escalate` produces a client question + push.** approve/deny/pick resolve
   silently via the hook response. No PTY emission, no presence tracker, no buffer.
   (With auto-approve OFF, every hook simply escalates — still one source, the hook.)
4. Question CONTENT is built from structured hook data:
   - AskUserQuestion / design tools → full `questions[]` (header, question,
     options w/ label+description, multiSelect) — no model needed.
   - Generic tools (Bash/Edit/…) → `{ summary, options }` from the deciding LLM
     (same call) or a cheap engine call for rule-escalates.
5. Single emit + push path (`message-api-setup`).
6. Answer from phone:
   - Binary allow/deny shaped → resolve held hook via hook response (no PTY).
   - AskUserQuestion / pick / multiSelect / free-text → release hold to passthrough,
     then the AUQ keystroke driver answers + submits (closed-loop verified).

Demoted / removed:
- `OutputProcessor` QUESTION emission → fallback only when NO permission hook is
  registered for the session. (Keep PTY status parsing for statusline/AA state.)
  For hooked sessions — the norm, and all auto-approve sessions — PTY never emits a
  question. **This kills the phantom at the source.**
- `QuestionPresenceTracker` buffer-window + hook/PTY reconciliation + cross-source
  dedup → removed (one source ⇒ nothing to reconcile). A thin held-hold registry
  remains for answer routing.
- `handleNotification(permission_prompt)` generic push → removed (it duplicates the
  rich `permission_request`).
- Slow-eval early-push timing-race → shrinks (keep delivery-confirmation so Claude
  is not frozen on a dead token).

## Protocol changes (`packages/shared`)

- `Question` gains a discriminator `kind: 'permission' | 'multi_question'`.
  - `permission`: existing single text + options, plus optional `summary` (lock
    screen one-liner).
  - `multi_question`: `questions: QuestionStep[]` where
    `QuestionStep = { header?, text, multiSelect, options: Array<{label, description?}> }`,
    plus `submitLabel`.
- `QuestionOption` gains optional `description`.
- `AnswerMessage` gains a multi-question form: `selections: Array<{ questionIndex,
  optionIndices: number[], freeText?: string }>` (back-compat: keep `answer` for
  binary/single).

## Phasing

**Phase 1 — Single gate (kill phantoms).** Mostly deletion. Escalate-only emission;
demote PTY question emission to no-hook fallback; remove buffer-window + cross-source
dedup; remove generic notification push. Expected: pushes drop from ~2,000 to ≈ the
real escalate count; phantoms gone. Ship first for immediate relief.

**Phase 2 — Structured AskUserQuestion display.** Read full `questions[]` from the
hook; add `multi_question` protocol kind; web + iOS render header chips + options
with descriptions + multiSelect; lock-screen shows a meaningful summary and routes
to the app. Display complete; answering can still resolve the first question until
Phase 3. Solves "title/context/options not shown."

**Phase 3 — Multi-question answer + submit.** Live TUI keystroke-capture spike →
closed-loop `auq-driver`; web/iOS multi-select form with one Submit; batched answer
protocol. The fragile part, isolated and de-risked behind closed-loop verify +
graceful degradation.

**Phase 4 — Summaries for generic escalations.** Extend decision JSON schema with
`summary` + `optionLabels` (returned in the same LLM call, escalate only); cheap
engine call for rule-escalates that had no LLM. AskUserQuestion uses authored
descriptions, so it needs no model.

## Test criteria (no mocks)

- Phase 1: a rule/LLM `approve` produces ZERO client question + ZERO push (unit +
  integration). PTY-only (no-hook) session still surfaces a question. Phantom count
  in a scripted burst → 0.
- Phase 2: real AUQ payload → protocol multi_question with all headers, descriptions,
  multiSelect preserved; web + iOS render verified (Chrome MCP + device).
- Phase 3: closed-loop driver answers a real multi-question AUQ end-to-end against a
  live Claude session; mismatch path surfaces raw prompt instead of a wrong pick.
- Phase 4: escalate verdict carries a sensible summary; latency unchanged for LLM
  escalations (same call).

## Open risks

- Phase 3 TUI driver is version-coupled to Claude Code's AUQ renderer. Mitigations:
  closed-loop verify, central single-module recipe, graceful degradation, a release
  re-verify checklist item (cf. ExitPlanMode order #598).
