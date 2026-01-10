/**
 * ANSI escape sequence handling.
 *
 * Strips ANSI codes to get clean text for parsing,
 * while preserving the original for display.
 */

/**
 * Strip all ANSI escape sequences from text.
 *
 * Handles:
 * - SGR (colors, bold, etc.): ESC[...m
 * - Cursor movement: ESC[...A/B/C/D/H/etc.
 * - Screen control: ESC[...J/K
 * - Other CSI sequences: ESC[...
 * - OSC sequences: ESC]...ST
 */
export function stripAnsi(text: string): string {
  // Comprehensive ANSI escape sequence patterns
  // eslint-disable-next-line no-control-regex
  const ansiPattern =
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

  // OSC sequences (ESC ] ... ST or ESC ] ... BEL)
  // eslint-disable-next-line no-control-regex
  const oscPattern = /\u001b\](?:[^\u0007\u001b]|\u001b[^\\])*(?:\u0007|\u001b\\)/g;

  // Private mode sequences
  // eslint-disable-next-line no-control-regex
  const privatePattern = /\u001b\[\?[0-9;]*[hlsr]/g;

  return text
    .replace(oscPattern, '')
    .replace(privatePattern, '')
    .replace(ansiPattern, '');
}

/**
 * Check if text contains ANSI sequences.
 */
export function hasAnsi(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u001b\u009b]/.test(text);
}

/**
 * Normalize line endings to \n.
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Clean text for parsing: strip ANSI and normalize line endings.
 */
export function cleanForParsing(text: string): string {
  return normalizeLineEndings(stripAnsi(text));
}

/**
 * Split text into lines, handling ANSI codes properly.
 */
export function splitLines(text: string): string[] {
  return normalizeLineEndings(text).split('\n');
}
