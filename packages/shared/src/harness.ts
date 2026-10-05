/**
 * Harness identity and the cross-harness decision vocabulary.
 *
 * A "harness" is the agent CLI remi wraps. Claude Code and Codex have
 * adapters; `opencode` is named so persisted records and wire fields have a
 * closed vocabulary to grow into. The wire-level `harness` /
 * `harnessSessionId` fields on `DiscoverableSession`, `HelloAckMessage` and
 * `QuestionMessage` are sent by the daemon since #1179 (ADR 0032 and 0033 give
 * the rules).
 */

import type { Question } from './types.ts';

/**
 * Every harness remi names. `claude` and `codex` have adapters in this build;
 * `opencode` has none, so no daemon offers it (`hello_ack.harnesses`).
 */
export const HARNESS_IDS = ['claude', 'codex', 'opencode'] as const;

/** A harness remi names. Narrow with {@link isHarnessId}. */
export type HarnessId = (typeof HARNESS_IDS)[number];

/**
 * The harness a record or message belongs to when it names none. Every record
 * and message written before harnesses existed is a Claude one, so absence
 * means this, never "unknown".
 */
export const DEFAULT_HARNESS: HarnessId = 'claude';

/** True when `value` is exactly one of {@link HARNESS_IDS} (case-sensitive). */
export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value);
}

/**
 * A session's harness-neutral identity: which harness, and that harness's own
 * id for the session. `harnessSessionId` is null while the harness has not
 * reported one yet (Claude's id is pre-assigned at spawn, but a resumed or
 * promoted session can lack it; see `HelloAckMessage.claudeSessionId`).
 *
 * For Claude it is DERIVED from the existing `claudeSessionId` column, never
 * stored (ADR 0032), so there is one source of truth and a rotation cannot
 * leave the two apart.
 */
export interface SessionIdentity {
  readonly harness: HarnessId;
  readonly harnessSessionId: string | null;
}

/** The identity of a Claude session from its Claude Code session id (or null when not yet known). */
export function identityFromClaudeId(claudeSessionId: string | null): SessionIdentity {
  return { harness: 'claude', harnessSessionId: claudeSessionId };
}

/**
 * How a decision's answer reaches the harness. Typed only: no daemon code
 * sets or emits it in this series.
 *
 * - `structured`: through the harness's own reply channel (Claude: the held
 *   hook response).
 * - `keystroke`: typed into the PTY behind the screen guards (Claude: a
 *   hook-less prompt).
 * - `none`: no phone answer can be applied (Claude: a `terminalOnly` card).
 */
export type AnswerPath = 'structured' | 'keystroke' | 'none';

/**
 * Who draws the decision's dialog on the machine where the harness runs.
 * Typed only: not attached to any message.
 *
 * - `harness`: the harness's own dialog. Claude renders its own during a
 *   MAIN-agent hold; a background subagent's dialog does not render while its
 *   hook is held (AGENTS.md, ADR 0031).
 * - `remi`: a dialog remi draws itself.
 * - `none`: nothing is drawn locally.
 */
export type LocalRender = 'harness' | 'remi' | 'none';

/**
 * What resolved a decision, first answer wins. Typed only: the wire's
 * `question_resolved.reason` is a different, narrower vocabulary and is not
 * changed by this type.
 */
export type ResolvedBy = 'terminal' | 'phone' | 'lockscreen' | 'harness' | 'timeout';

/**
 * One "the agent needs you" moment, for every harness. This is an alias of
 * {@link Question}, not a new shape: `Question` has more than 100 uses in `packages/`
 * and renaming it would buy nothing before a second harness exists. The
 * target model is `.context/strategy-2026-10.md` section 8; each of its fields
 * maps as follows.
 *
 * | Strategy field | Where it lives today |
 * |---|---|
 * | `id` | `Question.id` |
 * | `harness` | `QuestionMessage.harness`; absent (an older daemon) means {@link DEFAULT_HARNESS} |
 * | `harnessSessionId` | `QuestionMessage.harnessSessionId`; for Claude it equals `QuestionMessage.claudeSessionId` |
 * | `agentId` | `Question.agentId` (absent for the main agent) |
 * | `kind` | `Question.kind`: `permission`, `multi_question` (the strategy's `question`), `plan_approval` (its `plan`); the strategy's `sandbox` and `trust` have no `kind` today, they are hook-less PTY prompts (`Question.source === 'pty'`) |
 * | `options[]` | `Question.options` |
 * | `optionsAreFallback` | `Question.optionsAreFallback` |
 * | `localRender` | no field; typed as {@link LocalRender}, not attached to the wire |
 * | `answerPath` | no field; typed as {@link AnswerPath}, not attached to the wire; `Question.held` does not stand in for it, since that flag marks every card pushed by id (binary holds, AskUserQuestion, ExitPlanMode, multi-choice permissions) |
 * | `resolvedBy` | no field; typed as {@link ResolvedBy}, not attached to the wire |
 */
export type Decision = Question;
