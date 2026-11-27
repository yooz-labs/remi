import { escapeUnsafeText } from './display-text.ts';

export const PROFILE_EMAIL_REFUSAL = 'Use a name such as Work, not an email address';

/** Validate the label without returning user-controlled text in an error. */
export function validateProfileLabel(value: unknown): string | null {
  if (typeof value !== 'string') return 'label must be a string';
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(value)) return PROFILE_EMAIL_REFUSAL;
  if (value !== value.trim() || [...value].length < 1 || [...value].length > 64) {
    return 'label must be trimmed and contain 1 to 64 characters';
  }
  if (escapeUnsafeText(value) !== value) return 'label contains unsafe characters';
  return null;
}
