/**
 * Client side of the daemon's `PROMPT_WAITING` refusal (#1140).
 *
 * While Claude shows a numbered selection menu the daemon types no chat text
 * into it (the Enter after the text would confirm the highlighted option) and
 * answers the `user_input` with an `error` carrying `PROMPT_WAITING_ERROR_CODE`.
 * The daemon acks every `user_input` before it decides, so the sender's bubble
 * already reads "delivered"; the error names the refused message so the
 * bubble can be marked failed, as for `SESSION_NOT_FOUND` (#681).
 *
 * The code and the details shape (`PromptWaitingErrorDetails`) live in
 * `@remi/shared`; the daemon builds the error with `createPromptWaitingError`.
 */

import { PROMPT_WAITING_ERROR_CODE } from '@remi/shared';

/** The wire fields of an `error` message this reads (`ErrorMessage`'s). */
interface ErrorFields {
  readonly code?: string | undefined;
  readonly details?: Record<string, unknown> | undefined;
}

/**
 * The id of the user input a `PROMPT_WAITING` error refused, or undefined when
 * `error` is some other error or names no message (a client that sent no id).
 */
export function promptWaitingRefusedMessageId(error: ErrorFields): string | undefined {
  if (error.code !== PROMPT_WAITING_ERROR_CODE) return undefined;
  const id = error.details?.['messageId'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}
