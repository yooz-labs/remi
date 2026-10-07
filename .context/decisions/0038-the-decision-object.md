# ADR 0038: The decision object, frozen

**Status:** accepted (#1235, milestone "Protocol freeze"); owner decisions of 2026-10-07, recorded in #1233
**Date:** 2026-10-07
**Owner:** Yahya

## Context

Every "the agent needs you" moment reaches a client as a `question` message, and its dismissal as `question_resolved`.
The strategy (`.context/strategy-2026-10.md` section 8) describes one cross-harness object for it.
`Decision` in `packages/shared/src/harness.ts` is an alias of `Question`, and three of the strategy's fields (`localRender`, `answerPath`, `resolvedBy`) existed only as TypeScript types.
Two of its kinds (`sandbox`, `trust`) had no value at all.

The native apps are being written against this shape, so it is frozen before they ship.
The Swift client already had a "resolved elsewhere" state with nothing on the wire to feed it, and it mapped any `kind` it did not know to a permission card.

## Decision

1. **The decision is `Question`, on the `question` message.**
   The alias stays; no message is renamed.
2. **`Question.answerPath`: how a phone answer reaches the harness.** It is optional.
   - `structured`: the harness takes the answer as data. Claude: a held hook (a binary permission, an AskUserQuestion, an ExitPlanMode). Codex: the JSON-RPC response to an approval.
   - `keystroke`: the answer is typed into the terminal behind the screen guards, so it can be refused when the screen changed. Claude: a prompt read off the screen, a multi-choice permission answered `passthrough`, an elicitation.
   - `none`: no phone answer can be applied. Every `terminalOnly` card is `none`, whatever its source said.
   - Absent means unknown (an older daemon, or a path that did not name one).
   - Each source sets it where the card is built: the gate tells the tracker which path a pushed card takes, the tracker marks a rendered card `keystroke`, Codex marks its cards `structured`. One stamp (`message-api-setup.ts`) writes it onto the wire and the registry.
3. **`question_resolved.resolvedBy`: what resolved a card.** It is optional, and it is sent only where the daemon knows the cause; absent means unknown, never a guess.

   | Value | Sent when |
   |---|---|
   | `phone` | A phone answer that reached the agent, over a client's connection or Telegram: a held answer the hook or Codex took, a typed answer that was submitted, a Cancel that reached the hook or wrote the Esc. |
   | `lockscreen` | The same, through the notification answer endpoint (`/answer`, `viaRelay`). |
   | `terminal` | Claude ran the tool paired with the request by `tool_use_id` (a phone answer retires the card's signature first, so it cannot match), or an MCP elicitation was accepted or declined in Claude's dialog. |
   | `harness` | `PermissionDenied` (Claude's classifier, or its 2:00 auto-deny), `SessionEnd`, a transcript rotation, a Codex thread rotation, a subagent that ended with its hold open, the agent's process exiting. |
   | `timeout` | remi's own hold deadline (`[prompts] hold_seconds`, `daemon_hold_seconds`). |

   Nothing is named for:
   - a No or an Esc at the terminal, which fires no hook (a held request Claude closed);
   - Claude's own hook timeout, read from an abort's timing, since a terminal No in those last seconds looks the same;
   - a name and input match with no paired id, which may be another identical call;
   - a Stop, a new prompt or a `StopFailure` that sweeps an open card;
   - a subagent's passthrough card at its `SubagentStop`;
   - Codex's `serverRequest/resolved`, which does not say who answered;
   - `remi unstick`, a session remi closed, a card superseded by a newer render, or a hold released on an ambiguous signal.
4. **The first resolution of a card wins.**
   `createQuestionResolver` (`cli/question-resolution.ts`) sends each card's `question_resolved` and its quiet lock-screen dismissal once. A later resolution of the same card is dropped: an ElicitationResult after the phone answered, or a render superseding an answered card. So it cannot contradict the `resolvedBy` the clients have.
   It forgets a card once the registry holds it again, so a card re-added under the same id can be resolved again. It remembers the last 1024 cards.
5. **A refused or late phone answer is `cancelled`.**
   Before, every card the answer handler cleared was `answered`, including an answer refused at the screen or one whose hold had already ended.
6. **`localRender` stays off the wire.** No client behavior needs it yet; it remains a typed-only field and can be added later as an optional one.
7. **`kind` is an open set, with no new kinds.**
   - A client renders a `kind` it does not know as a generic card (its `text` and `options`), never with a permission's Allow/Deny styling. A new kind is therefore additive.
   - Sandbox and trust prompts stay kind-less cards with `source: 'pty'`. The strategy's model drops those two kinds.
8. **No capability and no version change.**
   Both fields are visible in the messages themselves and absent from an older daemon, so a client reads absence as unknown (ADR 0035).
9. **Fixtures.** Golden fixtures cover one card per kind and answer path, for Claude and Codex, and `question_resolved` with `resolvedBy` (`packages/shared/tests/fixtures/protocol/question_claude_*`, `question_codex_*`, `question_resolved_terminal`).

## What `resolvedBy` does not prove

- **`phone` means remi delivered the phone's answer first, not that it decided.**
  After a terminal Yes, Claude's hold stays open until `PostToolUse`. A phone tap during the tool's run resolves a hook Claude no longer reads.
  When the TUI and a phone answer a Codex approval together, Codex keeps the first, and `serverRequest/resolved` does not say whose.
- **A lock-screen tap the web client sends over its open socket reads as `phone`.** That is still true, just less specific.
- **A Codex card is never `terminal`.** The app-server does not say who answered.

## Consequences

- The native client feeds its "resolved elsewhere" state from `resolvedBy`, and changes its mapping of an unknown `kind` from a permission card to a generic card (#1291).
- The web client and Telegram ignore both fields for now; they render as before.
- Every path that dismisses a card goes through the one resolver, so a new path gets the first-wins rule by construction.
