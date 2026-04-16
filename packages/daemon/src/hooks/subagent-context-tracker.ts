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

/** Tool names that spawn a nested agent context.
 *  - `Task`: standard Claude Code subagent spawn
 *  - `Agent`: cc-ref reference name; include for safety in case variants ship
 *  - Future tools: teammate-spawning, delegation, etc. Add here as Claude Code evolves.
 *  When adding, also extend the regression tests. */
const NESTING_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

export class SubagentContextTracker {
  /** Active tool_use_ids that are currently spawning nested agents. */
  private readonly active = new Set<string>();
  /** Whether we've warned about a nesting tool firing without tool_use_id. Throttles spam. */
  private warnedMissingId = false;

  /** Record PreToolUse. Returns true iff a nesting context was actually started
   *  (tool is in NESTING_TOOLS AND tool_use_id was present). */
  onPreToolUse(toolName: string, toolUseId: string | undefined): boolean {
    if (!NESTING_TOOLS.has(toolName)) return false;
    if (!toolUseId) {
      if (!this.warnedMissingId) {
        this.warnedMissingId = true;
        console.warn(
          `[SubagentContextTracker] ${toolName} fired without tool_use_id; nested-agent filtering disabled for this call`,
        );
      }
      return false;
    }
    this.active.add(toolUseId);
    return true;
  }

  /** Record PostToolUse. Returns true iff a nesting context was ended
   *  (tool is in NESTING_TOOLS AND the tool_use_id matched an active entry). */
  onPostToolUse(toolName: string, toolUseId: string | undefined): boolean {
    if (!NESTING_TOOLS.has(toolName)) return false;
    if (!toolUseId) return false;
    return this.active.delete(toolUseId);
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
