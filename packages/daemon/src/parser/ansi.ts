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
 *
 * Special handling:
 * - Cursor right (ESC[nC) is replaced with spaces to preserve word spacing
 */
export function stripAnsi(text: string): string {
  // First, replace cursor-up/down with newlines (they indicate line changes in screen-based UI)
  // ESC[nA moves cursor up n lines, ESC[nB moves cursor down n lines
  // eslint-disable-next-line no-control-regex
  const cursorVerticalPattern = /\u001b\[(\d*)[AB]/g;
  let result = text.replace(cursorVerticalPattern, '\n');

  // Replace cursor-right movements with spaces (preserves word spacing)
  // ESC[nC moves cursor right n columns - replace with n spaces
  // But only for n > 1; for n=1 between word chars, it's likely a screen refresh
  // eslint-disable-next-line no-control-regex
  const cursorRightPattern = /\u001b\[(\d*)C/g;
  result = result.replace(cursorRightPattern, (_match, count) => {
    const spaces = Number.parseInt(count || '1', 10);
    return spaces > 1 ? ' '.repeat(spaces) : ' ';
  });

  // OSC sequences (ESC ] ... ST or ESC ] ... BEL)
  // eslint-disable-next-line no-control-regex
  const oscPattern = /\u001b\](?:[^\u0007\u001b]|\u001b[^\\])*(?:\u0007|\u001b\\)/g;
  result = result.replace(oscPattern, '');

  // Private mode sequences
  // eslint-disable-next-line no-control-regex
  const privatePattern = /\u001b\[\?[0-9;]*[hlsr]/g;
  result = result.replace(privatePattern, '');

  // Comprehensive ANSI escape sequence patterns (colors, other cursor moves, etc.)
  // eslint-disable-next-line no-control-regex
  const ansiPattern = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
  result = result.replace(ansiPattern, '');

  return result;
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
    // Thinking/status indicators (Claude uses funny verbs ending in "ing...")
    // Generic pattern: any word ending in "ing" followed by "..." or "…"
    /\w+ing\.{2,}/i,
    /\w+ing…/i,
    /\(esc to interrupt/i,
    /thought for \d+s/i,
    // Accept edits UI (full and partial)
    /⏵⏵\s*accept/i,
    /⏵⏵\s*acce/i,
    /^[\s]*⏵⏵/,
    // Token count indicators
    /↓\s*[\d.]+k?\s*tokens/i,
    // Lines that are just symbols with Bash/tool names
    /^[+*✱✲✳✴✵✶✷✸✹✺]?\s*(Honking|Misting|Running)/i,
    // Tool output tree characters with status (filter status lines, keep content)
    /^[\s]*⎿[\s]*(Running|Waiting|No content)/i,
    /^[\s]*⎿[\s]*$/,
    // Tool output tree with checkmarks/crosses (task completion indicators)
    /^[\s]*⎿[\s]*[✔✓✗✕✘☑☒⬜]/,
    // Standalone checkmark/cross lines (subtask results)
    /^[\s]*[✔✓✗✕✘]\s+\w/,
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
    // ANSI color code fragments (like 39m, 37m, 35m, 90m)
    /^\d{1,3}m\s*$/,
    /^\s*\d{1,3}m$/,
    // Partial parentheses fragments from UI (like e), cle), ycle), le))
    /^[a-z]{0,5}\)$/i,
    // Tool output metadata lines (⎿ followed by status text)
    /^[\s]*⎿[\s]*(Read|Wrote|Created|Deleted|Modified|total|packages|Sun|Mon|Tue|Wed|Thu|Fri|Sat)/i,
    /^[\s]*⎿[\s]*\d+\s*(lines?|files?|bytes?)/i,
    /^[\s]*⎿[\s]*[a-f0-9]{6,}/i, // Git hashes
    /^[\s]*⎿[\s]*\{/, // JSON opening
    /^[\s]*⎿[\s]*bun\s/i, // bun commands
    // Lines that are just a bracket or bracket with spaces
    /^[\s]*[\[\]{}]+[\s]*$/,
    // Short lines that are likely fragments (under 5 chars, not alphanumeric)
    /^[^\w]{1,4}$/,
    // Lines ending with just escape artifacts
    /[0-9]+[a-z]$/i,
    // Tool execution indicators
    /^[\s]*⏺[\s]*(Read|Write|Bash|Edit|Glob|Grep|Task)\(/i,
    // Lines with just emoji indicators
    /^[\s]*🚀/,
    // Single letter followed by space at start (ANSI fragment like "m ")
    /^[a-z]\s*$/i,
    // Search pattern indicators
    /^Search\(pattern:/i,
    // Claude Code wizard/question UI elements
    // Lines containing checkboxes (☒ or ☐)
    /[☒☐]/,
    // Lines with wizard navigation arrows (← →) with submit/steps
    /[←→]\s*(☒|☐|✔|Submit)/,
    // "Enter to select" instruction text
    /Enter to select/i,
    // "Tab/Arrow keys" instruction text
    /Tab\/Arrow keys/i,
    // "Review your answers" wizard step
    /Review your answers/i,
    // "ctrl-g to edit" hints
    /ctrl-g to edit/i,
    // Lines starting with ❯ followed by numbered option
    /^[\s]*❯\s*\d+\./,
    // "Ready to submit" or garbled version
    /Ready\s+\w*ubmi/i,
    // Numbered options from wizard (indented number + period + text)
    /^\s+\d+\.\s+(Submit|Cancel|Yes|Type)/i,
    // Claude Code suggested command hints (end with ↵ send)
    /↵\s*send\s*$/i,
    /⏎\s*send\s*$/i,
    // Thinking animation fragments (character-by-character rendering artifacts)
    // Short lines starting with thinking symbols that aren't real content
    // Symbol + spaced single characters: "* z n", "+ g", "* z i"
    /^[+*✱✲✳✴✵✶✷✸✹✺·✢✻]\s+[a-z](\s+[a-z])*\s*$/i,
    // Symbol + numbers (cursor escape remnants): "* 5", "+ 8", "* 4 0"
    /^[+*✱✲✳✴✵✶✷✸✹✺·✢✻]\s+\d[\d\s]*$/,
    // Symbol + dots: "+ ..."
    /^[+*✱✲✳✴✵✶✷✸✹✺·✢✻]\s+\.{2,}\s*$/,
    // Symbol + arrow + partial word: "* ↓ inking)"
    /^[+*✱✲✳✴✵✶✷✸✹✺·✢✻]\s+[↓↑←→↵⏎]\s+\S{0,15}\s*$/,
    // Symbol + short text with dots/ellipsis: "* i ..."
    /^[+*✱✲✳✴✵✶✷✸✹✺·✢✻]\s+\S{1,3}\s+\.{2,}\s*$/,
    // Symbol + very short content (< 10 chars after symbol) that's not a list item
    /^[+*✱✲✳✴✵✶✷✸✹✺·✢✻]\s+.{1,8}\s*$/,
    // Lines with only thinking symbols and spaces
    /^[+*✱✲✳✴✵✶✷✸✹✺·✢✻\s]+$/,
    // Remi daemon status line
    /remi\s+:\d+\s+\w+/i,
    // Effort indicator (with or without bullet)
    /(high|medium|low)\s*·\s*\/effort/i,
    // Stop hook output
    /Ran\s+\d+\s+stop\s+hooks?\s/i,
    /stop\s+hook\s+error/i,
    // Plugin path fragments
    /\.claude\/plugins\/marketplaces\//,
    // Context percentage
    /\d+%\s*conte?x?t?/i,
    // Model info with context
    /\[(Opus|Sonnet|Haiku)\s[\d.]+.*context\]/i,
    // "no clients" / "starting" daemon status
    /\|\s*no\s+clients\s*\|/i,
    /\|\s*starting\s*\|/i,
    // Permission denied from hooks
    /Permission\s+denied\s*$/i,
    // "You'v" and similar truncated fragments
    /^You'v\s*$/,
    // Not logged in messages
    /Not\s+logged\s+in\s*·/i,
    // Claude in Chrome subscription message
    /Claude\s+in\s+Chrome\s+requires/i,
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
export function detectMessageBoundary(
  line: string,
): 'agent' | 'user' | 'thinking' | 'tool_output' | null {
  if (MESSAGE_MARKERS.AGENT_START.test(line)) {
    return 'agent';
  }
  if (MESSAGE_MARKERS.USER_INPUT.test(line)) {
    return 'user';
  }
  if (MESSAGE_MARKERS.THINKING.test(line)) {
    return 'thinking';
  }
  if (MESSAGE_MARKERS.TOOL_OUTPUT.test(line)) {
    return 'tool_output';
  }
  return null;
}

/**
 * Clean a line by removing message markers but keeping content.
 */
export function cleanMessageLine(line: string): string {
  // Remove leading markers but keep the content
  return line.replace(/^[\s]*[⏺●✻✱✲✳❯⎿]\s*/, '').trim();
}
