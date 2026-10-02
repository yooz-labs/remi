# ADR 0031: Held-hook answers with the native dialog visible

**Status:** accepted; amended by #1127 (AskUserQuestion and ExitPlanMode, below)
**Date:** 2026-10-02
**Owner:** Yahya

> Amends [ADR 0002](0002-model-b-hold-the-hook-notifications.md) (the hold is back, and it no longer hides Claude's dialog) and [ADR 0004](0004-pty-as-arbiter-subagent-questions.md) (a subagent prompt's route depends on whether the session has a local terminal).

## Context

After #1125 (ADR 0030) nothing held a `PermissionRequest`: every hook was answered `passthrough`, Claude rendered its dialog, and a phone answer was typed into that dialog as a digit.
Typing was the weak point: the card's numbering is not the screen's, and a phone "No" typed `4` into a three-option dialog, Claude ignored it, and the Enter that followed confirmed "1. Yes" (#1134).
The #1134 guard (`sameChoice`, an exact label check) made typing fail closed, at the cost of refusing answers.

Two live spikes against Claude Code 2.1.287 (#1126 comments, the lead's scratchpad holds the evidence) overturned the premise that holding hid the dialog:

| Finding | Experiment |
|---|---|
| Claude's native dialog renders about 0.1 s after the hook POST, during the hold; a later hook `allow`/`deny` resolves the dialog already on screen | round 1 |
| A local "Yes" runs the tool, fires `PostToolUse` with the `tool_use_id` of the `PreToolUse` that preceded the `PermissionRequest` (same tool and input, about 10 ms earlier), and never closes the held request | F3 |
| A local "No" or Esc closes the held request (`request.signal` aborts 0-50 ms after the key, clean FIN); no hook fires | F3 |
| At Claude's own hook timeout the request is aborted and nothing is decided; the dialog stays | F5 |
| Claude honors a long registration: with `timeout: 3600` on the HTTP `PermissionRequest` hook, a hold of 650 s was answered at 653.6 s and the tool ran (there is no 600 s ceiling) | #1126 review, protocol lens |
| `setMode` echoed verbatim works; `addRules` works when echoed with `destination: "session"`; an echoed `addDirectories` does not stop the repeat prompt | F4 |
| A deny with a message reaches Claude as the tool result, `is_error: true` | round 1 |
| A background subagent's dialog does not render while its hook is held; after a passthrough it renders on the main screen | F2 |
| In auto mode a classifier block fires `PermissionDenied` (with `tool_use_id`, `reason`) and no `PermissionRequest`; an auto-mode fallback prompt auto-denies after 2:00, counting during a hold | F1a-F1d |
| An auto-mode fallback prompt left unanswered is auto-denied 120.0 s after it appeared, and Claude fires `PermissionDenied` for it (reason: the classifier's) | #1126 lead round, `p3final-auto` |
| A call the session's own allow rules permit fires no `PermissionRequest`, for a background subagent, a foreground subagent and the main agent alike (`Bash(touch p3m-allowed*)` allowed: that `touch` produced only PreToolUse/PostToolUse, the unallowed `touch` control fired `PermissionRequest` each time) | #1126 lead item 3, `p3m2-allowrules-touch` |

## Decision

A binary `PermissionRequest` the phone can answer is held, its card pushed at once by id, and the first answer wins:

- **Phone.** The answer is the hook response, mapped from the card option's meaning, never from a position on the screen: `Yes` -> `allow`; `No` -> `deny`, optionally with the user's message (an `answer` protocol field; no client sends it yet); a standing option -> `allow` + `updatedPermissions`, only for `setMode` and an allow `addRules` (labeled "for this session"), both echoed with `destination: "session"` so a phone tap never writes a settings file (lead decision). `addDirectories` is never offered. Anything a card does not offer is refused and the hold stays. The lock screen's static "Yes, always" (REMI_YNA) is offered only when the standing option is an `addRules` rule; a `setMode` card gets no actionable category and is answered in the app (lead decision). Its static title still overstates what it grants: the grant is scoped to the session, not "always", until the iOS category is retitled (#1141). A hook-less typed prompt (sandbox network, an agent-team dialog) carries no standing-grant kind, so under this narrowing it loses its REMI_YNA actions as well and is answered in the app.
- **Terminal Yes.** The `PostToolUse` or `PostToolUseFailure` whose `tool_use_id` matches the `PreToolUse` paired with the request releases the hold with an empty response (Claude ignores it) and dismisses the card.
- **Terminal No or Esc, or any other close.** The hook server observes the request's abort and dismisses the card.
- **`remi unstick`.** A live hold is released to the terminal like an early release (notice pushed, the prompt kept open there), not closed: its dialog is still on screen (lead decision).
- **Deadline.** In a session with a local terminal (wrapper mode), at `[prompts] hold_seconds` (default 90, 5 to 110: below the 2:00 auto-deny and the 600 s registered hook timeout) remi releases its own hold with an empty response, Claude's dialog stays, the card is dismissed and an "answer at the terminal" notice is pushed (#733). In a daemon or hub session, which has no terminal of its own, the deadline is `[prompts] daemon_hold_seconds` (default 3540, 5 to 3540) and the hook is registered for 3600 s (lead decision, a registration Claude was measured to honor); its notice names `remi attach`. An abort of the held request within 5 s of the registered timeout is Claude's timeout, not a No answered in the terminal, and is handled like the deadline (released to the terminal, notice pushed); the deadline normally comes first, so this covers a delayed timer such as a sleeping machine. The notice does not claim the prompt is still waiting, since a terminal Yes may already have answered it. An auto-mode fallback prompt still auto-denies at 2:00 on Claude's side; measured live, Claude fires `PermissionDenied` for it 120 s after the prompt, which dismisses the card (and pushes a `harness_denied` notice) before any close of the request reaches remi. A close with no hook takes the abort path.

An empty response decides nothing: it is what every non-answer path sends, so no path answers a prompt without a human choice.

Subagent prompts (with `agent_id`) follow the terminal: with a local terminal (wrapper mode) the hook is answered `passthrough` so the dialog renders, and the phone gets an informational "answer at the terminal" notice when it does; with no local terminal (daemon or hub mode) the prompt is held and answerable like a main one.

No card answer is typed into the PTY for a hook-backed binary prompt (raw keystrokes from `remi attach` and the phone's Escape button still reach the dialog, by design: they are a person at the terminal). A render while a hook-backed dialog may be on screen (a live main hold, or a prompt whose answer belongs to the terminal, for at most the session's hold length) is that dialog, not an orphan, so no typed card is rebuilt from the screen. A hold released by an ambiguous signal (a name + input match with no paired id, an identical re-request) stays open in the terminal for the same reason, and the phone is told so ("handed back to the terminal"), since its card is gone; no release of a live hold is silent. Guarded digit typing (#1134) remains only for prompts with no hook behind them (sandbox network, trust, agent-team dialogs) that reach the phone at all, and for multi-choice string-label permissions; AskUserQuestion and ExitPlanMode moved to the hook in #1127 (amendment below). Not every hook-less prompt reaches the phone: the startup folder-trust dialog of a daemon session produced no card in the live run (#1147).

`PermissionDenied` becomes an informational push of a new kind, `harness_denied`, mutable per device and on by default; never a card.

## Consequences

- The #1134 failure class (a typed digit meaning something else on screen) cannot happen for binary prompts: no digit is typed for them. Standing grants are offered only where the echo was verified to work.
- The phone and the terminal race, and either may win; the loser sees its answer refused (the phone) or nothing at all (the terminal answers the dialog directly).
- A terminal Yes is seen only at the tool's `PostToolUse`, so while a long command runs the hold and the card stay up: a phone answer in that window is accepted and ignored by Claude (F3), and the deadline notice can fire for a prompt already answered (its wording does not claim otherwise). Kept as is by lead decision; earlier detection (through `claude agents --json`) is a follow-up.
- While a main-agent prompt is held its dialog is on screen, so the chat guard (#1140) refuses chat text then even if the screen parse has not recognized the menu. Its message says "Claude is waiting on a prompt or finishing an approved step; answer the card or use the terminal", never that a dialog is up: after a Yes in the terminal the hold lasts until the tool's `PostToolUse`, so chat stays refused while the approved command runs. That residual is accepted until terminal answers are detected earlier (#1144).
- A `PermissionRequest` carries no `tool_use_id`, so the pairing with its `PreToolUse` is by agent, tool and input. With two identical calls in flight nothing is paired and the tool name + input fallback applies; its worst case is an early empty release (the card is dismissed and the terminal answers), never a decision. The lead confirmed this handling of ambiguous pairing.
- Orphan suppression is bounded (lead decision, corrected in review): a live main hold counts, and so does any prompt waiting in the terminal (main, or a rendered wrapper-mode subagent dialog), the latter only for the session's hold length, because a No answered in the terminal fires nothing. Only what does not render is excluded: a subagent hold (daemon mode) never counts, neither in the hook-prompt probe nor in the tracker's live-question check, which skips a held subagent card (every other registered card still counts); before the review fix that check alone kept a main sandbox or trust dialog's card back for up to `daemon_hold_seconds`. A subagent's prompt waiting in the terminal is also cleared by that agent's next tool call, `SubagentStop` or `SessionEnd`, and a new user prompt clears stale main entries. Within those bounds a redraw builds no typed card, so a wrapper-mode subagent prompt leaves the phone exactly one artifact, its notice; past them a redraw takes the guarded hook-less path (#1134, exact labels, fail closed).
- In wrapper mode a subagent prompt reaches the phone only as a notice; if the user is away, it waits at the terminal. The mode is fixed at session setup, so a detached wrapper session still counts as having a local terminal.
- In daemon or hub mode the phone keeps a prompt for up to 59 minutes; after that it is reachable only with `remi attach` (the notice says so). Every subagent prompt there is held and carded, and only prompts Claude would show anyway reach the hold: it does not fire `PermissionRequest` for a call its own allow rules permit (measured, table above).
- Residual (accepted): a subagent's prompt waiting in the terminal is cleared by that agent's next `PreToolUse`. If the same agent starts a concurrency-safe second tool call while the first dialog is still up, that call clears the entry early, and the dialog's next redraw takes the guarded hook-less path (#1134, exact labels, fail closed): a typed card can appear for a prompt whose notice was dismissed, and nothing is typed unless its option matches the screen.
- Residual (accepted): the web client restores a refused held answer only for the card it last answered in that session (a `STALE_ANSWER` naming no question carries no id). If a client answers two cards in quick succession and the earlier answer is the refused one, the later card may be restored instead (cosmetic: its own resolution then clears it), and the refused card is removed by its post-answer timer while its hold lasts; the card is still registered in the daemon, so a reconnecting client or the lock screen can answer it. The `App.tsx` call site is not covered by a test; the helper is.
- `remi --install` and the hold deadline are independent; the deadline is a config key, not an `[auto_approve]` key.

## Alternatives considered

- **Keep typing with the #1134 guard.** Rejected: fail-closed typing refuses legitimate answers whenever the screen's wording differs, and it still answers through the fragile channel.
- **Hold subagent prompts in wrapper mode too.** Rejected: their dialog does not render while held, so the user at the terminal would see nothing to answer (F2).
- **Hold until Claude's own hook timeout.** Rejected for wrapper mode: an auto-mode fallback prompt auto-denies after 2:00, counting during a hold, so a long hold would let that timer decide while a terminal could have answered. A daemon or hub session has no terminal to hand back to, so there the lead chose the long hold (3540 s of a 3600 s registration); an auto-mode fallback prompt is then denied by Claude at 2:00, the safe direction, and its `PermissionDenied` dismisses the card.
- **Pair `PostToolUse` by tool name and input alone.** Rejected as the primary key: two identical calls (two `ls` in a row) would close the wrong hold. Kept as the fallback when pairing is ambiguous, because its worst case is an empty release.

## Receipts

- Issue #1126 (both spike comments), epic #1123, owner decision D3a in `.context/strategy-2026-10.md`.
- #1134 / PR #1136 (the typed-digit failure and its guard), #733 (the hold-timeout handoff, restored here).
- `packages/daemon/src/auto-approve/auto-approve-gate.ts` (`holdForAnswer`, `answerHeld`, `onHoldAborted`, `pairToolUse`, `passSubagentToTerminal`), `packages/daemon/src/hooks/hook-server.ts` (the resolver's abort signal), `packages/daemon/src/hooks/hook-event-bridge.ts` (`standingGrantFor`), `packages/daemon/src/notifications/harness-denied.ts`.

## Amendment (#1127): AskUserQuestion and ExitPlanMode through held hooks

**Date:** 2026-10-02

### Context

Until #1127 both tools were answered `passthrough` and pushed by id, and a phone answer was typed: AskUserQuestion by a keystroke runner that drove its tabbed dialog and verified the review screen, ExitPlanMode as a digit behind the #1134 label check, which refused every ExitPlanMode digit on Claude Code 2.1.287 because remi's hardcoded labels had drifted. The #1126 spike measured on 2.1.287 that both can be held like a binary prompt:

| Finding | Experiment |
|---|---|
| AskUserQuestion fires `PreToolUse`, then `PermissionRequest` about 10 ms later with the same input (manual and auto mode); its dialog renders during the hold | E3 |
| `{behavior: "allow", updatedInput: {questions: <echo>, answers: {"<question text>": "<label>"}}}` answers it; a multi-select answer is its labels joined with ", "; free text (not a label) is accepted; the transcript records `toolUseResult: {questions, answers}`; no `permission_suggestions` | E3 |
| ExitPlanMode's input is `{plan, planFilePath}`, no `permission_suggestions`. `allow` with `updatedInput` (the input echoed) and an optional `setMode` (`destination: "session"`) approves it; a bare `allow` is silently ignored; `deny` with a message keeps Claude in plan mode, and it revises and calls ExitPlanMode again | E4 |
| ExitPlanMode's dialog offers "Yes, and use auto mode" only when auto mode is available (model-dependent), then "Yes, auto-accept edits" (`acceptEdits`), "Yes, manually approve edits" (`default`), "Tell Claude what to change" | E4 |
| A terminal answer to either fires `PostToolUse` with the `tool_use_id` of the paired `PreToolUse`, but its `tool_input` differs from the request's: `{questions, answers}` for AskUserQuestion, `{}` for ExitPlanMode; Esc or "Tell Claude what to change" closes the held request | F3, hook captures |

### Decision (lead decisions, as implemented)

1. **AskUserQuestion** is held and pushed as one card for the whole call: each question's text, header, options (label and description) and `multiSelect`. The phone answers with `selections` (option indices per question, or free text for a single-select question, `AnswerSelection.text`). remi maps them to `answers` keyed by the raw question text and resolves the hook with `allow` + `updatedInput` (the tool input echoed unchanged, plus `answers`). It validates first and refuses (the hold stays) any answer that leaves a question unanswered, gives a single-select question anything but one option or its own text, gives a multi-select question no option or free text, names an option or question that does not exist, or answers an input that does not parse exactly (a dropped entry would shift every option index after it). One option (the lock screen, Telegram) answers only a one-question, single-select AskUserQuestion, by value and label. Cancel from the phone denies with "The user dismissed the question." and types nothing.
2. **ExitPlanMode** is held and pushed as a `plan_approval` card carrying the plan as `detail` (the push body shows its start, the app all of it, Telegram up to its message limit) and three options built by meaning: "Approve, auto-accept edits" (`setMode acceptEdits`), "Approve, approve edits manually" (`setMode default`), "Keep planning" (`deny` with the phone's message, or "Keep planning."). Approvals echo the tool input (`plan`, `planFilePath`) as `updatedInput` and force `destination: "session"`. `auto` is not offered (not knowable from the payload); the terminal dialog still offers it. Cancel keeps planning.
3. **Lock screen.** An AskUserQuestion with exactly one single-select question gets REMI_MULTI with `dynOptions` (its tap resolves by option index through the hook, so a positional button is safe); every other AskUserQuestion and every plan approval gets no actionable category. Approving a plan is never a lock-screen tap.
4. **The Phase 3 machinery is reused unchanged** for deadlines, pairing, abort detection, subagent routing (a wrapper-mode subagent's call passes to the terminal with a notice; a daemon-mode one is held and answerable), orphan suppression, the eviction guard and the chat guard. One fix: a `PostToolUse` whose `tool_use_id` equals the paired id now matches whatever its input (a `tool_use_id` names one call); before, the input also had to match, so a terminal answer to either tool would have left its hold up until the deadline.
5. **Deleted:** the keystroke runner (`hooks/auq-answer.ts`, `hooks/auq-runner.ts`, `hooks/auq-active-runs.ts`), the rolling PTY buffer it read, the #661 screen detector for a terminal AskUserQuestion answer (the paired `PostToolUse` replaces it), the hardcoded ExitPlanMode labels, the `escalatePassthrough` path for both tools, and the tracker's parked-render card push (unused since #1126; `onRender` is required). A structured answer for a card no hold stands behind is refused, never typed.
6. **Kept typed (guarded, #1134):** multi-choice string-label permissions, and question-shaped tools that are not AskUserQuestion (an MCP or custom tool with `questions`). No structured hook answer was verified for either, and the dialog of a question-shaped tool is Claude's permission prompt, not its questions; typing stays behind the exact-label screen check, which fails closed.
7. **The `/answer` relay** (lock screen, Watch) reaches the same held path; its answer resolves structurally and no longer depends on the screen. The iOS-side Watch delivery issue (#665) is separate.

### Consequences

- Nothing is typed for an AskUserQuestion or a plan from the phone; a terminal answer and a phone answer race, first answer wins, exactly as for a binary prompt.
- The chat guard covers both dialogs (`hasMainHold`), so a chat sent while either is held is refused.
- The web form takes free text for a single-select question and enables Submit only for an answer the daemon accepts; a refused form answer stops showing "Answering" so it can be sent again.

### Residuals

- A plan cannot be approved into `auto` mode from the phone; the terminal can.
- Free text on a multi-select question is refused (only labels were verified for it); the terminal dialog's "Type something" row still takes it.
- A question-shaped MCP or custom tool still shows its questions on the card, and a pick is typed behind the label check, which normally refuses it because its dialog is a permission prompt; such a card with one single-select question now gets REMI_MULTI too (the category rule reads the card's shape, not the tool).
- After a deadline release the card is dismissed and the terminal answers, as for a binary prompt; a long plan can easily outlast `hold_seconds` while being read.

