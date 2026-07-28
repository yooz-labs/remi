/**
 * Pattern matcher for auto-approve allow/deny lists.
 *
 * Allow and deny are NOT symmetric, and deliberately so (#536). Allow is the
 * fail-open path: a match skips the LLM entirely and approves at 0ms, so it
 * must be precise. Deny is the fail-closed path: a match refuses, so breadth
 * is the safe direction and it stays a plain substring search.
 *
 * ## Allow (`matchAllowPattern`)
 *
 * For Bash, the command is split into compound segments (`&&`, `||`, `;`, `|`,
 * newline) and EVERY segment must be neutral (cd/pwd/echo/...) or
 * word-boundary-prefix-match an allow entry, with the shell-control veto from
 * `shell-safety.ts` rejecting command substitution, redirection to a real file,
 * and backgrounding. This keeps the original motivation for substring matching
 * (`cd /foo && git push` should match a `git push` entry, which Claude Code's
 * strict prefix matching misses) while refusing what substring matching never
 * could: a command whose OTHER segments nobody approved.
 *
 * Bare tool names are not Bash patterns. An entry that looks like a tool name
 * (`Read`, `NotebookRead`, `mcp__server__tool`) matches that tool and is never
 * tested against a Bash command string. Before #536 it was, so the shipped
 * default `allow = ['Read', 'Glob', 'Grep']` approved `rm -rf Readme` at 0ms.
 *
 * Mutation flags are NOT vetoed here, unlike the curated permission groups: a
 * user allow entry may legitimately be a write (`git commit`, `bun run build`),
 * and vetoing those would refuse exactly what the user opted into.
 *
 * ## Deny and subagent_alert (`matchSubstringPattern`)
 *
 * For Bash, a plain substring search over the whole command, including entries
 * that look like tool names. Over-matching a deny costs an LLM evaluation the
 * user could have skipped; under-matching one costs a command that should have
 * been refused. It is left broad on purpose, and `subagent_alert` shares it for
 * the same reason: an alert that misses is worse than one that over-fires.
 *
 * For every non-Bash tool, both paths match the bare tool name exactly.
 *
 * Deny is evaluated before allow; any deny match wins.
 */

import { matchCoveredCommand } from './shell-safety.ts';

/**
 * True if a pattern names a tool rather than a shell command.
 *
 * Tool names are single tokens that either start with an uppercase letter
 * (`Read`, `Bash`, `NotebookRead`, `WebFetch`) or carry the MCP prefix
 * (`mcp__server__tool`). Shell commands are lowercase (`ls`, `git status`) or
 * contain whitespace, so the two shapes do not collide in practice.
 */
export function looksLikeToolName(pattern: string): boolean {
  if (pattern === '' || /\s/.test(pattern)) return false;
  if (pattern.startsWith('mcp__')) return true;
  return /^[A-Z][A-Za-z0-9_]*$/.test(pattern);
}

/** Exact bare-tool-name match, used by both paths for every non-Bash tool. */
function matchToolName(toolName: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    if (pattern === toolName) return pattern;
  }
  return null;
}

/**
 * Check whether a permission request is covered by the ALLOW patterns.
 *
 * @param toolName Name of the Claude Code tool (Bash, Edit, Read, etc.)
 * @param toolInput Raw tool_input from the hook event
 * @param patterns User-defined allow entries
 * @returns The matched entry, or null if the request must still be evaluated
 */
export function matchAllowPattern(
  toolName: string,
  toolInput: Record<string, unknown>,
  patterns: readonly string[],
): string | null {
  if (patterns.length === 0) return null;

  if (toolName === 'Bash') {
    const command = typeof toolInput['command'] === 'string' ? toolInput['command'] : '';
    if (!command) return null;
    // Tool-name entries say nothing about shell commands. Dropping them here is
    // what stops `allow = ['Read']` from approving any command containing "Read".
    const commandPatterns = patterns.filter((p) => p.length > 0 && !looksLikeToolName(p));
    if (commandPatterns.length === 0) return null;
    return matchCoveredCommand(command, commandPatterns);
  }

  return matchToolName(toolName, patterns);
}

/**
 * Check whether a request matches any pattern in a BROAD list (deny,
 * subagent_alert).
 *
 * Substring matching for Bash, deliberately broader than the allow path. See
 * the module comment for why the asymmetry is the safe direction.
 *
 * @param toolName Name of the Claude Code tool (Bash, Edit, Read, etc.)
 * @param toolInput Raw tool_input from the hook event
 * @param patterns User-defined deny or alert entries
 * @returns The first matching entry, or null if none matched
 */
export function matchSubstringPattern(
  toolName: string,
  toolInput: Record<string, unknown>,
  patterns: readonly string[],
): string | null {
  if (patterns.length === 0) return null;

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

  return matchToolName(toolName, patterns);
}
