# ADR 0031: Held-hook answers with the native dialog visible

**Status:** accepted
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
| `setMode` echoed verbatim works; `addRules` works when echoed with `destination: "session"`; an echoed `addDirectories` does not stop the repeat prompt | F4 |
| A deny with a message reaches Claude as the tool result, `is_error: true` | round 1 |
| A background subagent's dialog does not render while its hook is held; after a passthrough it renders on the main screen | F2 |
| In auto mode a classifier block fires `PermissionDenied` (with `tool_use_id`, `reason`) and no `PermissionRequest`; an auto-mode fallback prompt auto-denies after 2:00, counting during a hold | F1a-F1d |

## Decision

A binary `PermissionRequest` the phone can answer is held, its card pushed at once by id, and the first answer wins:

- **Phone.** The answer is the hook response, mapped from the card option's meaning, never from a position on the screen: `Yes` -> `allow`; `No` -> `deny`, optionally with the user's message; a standing option -> `allow` + `updatedPermissions`, only for `setMode` (verbatim) and an allow `addRules` (with `destination: "session"`, labeled "for this session"). `addDirectories` is never offered. Anything a card does not offer is refused and the hold stays.
- **Terminal Yes.** The `PostToolUse` or `PostToolUseFailure` whose `tool_use_id` matches the `PreToolUse` paired with the request releases the hold with an empty response (Claude ignores it) and dismisses the card.
- **Terminal No or Esc, or any other close.** The hook server observes the request's abort and dismisses the card.
- **Deadline.** At `[prompts] hold_seconds` (default 90, 5 to 110: below the 2:00 auto-deny and the 600 s registered hook timeout) remi releases its own hold with an empty response, Claude's dialog stays, the card is dismissed and an "answer at the terminal" notice is pushed (#733).

An empty response decides nothing: it is what every non-answer path sends, so no path answers a prompt without a human choice.

Subagent prompts (with `agent_id`) follow the terminal: with a local terminal (wrapper mode) the hook is answered `passthrough` so the dialog renders, and the phone gets an informational "answer at the terminal" notice when it does; with no local terminal (daemon or hub mode) the prompt is held and answerable like a main one.

Nothing is typed into the PTY for a hook-backed binary prompt. A render while a hook-backed prompt is open is that prompt, not an orphan, so no typed card is rebuilt from the screen. Guarded digit typing (#1134) remains only for prompts with no hook behind them (sandbox network, trust, agent-team dialogs), and, until #1127, for AskUserQuestion, ExitPlanMode and multi-choice string-label permissions.

`PermissionDenied` becomes an informational push of a new kind, `harness_denied`, mutable per device and on by default; never a card.

## Consequences

- The #1134 failure class (a typed digit meaning something else on screen) cannot happen for binary prompts: no digit is typed for them. Standing grants are offered only where the echo was verified to work.
- The phone and the terminal race, and either may win; the loser sees its answer refused (the phone) or nothing at all (the terminal answers the dialog directly).
- A `PermissionRequest` carries no `tool_use_id`, so the pairing with its `PreToolUse` is by agent, tool and input. With two identical calls in flight nothing is paired and the tool name + input fallback applies; its worst case is an early empty release (the card is dismissed and the terminal answers), never a decision.
- An open hook-backed prompt suppresses orphan cards. An entry that outlives its dialog (a subagent prompt answered No in the terminal, which fires nothing until `SubagentStop`) can suppress a genuinely hook-less prompt's card until it is cleared. A new user prompt clears stale main entries.
- In wrapper mode a subagent prompt reaches the phone only as a notice; if the user is away, it waits at the terminal. The mode is fixed at session setup, so a detached wrapper session still counts as having a local terminal.
- `remi --install` and the hold deadline are independent; the deadline is a config key, not an `[auto_approve]` key.

## Alternatives considered

- **Keep typing with the #1134 guard.** Rejected: fail-closed typing refuses legitimate answers whenever the screen's wording differs, and it still answers through the fragile channel.
- **Hold subagent prompts in wrapper mode too.** Rejected: their dialog does not render while held, so the user at the terminal would see nothing to answer (F2).
- **Hold until Claude's own hook timeout.** Rejected: an auto-mode fallback prompt auto-denies after 2:00, counting during a hold, so a long hold would let the timer decide.
- **Pair `PostToolUse` by tool name and input alone.** Rejected as the primary key: two identical calls (two `ls` in a row) would close the wrong hold. Kept as the fallback when pairing is ambiguous, because its worst case is an empty release.

## Receipts

- Issue #1126 (both spike comments), epic #1123, owner decision D3a in `.context/strategy-2026-10.md`.
- #1134 / PR #1136 (the typed-digit failure and its guard), #733 (the hold-timeout handoff, restored here).
- `packages/daemon/src/auto-approve/auto-approve-gate.ts` (`holdForAnswer`, `answerHeld`, `onHoldAborted`, `pairToolUse`, `passSubagentToTerminal`), `packages/daemon/src/hooks/hook-server.ts` (the resolver's abort signal), `packages/daemon/src/hooks/hook-event-bridge.ts` (`standingGrantFor`), `packages/daemon/src/notifications/harness-denied.ts`.
