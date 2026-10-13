import type { UIMessage } from '@/types';

/** Late queued-input refusal is authoritative over a receipt ACK (#1488). */
export function refusedInputMessageId(error: {
  readonly code?: string;
  readonly details?: Record<string, unknown>;
}): string | undefined {
  if (
    !['PROMPT_WAITING', 'INPUT_NOT_DELIVERED', 'SESSION_NOT_FOUND', 'STALE_BINDING'].includes(
      error.code ?? '',
    )
  )
    return undefined;
  const id = error.details?.['messageId'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

export function partialInputMessageId(
  error: Parameters<typeof refusedInputMessageId>[0],
): string | undefined {
  return error.details?.['inputMayBePartial'] === true ? refusedInputMessageId(error) : undefined;
}

export function markPartialInput(message: UIMessage): UIMessage {
  return { ...message, state: 'failed', inputMayBePartial: true };
}

/** A receipt never proves that a partially typed line was submitted. */
export function markInputReceipt(message: UIMessage): UIMessage {
  return message.inputMayBePartial ? message : { ...message, state: 'delivered' };
}
