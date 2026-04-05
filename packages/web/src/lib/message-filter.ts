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
  /^\$ .+/, // Shell command echo ($ ls /path)
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
];

export function isToolOutputNoise(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  // Short messages (under 80 chars) matching known patterns
  if (trimmed.length < 80) {
    for (const pattern of toolOutputPatterns) {
      if (pattern.test(trimmed)) return true;
    }
  }
  return false;
}
