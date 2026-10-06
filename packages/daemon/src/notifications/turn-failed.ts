/**
 * The `turn_failed` push (#1153): a turn ended because of an API error.
 *
 * Claude Code fires `StopFailure` (`error`, `error_details`,
 * `last_assistant_message`) INSTEAD of `Stop` and ignores whatever the hook
 * answers, so nothing waits for a reply: this is informational, never a card.
 * It used to be a "Session stop failed (undefined). Retry?" card with Yes/No
 * that no answer could reach, one more on every failed turn (on a usage limit,
 * every prompt), stacking in the app and on the lock screen.
 *
 * What this module owns: the readable text and the per-session collapse key.
 * Who is pushed, and how, is `NotificationDispatcher.pushTurnFailed`, which
 * alerts once per failure reason until a turn finishes well (#1226): before
 * that, at a usage limit, every failed turn (a subagent's too) alerted the
 * phone again under the same collapse key, and a new prompt cleared the
 * notice first, so a retry loop alerted on every cycle.
 *
 * Mutable per device through `pushPrefs.turnFailed` (default on) and by
 * nothing else: `notifications.on_turn_complete = false` does NOT silence it,
 * because a failed turn is the one turn end a user must not miss by default
 * (the agent is stopped, and until something is done it stays stopped).
 *
 * The Codex adapter pushes the same notice for a failed turn (`turn/completed`
 * with status `failed`, #1180), through the turn-event sink
 * (`turn-events.ts`), and the title names Codex instead of Claude.
 */

import type { UUID } from '@remi/shared';

import type { StopFailureHookInput } from '../hooks/hook-types.ts';

/** Same caps as the question push (`notification-dispatcher.ts`). */
const TITLE_MAX = 120;
const BODY_MAX = 200;

/** About one lock-screen line and a half of the failure's own words. */
const EXCERPT_MAX = 140;
/** An unknown `error` code is shown as is, bounded so a hostile or garbled
 *  value cannot crowd the excerpt out of the body. */
const UNKNOWN_CODE_MAX = 40;
const AGENT_TYPE_MAX = 30;
/** Who stopped, in the title, when the caller does not say: Claude Code's `StopFailure` is the original source. */
const DEFAULT_AGENT_NAME = 'Claude';

/**
 * Display phrase for each documented `StopFailure` `error` value
 * (code.claude.com/docs/en/hooks, the `StopFailure` matcher list, checked
 * 2026-10-02). `rate_limit` is the one code for both a rate limit and an
 * account usage limit as far as the docs go, so its phrase names both and the
 * excerpt (Claude's own last message) says which; a usage-limit payload has
 * not been captured (#905), so no finer split is invented here.
 */
const KNOWN_ERROR_PHRASES: ReadonlyMap<string, string> = new Map([
  ['rate_limit', 'Rate or usage limit reached'],
  ['overloaded', 'API overloaded'],
  ['authentication_failed', 'Authentication failed'],
  ['oauth_org_not_allowed', 'Organization not allowed to sign in'],
  ['account_on_hold', 'Account on hold'],
  ['billing_error', 'Billing error'],
  ['invalid_request', 'Invalid request'],
  ['model_not_found', 'Model not found'],
  ['server_error', 'Server error'],
  ['max_output_tokens', 'Output token limit reached'],
  ['cloud_credential_error', 'Cloud credentials could not be loaded'],
  ['unknown', 'Unknown error'],
  // Codex's string `codexErrorInfo` values (the generated schema's `CodexErrorInfo`, #1180), so a
  // failed Codex turn reads like Claude's. A value with no phrase here is shown as is.
  ['usageLimitExceeded', 'Usage limit reached'],
  ['rateLimitExceeded', 'Rate limit reached'],
  ['serverOverloaded', 'API overloaded'],
  ['internalServerError', 'Server error'],
  ['unauthorized', 'Authentication failed'],
  ['badRequest', 'Invalid request'],
  ['contextWindowExceeded', 'Context window exceeded'],
  ['sessionBudgetExceeded', 'Session budget exceeded'],
  ['sandboxError', 'Sandbox error'],
  ['other', 'Unknown error'],
]);

/** What a payload with no usable `error` reads as: the binary itself sends
 *  `unknown` when it has no code (`s=e.error??"unknown"`, #886). */
const NO_CODE_PHRASE = 'Unknown error';

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A short phrase for an `error` code: the mapped phrase (sentence case) for
 *  a documented code, the code itself, verbatim, for any other string, and a
 *  fixed phrase for a missing or non-string one. Never `undefined` or
 *  `null`. */
export function describeTurnFailure(error: unknown): string {
  if (typeof error !== 'string') return NO_CODE_PHRASE;
  const code = oneLine(error);
  if (code === '') return NO_CODE_PHRASE;
  return KNOWN_ERROR_PHRASES.get(code) ?? truncate(code, UNKNOWN_CODE_MAX);
}

/** The words Claude Code gave with the failure: `last_assistant_message`
 *  when it is a non-empty string, else a string `error_details`, else
 *  nothing. A structured `error_details` is not stringified: an object
 *  printed into a notification reads as noise ("[object Object]"). */
function failureExcerpt(
  input: Pick<StopFailureHookInput, 'last_assistant_message' | 'error_details'>,
): string {
  for (const candidate of [input.last_assistant_message, input.error_details]) {
    if (typeof candidate !== 'string') continue;
    const text = oneLine(candidate);
    if (text !== '') return truncate(text, EXCERPT_MAX);
  }
  return '';
}

/** The slice of the hook payload the push reads. */
export type TurnFailedInput = Pick<
  StopFailureHookInput,
  'error' | 'error_details' | 'last_assistant_message' | 'agent_type'
>;

/**
 * Title and body for one failed turn. The title names the session the way
 * every other push does, and the agent that stopped (`agentName`: Claude
 * unless the caller says another, as the Codex adapter does, #1180); the body
 * is the reason ("Rate or usage limit reached"), then a short excerpt of what
 * the agent said. A failure from a subagent says which kind.
 */
export function buildTurnFailedText(
  sessionName: string,
  input: TurnFailedInput,
  agentName: string = DEFAULT_AGENT_NAME,
): { title: string; body: string } {
  const agent = oneLine(agentName) || 'Agent';
  const title = `${oneLine(sessionName) || 'Agent'}: ${agent} stopped`.slice(0, TITLE_MAX);
  const reason = describeTurnFailure(input.error);
  const excerpt = failureExcerpt(input);
  const who =
    typeof input.agent_type === 'string' && oneLine(input.agent_type) !== ''
      ? `${truncate(oneLine(input.agent_type), AGENT_TYPE_MAX)} · `
      : '';
  const body = `${who}${reason}${excerpt ? `. ${excerpt}` : ''}`.slice(0, BODY_MAX);
  return { title, body };
}

/**
 * The collapse key of a session's `turn_failed` pushes: one per session, so a
 * later failure (another reason; a repeat of one is not pushed, #1226)
 * replaces the previous notification on the lock screen instead of stacking.
 * Sent as the push's `questionId`, which the signaling Worker turns into
 * `apns-collapse-id`; the prefix keeps it from ever naming a real card. 48
 * bytes for a UUID, under APNS's 64.
 */
export function turnFailedCollapseId(sessionId: string): string {
  return `turn-failed-${sessionId}`;
}

/** The slice of a per-session `NotificationDispatcher` the hook wiring needs. */
export interface TurnFailedNotifier {
  pushTurnFailed(input: TurnFailedInput, agentName?: string): Promise<unknown>;
  dismissTurnFailed(): void;
}

/**
 * How `cli.ts` hands a session's `StopFailure` to that session's dispatcher,
 * and clears its notice on a later turn. Extracted from the wiring lambdas so
 * it is tested as itself.
 *
 * It takes the registry of dispatchers and nothing else, on purpose: no
 * config, so nothing here can gate a failure on `notifications.on_turn_complete`
 * (a failed turn is the one turn end a user must not miss by default; only the
 * per-device `turnFailed` preference mutes it, inside the dispatcher). A
 * session with no dispatcher (already torn down) is a no-op.
 */
export function createTurnFailedRoutes(notifiers: ReadonlyMap<UUID, TurnFailedNotifier>): {
  push: (sessionId: UUID, input: TurnFailedInput, agentName?: string) => void;
  dismiss: (sessionId: UUID) => void;
} {
  return {
    // The dispatcher's promise never rejects; fire-and-forget. A Claude `StopFailure` hook payload is
    // a `TurnFailedInput` (the type is a slice of it) and names no agent, so it reads "Claude stopped".
    push: (sessionId, input, agentName) => {
      void notifiers.get(sessionId)?.pushTurnFailed(input, agentName);
    },
    dismiss: (sessionId) => {
      notifiers.get(sessionId)?.dismissTurnFailed();
    },
  };
}
