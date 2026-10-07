/**
 * The one "a prompt is up" signal (#1155), read by the two paths that type a
 * line followed by Enter into a session's terminal: the chat guard
 * (`onUserInput`, #1140) and Stop (`onKillSessionRequest`, which types
 * `/exit`). Into a Claude dialog that Enter confirms the highlighted option,
 * usually "1. Yes", so both refuse to type while this says a prompt is up:
 * the chat guard sends `PROMPT_WAITING`, Stop force-closes the session.
 *
 * Three sources, because none of them alone sees every dialog:
 *   - `held`: a main-agent prompt's hook is held (`hasMainHold`). Its dialog
 *     renders during the hold (#1126), whether or not the screen parse has
 *     recognized it yet.
 *   - `terminal`: a hook-backed prompt whose answer belongs to the terminal
 *     (`hasOpenHookPrompt` beyond a main hold): a hold released at its
 *     deadline or handed back early, or a rendered wrapper-mode subagent
 *     dialog, for at most the session's hold length. Its dialog is (or may
 *     still be) on screen, and its card is gone.
 *   - `menu`: the tracker observes a numbered selection box
 *     (`observedPromptOptions` + `isNumberedMenu`), which covers hook-less
 *     prompts (sandbox network, trust, agent-team dialogs).
 * Before #1155 Stop read only the screen parse and the chat guard only the
 * screen parse and `held`, so a dialog the parse missed (a parse that a text
 * status cleared, or a prompt released at its deadline) could receive typed
 * text.
 *
 * How long `terminal` lasts (#1155 review). An entry counts for the
 * session's hold length from when it is MARKED (the deadline release, the
 * early hand-back, or the subagent dialog's render), not from when the
 * prompt appeared:
 *   - wrapper mode, `[prompts] hold_seconds` (default 90): up to 90 s after
 *     a deadline release, so about twice the hold from the prompt's start;
 *   - daemon or hub mode, `[prompts] daemon_hold_seconds` (default 3540): up
 *     to about 59 minutes after the release.
 * A No answered at the terminal fires no hook, so within that window the
 * entry can outlive its dialog. Ways out: an answer the hook sees (the tool
 * runs, `Stop`, a new user prompt; a subagent's next tool call or
 * `SubagentStop`), a bare Esc sent through remi (the web Esc button,
 * Telegram's `/interrupt`, an attach client's Esc key), which clears the main
 * agent's entries (`noteTerminalEscape`), and `remi unstick`. An Esc typed at
 * a wrapper session's own terminal does not pass through remi, so it is not
 * seen. The opposite direction: once an entry ages out, a dialog still on
 * screen whose parse was cleared (a text status guess) is no longer guarded;
 * chat would be typed into it and Stop would type `/exit`.
 *
 * Stop stays on this signal even while an entry may be stale (lead
 * decision): a forced close types nothing, so it is always safe, only less
 * graceful than `/exit`.
 *
 * `promptUpDeps` is the ONE wiring: `cli.ts` builds it once and spreads it
 * into both handler factories, and the tests use the same helper, so a test
 * of either guard exercises the production signal.
 */

import type { QuestionOption, UUID } from '@remi/shared';

import { isNumberedMenu } from './screen-menu.ts';

/** Which source says a prompt is up, in the order they are checked. */
export type PromptUp = 'held' | 'terminal' | 'menu';

/** The gate reads (`SessionGateHandle`, backed by `AutoApproveGate`). */
export interface PromptUpGate {
  hasMainHold(): boolean;
  /** A live main hold, or a hook-backed prompt waiting in the terminal
   *  younger than the session's hold length. */
  hasOpenHookPrompt(): boolean;
}

/** The tracker read (`QuestionPresenceTracker`). */
export interface PromptUpScreen {
  observedPromptOptions(): readonly QuestionOption[] | null;
}

/**
 * Whether a prompt is up for a session with this gate and tracker, and by
 * which source; null when none says so. Either may be absent (a session with
 * no hook server has no gate): an absent source says nothing.
 */
export function promptUpFor(
  gate: PromptUpGate | undefined,
  screen: PromptUpScreen | undefined,
): PromptUp | null {
  if (gate?.hasMainHold() === true) return 'held';
  if (gate?.hasOpenHookPrompt() === true) return 'terminal';
  if (isNumberedMenu(screen?.observedPromptOptions() ?? null)) return 'menu';
  return null;
}

/** The `promptUp` dep both handler factories take. */
export interface PromptUpDeps {
  promptUp: (sessionId: UUID) => PromptUp | null;
}

/**
 * `promptUp` backed by each session's gate and tracker (`cli.ts` passes
 * lookups into `harnessSessions`, each session's `decisions` and
 * `decisions.screen`, the tests their gate and tracker).
 */
export function promptUpDeps(
  gateFor: (sessionId: UUID) => PromptUpGate | undefined,
  trackerFor: (sessionId: UUID) => PromptUpScreen | undefined,
): PromptUpDeps {
  return { promptUp: (sessionId) => promptUpFor(gateFor(sessionId), trackerFor(sessionId)) };
}
