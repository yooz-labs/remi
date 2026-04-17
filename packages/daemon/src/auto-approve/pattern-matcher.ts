/**
 * Pattern matcher for auto-approve allow/deny lists.
 *
 * Uses simple substring matching (not glob/regex) to address the compound
 * command problem: Claude Code's strict prefix pattern `Bash(git push:*)`
 * fails to match `cd /foo && git push origin main` because the compound
 * doesn't start with `git push`. Substring match treats "git push" as
 * "git push is anywhere in this command string", which matches the way
 * users actually think about their rules.
 *
 * For Bash: match against the `command` field of tool_input (substring).
 * For other tools (Read, Glob, Grep, Edit, Write, etc.): match the bare
 * tool name against the pattern list.
 *
 * Deny patterns are evaluated before allow; any deny match wins.
 */

/**
 * Check if a PermissionRequest matches any of the given patterns.
 *
 * @param toolName Name of the Claude Code tool (Bash, Edit, Read, etc.)
 * @param toolInput Raw tool_input from the hook event
 * @param patterns User-defined substring patterns
 * @returns The first matching pattern, or null if none matched
 */
export function matchPattern(
  toolName: string,
  toolInput: Record<string, unknown>,
  patterns: readonly string[],
): string | null {
  if (patterns.length === 0) return null;

  // Bash: substring match against the command string.
  if (toolName === 'Bash') {
    const command = typeof toolInput['command'] === 'string' ? toolInput['command'] : '';
    if (!command) return null;
    for (const pattern of patterns) {
      if (pattern.length > 0 && command.includes(pattern)) {
        return pattern;
      }
    }
    return null;
  }

  // Other tools: pattern is the bare tool name (e.g. "Read", "Glob").
  // A pattern equal to the tool name matches any invocation of that tool.
  for (const pattern of patterns) {
    if (pattern === toolName) {
      return pattern;
    }
  }
  return null;
}
