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

/**
 * Filter out Claude Code terminal UI elements.
 *
 * Removes:
 * - ASCII art logo (block characters)
 * - Box-drawing character lines (─────)
 * - Prompt indicators (❯, >)
 * - Status lines (Claude in Chrome, accept edits, etc.)
 * - Version/model info lines
 * - Path display lines
 * - Empty lines and whitespace
 */
export function filterTerminalUI(text: string): string {
  const lines = splitLines(text);
  const filteredLines: string[] = [];

  // Patterns for UI elements to filter out
  const uiPatterns = [
    // Claude Code ASCII art logo (block characters) - anywhere in line
    /[▐▛▜▌▝█▘]{2,}/,
    // Box-drawing characters (horizontal lines) - lines with mostly dashes
    /^[\s─━═┄┈╌╍┅┉◆◇]+[\s─━═┄┈╌╍┅┉◆◇\w]*$/,
    // Line that starts with box-drawing (even with trailing text)
    /^[─━═┄┈╌╍┅┉◆◇\s]{5,}/,
    // Line containing box-drawing with escape artifacts
    /[─━═┄┈╌╍┅┉]{3,}.*\d+[a-z]/i,
    // Diamond/bullet decorations
    /^[\s]*[◆◇◈●○◐◑]+/,
    // Prompt line
    /^[\s]*❯/,
    // Claude Code version line
    /Claude Code v[\d.]+/i,
    // Model info line
    /Opus[\s\d.]+.*Claude/i,
    // Path display (contains ~/ anywhere)
    /~\/[\w\/-]+/,
    // Status/UI elements
    /accept edits on/i,
    /shift\+tab to cycle/i,
    /Claude in Chrome enabled/i,
    /\/chrome$/,
    // Placeholder prompts
    /Try ["'].*["']/i,
    // Control sequences that leaked through (like 026l, 1u, etc)
    /^\d*[a-z]+$/i,
    /\d{2,}[a-z]$/i,
    // Lines that are just escape sequence artifacts
    /^[\s]*[1-9]?u+[1-9]?u*[\s]*$/,
    // Lines with just small block characters (logo fragments)
    /^[\s▘▝▖▗\s]+$/,
    // Lines starting with > (prompts)
    /^[\s]*>\s/,
    // Lines containing replacement characters (invalid UTF-8)
    /\uFFFD/,
    // Lines that are mostly non-alphanumeric (UI decorations)
    /^[^\w\s]{3,}$/,
    // Thinking/status indicators
    /Honking\.\.\./i,
    /Misting\.\.\./i,
    /\(esc to interrupt/i,
    /thought for \d+s/i,
    /Running\.\.\./i,
    // Lines that are just symbols with Bash/tool names
    /^[+*✱✲✳✴✵✶✷✸✹✺]?\s*(Honking|Misting|Running)/i,
    // Tool output tree characters with status (filter status lines, keep content)
    /^[\s]*⎿[\s]*(Running|Waiting|No content)/i,
    /^[\s]*⎿[\s]*$/,
    // Lines starting with + or * followed by status
    /^[+*]\s*(Honking|Misting)/i,
    // Date output from bash (standalone)
    /^\s*[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d+:\d+:\d+\s+\w+\s+\d{4}\s*$/,
    // Tool indicators like "Bash(date)", "● Bash"
    /Bash\([^)]*\)/i,
    /●\s*Bash/i,
    /⏺\s*Bash/i,
    // Accept edits UI
    /⏵⏵\s*accept/i,
    // Lines that are mostly brackets
    /^[\[\]\s]+$/,
    // Lines starting with brackets followed by bullet
    /^[\[\]\s]*●/,
    /^[\[\]\s]*⏺/,
    // Partial UI fragments
    /^to cycle\)/i,
    /cycle\)\s*$/i,
    // Lines that are just whitespace and special chars
    /^[\s\[\]●⏺⏵]+$/,
  ];

  for (const line of lines) {
    // Skip empty or whitespace-only lines
    if (line.trim().length === 0) {
      continue;
    }

    // Check if line matches any UI pattern
    let isUIElement = false;
    for (const pattern of uiPatterns) {
      if (pattern.test(line)) {
        isUIElement = true;
        break;
      }
    }

    if (!isUIElement) {
      filteredLines.push(line);
    }
  }

  return filteredLines.join('\n');
}

/**
 * Full cleaning pipeline: strip ANSI, normalize, and filter UI.
 */
export function cleanAndFilterOutput(text: string): string {
  const cleaned = cleanForParsing(text);
  return filterTerminalUI(cleaned);
}

/**
 * Message boundary markers in Claude Code output.
 */
export const MESSAGE_MARKERS = {
  // Agent message/tool start (filled circle - various colors)
  AGENT_START: /^[\s]*[⏺●]/,
  // User input (prompt character)
  USER_INPUT: /^[\s]*❯/,
  // Thinking indicators
  THINKING: /^[\s]*[✻✱✲✳]/,
  // Tool output continuation
  TOOL_OUTPUT: /^[\s]*⎿/,
};

/**
 * Detect if a line starts a new message block.
 * Returns the type of message or null if continuation.
 */
export function detectMessageBoundary(line: string): 'agent' | 'user' | 'thinking' | null {
  if (MESSAGE_MARKERS.AGENT_START.test(line)) {
    return 'agent';
  }
  if (MESSAGE_MARKERS.USER_INPUT.test(line)) {
    return 'user';
  }
  if (MESSAGE_MARKERS.THINKING.test(line)) {
    return 'thinking';
  }
  return null;
}

/**
 * Clean a line by removing message markers but keeping content.
 */
export function cleanMessageLine(line: string): string {
  // Remove leading markers but keep the content
  return line
    .replace(/^[\s]*[⏺●✻✱✲✳❯⎿]\s*/, '')
    .trim();
}
