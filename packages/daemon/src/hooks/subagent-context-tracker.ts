/**
 * Tracks subagent/team execution depth for hook event filtering.
 *
 * Claude Code hooks are configured at the project level (`.claude/settings.local.json`)
 * and fire for EVERY tool call, including tools invoked by subagents spawned via
 * the `Task` tool. Hook payloads themselves don't carry an `agent_id` field that
 * would let us distinguish subagent calls from main-agent calls.
 *
 * We infer context by counting nesting depth:
 *
 *   PreToolUse(Task)  -> depth++   (main agent spawns subagent)
 *     PreToolUse(Bash)              (subagent's internal tool call — nested)
 *     PostToolUse(Bash)
 *     ...
 *   PostToolUse(Task) -> depth--   (subagent finished)
 *
 * While depth > 0, any PermissionRequest or Notification(permission_prompt) is
 * likely a subagent-internal request. The main agent is blocked waiting for the
 * Task tool to return and cannot generate new permission prompts during this
 * window. Auto-approve still evaluates these (subagents need tool execution) but
 * we suppress user-facing notifications to prevent inter-agent questions from
 * bubbling up to the team leader.
 *
 * Tracks by tool_use_id to correctly handle concurrent/nested Task calls.
 */

/** Tool names that spawn a nested agent context. */
const NESTING_TOOLS: ReadonlySet<string> = new Set([
  'Task', // standard subagent spawn
  // Future: teammate-spawning tools. Add here as Claude Code evolves.
]);

export class SubagentContextTracker {
  /** Active tool_use_ids that are currently spawning nested agents. */
  private readonly active = new Set<string>();

  /** Record PreToolUse. Returns true if this started a nesting context. */
  onPreToolUse(toolName: string, toolUseId: string | undefined): boolean {
    if (!NESTING_TOOLS.has(toolName)) return false;
    if (toolUseId) {
      this.active.add(toolUseId);
    }
    return true;
  }

  /** Record PostToolUse. Returns true if this ended a nesting context. */
  onPostToolUse(toolName: string, toolUseId: string | undefined): boolean {
    if (!NESTING_TOOLS.has(toolName)) return false;
    if (toolUseId) {
      this.active.delete(toolUseId);
    }
    return true;
  }

  /** True when a subagent/team context is in-flight. */
  isInSubagentContext(): boolean {
    return this.active.size > 0;
  }

  /** Current nesting depth (number of concurrent subagents). */
  depth(): number {
    return this.active.size;
  }

  /** Reset all tracked state (e.g. on session restart). */
  reset(): void {
    this.active.clear();
  }
}
