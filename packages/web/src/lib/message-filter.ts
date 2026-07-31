/**
 * Filter patterns for tool-output noise in transcript/PTY messages.
 *
 * The daemon transcript bridge sends all text blocks from assistant entries,
 * which includes short tool-summary lines Claude writes alongside tool calls.
 * These are noise in the chat view and should be suppressed.
 */

const toolOutputPatterns = [
  /^\(No output\)$/,
  /^Done\.?$/i,
  /^OK\.?$/i,
  /^Added \d+ lines?/,
  /^Removed \d+ lines?/,
  /^Added \d+ lines?, removed \d+ lines?/,
  /^Read \d+ lines?/,
  /^Wrote \d+ lines?/,
  /^Created \S+$/,
  /^Deleted \S+$/,
  /^Modified \S+$/,
  /^Error editing file$/,
  /^\d+ files? (changed|modified|deleted|created)/,
  /^\[[\d/]+\]\s/, // Progress indicators like [0/1], [3/5]
  /^\[\d+-[a-z]/, // Kernel/system log prefixes like [8-virtio-console...]
  /^To https:\/\/github\.com\//, // git push output
  /^\w+ \| \d+ [+-]+$/, // git diff stat lines
  /^\d+ (insertions?|deletions?)\(/, // git diff summary
  /^\d+ messages$/, // Session message count
  /^[a-f0-9]{7,40}$/, // Bare git commit hashes
  /^feat:|^fix:|^chore:|^docs:|^refactor:|^test:/, // Commit message prefixes
  /^Sources?\//i, // Source file paths
  /^Tests?\//i, // Test file paths
  /^packages?\//i, // Package file paths
  /^\[[\w\s]+\]$/, // Bare bracketed labels like [Kernel Boot], [HV Diagnostic]
  /^vm_\w+::/i, // VM function calls
  /^Error \w+ file$/i, // Tool errors like "Error editing file"
  /^\(timeout \d+[smh]?\)$/i, // Timeout indicators like (timeout 3m), (timeout 20s)
  /^\.build\//i, // Build artifact paths
  /^: replacing existing signature$/i, // Codesigning output
  /^replacing existing signature$/i,
  /^Compiling \S+$/i, // Swift/build compilation
  /^Linking \S+$/i, // Build linking
  /^Build complete!/i,
  /^\d+ warnings? generated/i, // Compiler warnings summary
  /^Now update \S+/i, // Tool action summaries ("Now update scratch_history...")
  /^[a-z_]+_t$/i, // C/Swift type names like operating_modes_t
  /^Let me fix:?$/i, // Short tool action phrases
  /^Set model to\b/i, // Model switch notifications
  /^\[[\w\s.-]+\]\s*$/i, // Bracketed status like [task-name]
  /^Billed\b/i, // Billing info
  /^↓\s*\d/i, // Token count indicators (↓ 310 tokens)
  /^·\s/i, // Middle dot bullet points (Claude Code status)
  /^\d+%\s*conte?x?t?/i, // Context percentage (85% context)
  /^Using\s/i, // "Using model X" status
  /^Switching\s/i, // "Switching to..." status
];

/** Patterns for content that contains XML/protocol tags that should be stripped */
const xmlTagPatterns = [
  /<local-command-caveat>.*?<\/local-command-caveat>/gs,
  /<local-command-stdout>.*?<\/local-command-stdout>/gs,
  /<command-name>.*?<\/command-name>/gs,
  /<command-message>.*?<\/command-message>/gs,
  /<command-args>.*?<\/command-args>/gs,
  /<system-reminder>.*?<\/system-reminder>/gs,
  // COMPATIBILITY LAYER, not the primary defense (#936). The daemon now
  // filters `isMeta: true` entries — including a subagent's own
  // `<agent-message from="...">` report — before they ever reach a client
  // (`TranscriptMessageBridge.handleUserEntry`). This pattern only matters
  // when talking to an older daemon that still ships that entry as a raw
  // string. Real captured samples put a human-readable preamble sentence
  // BEFORE the tag ("Another Claude session sent a message:\n<agent-message
  // from=\"...\">..."), so the entry does not start with the tag at all — a
  // bare `<agent-message` prefix match would miss every real sample. Match
  // the preamble sentence instead, same convention (and the same literal
  // string) as `auto-approve/authority.ts`'s `NON_HUMAN_WRAPPER_PREFIXES` on
  // the daemon side, so the two never drift apart. Strips to the end of the
  // string rather than requiring a closing `</agent-message>` tag, because
  // whether one is ever present is unconfirmed (#936 "Not verified").
  /Another Claude session sent a message:[\s\S]*$/g,
];

/**
 * Strip protocol/XML tags from message content.
 * Returns cleaned text, or empty string if nothing remains.
 */
export function stripProtocolTags(content: string): string {
  let cleaned = content;
  for (const pattern of xmlTagPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }
  return cleaned.trim();
}

/** Patterns that match regardless of message length */
const alwaysFilterPatterns = [
  /^[^\x00-\x7F]\s/, // Any non-ASCII char + space = Claude Code UI marker
  /^Tip:/i, // Claude Code tips
  /^\w+ing\.{3}$/i, // Thinking status ("Thinking...")
  /^\w+ing…$/i, // Same with ellipsis char
  /^\/Users\/\S+$/i, // Bare absolute file paths
  /^\.context\//i, // Context file paths
  /^\$ .+/, // Shell command echo
];

/**
 * Check if a message is tool-output noise that should be suppressed.
 */
export function isToolOutputNoise(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  // Always-filter patterns (any length)
  for (const pattern of alwaysFilterPatterns) {
    if (pattern.test(trimmed)) return true;
  }
  // Length-guarded patterns (short messages only)
  if (trimmed.length < 80) {
    for (const pattern of toolOutputPatterns) {
      if (pattern.test(trimmed)) return true;
    }
  }
  return false;
}

/**
 * Clean preview text for session cards.
 * Strips XML tags and protocol markers.
 */
export function cleanPreviewText(text: string): string {
  let cleaned = stripProtocolTags(text);
  // Strip any remaining angle-bracket tags
  cleaned = cleaned.replace(/<[^>]+>/g, '').trim();
  return cleaned;
}
