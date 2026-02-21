/**
 * Connection code generator.
 *
 * Generates human-readable codes like "AXBY-1234".
 * Uses only unambiguous characters (no 0/O, 1/I/L).
 */

import type { ConnectionCode } from './types.ts';

/** Characters for alphabetic part (no ambiguous chars) */
const ALPHA_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ';

/** Characters for numeric part (no ambiguous chars) */
const NUMERIC_CHARS = '23456789';

/** Default code format: 4 letters - 4 numbers */
const DEFAULT_ALPHA_LENGTH = 4;
const DEFAULT_NUMERIC_LENGTH = 4;

/**
 * Generate a random connection code.
 *
 * @param alphaLength - Number of letters (default: 4)
 * @param numericLength - Number of digits (default: 4)
 * @returns Code like "AXBY-1234"
 */
export function generateCode(
  alphaLength: number = DEFAULT_ALPHA_LENGTH,
  numericLength: number = DEFAULT_NUMERIC_LENGTH,
): ConnectionCode {
  let alpha = '';
  let numeric = '';

  // Generate random bytes
  const bytes = new Uint8Array(alphaLength + numericLength);
  crypto.getRandomValues(bytes);

  // Generate alpha part
  for (let i = 0; i < alphaLength; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index bounded by array length
    const idx = bytes[i]! % ALPHA_CHARS.length;
    alpha += ALPHA_CHARS[idx];
  }

  // Generate numeric part
  for (let i = 0; i < numericLength; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index bounded by array length
    const idx = bytes[alphaLength + i]! % NUMERIC_CHARS.length;
    numeric += NUMERIC_CHARS[idx];
  }

  return `${alpha}-${numeric}`;
}

/**
 * Validate a connection code format.
 *
 * @param code - Code to validate
 * @returns True if valid format
 */
export function isValidCode(code: string): boolean {
  // Format: XXXX-YYYY using only unambiguous chars (no 0/O, 1/I/L)
  const pattern = /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789]{4}$/;
  return pattern.test(code);
}

/**
 * Normalize a connection code (uppercase, trim).
 *
 * @param code - Code to normalize
 * @returns Normalized code or null if invalid
 */
export function normalizeCode(code: string): ConnectionCode | null {
  const normalized = code.trim().toUpperCase();

  // Handle case where user types without dash
  if (/^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}[23456789]{4}$/.test(normalized)) {
    return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
  }

  if (isValidCode(normalized)) {
    return normalized;
  }

  return null;
}

/**
 * Calculate code entropy in bits.
 * Useful for security analysis.
 */
export function codeEntropy(
  alphaLength: number = DEFAULT_ALPHA_LENGTH,
  numericLength: number = DEFAULT_NUMERIC_LENGTH,
): number {
  const alphaBits = Math.log2(ALPHA_CHARS.length) * alphaLength;
  const numericBits = Math.log2(NUMERIC_CHARS.length) * numericLength;
  return alphaBits + numericBits;
}
