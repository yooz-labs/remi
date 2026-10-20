/**
 * Display-only formatting for hook-controlled tool input. Field extraction and
 * the default summary contract stay in the import-free pure helper.
 */

import { escapeUnsafeText } from '@remi/shared';

import {
  HEAD_KEEP,
  SUMMARY_MAX,
  TAIL_KEEP,
  cutSummary,
  summarizeToolInput,
} from './tool-summary.ts';

/** Move a summary cut out of an escape or surrogate pair. */
function safeBoundary(value: string, index: number, side: 'before' | 'after'): number {
  for (const match of value.matchAll(/\\u(?:[0-9A-F]{4}|\{[0-9A-F]+\})/gu)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start < index && index < end) return side === 'before' ? start : end;
  }
  if (
    index > 0 &&
    index < value.length &&
    value.charCodeAt(index - 1) >= 0xd800 &&
    value.charCodeAt(index - 1) <= 0xdbff &&
    value.charCodeAt(index) >= 0xdc00 &&
    value.charCodeAt(index) <= 0xdfff
  ) {
    return side === 'before' ? index - 1 : index + 1;
  }
  return index;
}

/** Escape first, then use the shared summary bounds without cutting an escape. */
function truncateEscapedSummary(value: string): string {
  if (value.length <= SUMMARY_MAX) return value;
  const headEnd = safeBoundary(value, HEAD_KEEP, 'before');
  const tailStart = safeBoundary(value, value.length - TAIL_KEEP, 'after');
  return cutSummary(value, headEnd, tailStart);
}

/** Summarize hook input for user-visible cards while retaining pure extraction. */
export function summarizeToolInputForDisplay(
  toolName: string,
  toolInput: Record<string, unknown>,
  options: { readonly complete?: boolean } = {},
): string | null {
  const summaryOptions = options.complete === undefined ? {} : { complete: options.complete };
  return summarizeToolInput(toolName, toolInput, {
    ...summaryOptions,
    format: (value, shouldTruncate) => {
      const escaped = escapeUnsafeText(value);
      return shouldTruncate ? truncateEscapedSummary(escaped) : escaped;
    },
  });
}
