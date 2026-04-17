/**
 * Secondary safety net for synchronous Task-tool subagent wrapping.
 *
 * PRIMARY filter: cli.ts checks `input.agent_id` on every hook event and drops
 * subagent/team events at the hook-server layer (Claude Code tags subagent
 * events with `agent_id`, confirmed empirically 2026-04-16). That is the
 * reliable mechanism for Task-subagent, TaskCreate (background), TeamCreate
 * and team members.
 *
 * This tracker covers edge cases where `agent_id` is absent: the
 * Notification(permission_prompt) dedup fast-path in HookEventBridge, and any
 * legacy Claude Code version that pre-dates the agent_id field. It counts
 * active Task tool_use_ids as a proxy for "nested synchronous subagent run":
 *
 *   PreToolUse(Task)  -> track use_id
 *     PreToolUse(Bash)              (subagent's internal tool call — nested)
 *     PostToolUse(Bash)
 *     ...
 *   PostToolUse(Task) -> drop use_id
 *
 * Tracks by tool_use_id to correctly handle concurrent Task calls. Note: the
 * active set represents CONCURRENT count, not a traditional call-stack depth.
 * Async background Task/TaskCreate spawns return immediately without wrapping
 * — `agent_id` is the only filter that catches those.
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

  /** True when at least one synchronous Task tool call is in-flight. */
  isInSubagentContext(): boolean {
    return this.active.size > 0;
  }

  /** Count of concurrent active Task tool_use_ids (NOT call-stack depth). */
  activeCount(): number {
    return this.active.size;
  }

  /** Reset all tracked state (e.g. on session restart). */
  reset(): void {
    this.active.clear();
  }
}
