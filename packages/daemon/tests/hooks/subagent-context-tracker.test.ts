import { describe, expect, test } from 'bun:test';
import { SubagentContextTracker } from '../../src/hooks/subagent-context-tracker.ts';

describe('SubagentContextTracker', () => {
  test('starts with zero depth', () => {
    const t = new SubagentContextTracker();
    expect(t.isInSubagentContext()).toBe(false);
    expect(t.depth()).toBe(0);
  });

  test('Task PreToolUse enters context', () => {
    const t = new SubagentContextTracker();
    expect(t.onPreToolUse('Task', 'tu_1')).toBe(true);
    expect(t.isInSubagentContext()).toBe(true);
    expect(t.depth()).toBe(1);
  });

  test('Agent tool is also treated as nesting', () => {
    const t = new SubagentContextTracker();
    expect(t.onPreToolUse('Agent', 'tu_a1')).toBe(true);
    expect(t.isInSubagentContext()).toBe(true);
  });

  test('Task PostToolUse exits context', () => {
    const t = new SubagentContextTracker();
    t.onPreToolUse('Task', 'tu_1');
    expect(t.onPostToolUse('Task', 'tu_1')).toBe(true);
    expect(t.isInSubagentContext()).toBe(false);
    expect(t.depth()).toBe(0);
  });

  test('PostToolUse returns false when tool_use_id does not match an active entry', () => {
    const t = new SubagentContextTracker();
    t.onPreToolUse('Task', 'tu_1');
    expect(t.onPostToolUse('Task', 'tu_2')).toBe(false); // wrong id
    expect(t.depth()).toBe(1); // still in context
  });

  test('non-nesting tools do not affect depth', () => {
    const t = new SubagentContextTracker();
    expect(t.onPreToolUse('Bash', 'tu_b1')).toBe(false);
    expect(t.onPreToolUse('Read', 'tu_r1')).toBe(false);
    expect(t.onPreToolUse('Edit', 'tu_e1')).toBe(false);
    expect(t.isInSubagentContext()).toBe(false);
  });

  test('nested tools during Task context stay inside', () => {
    const t = new SubagentContextTracker();
    t.onPreToolUse('Task', 'tu_task1');
    // Inner tools fire but don't exit the context
    t.onPreToolUse('Bash', 'tu_b1');
    t.onPostToolUse('Bash', 'tu_b1');
    expect(t.isInSubagentContext()).toBe(true);
    t.onPostToolUse('Task', 'tu_task1');
    expect(t.isInSubagentContext()).toBe(false);
  });

  test('concurrent Task invocations tracked by tool_use_id', () => {
    const t = new SubagentContextTracker();
    t.onPreToolUse('Task', 'tu_task_A');
    t.onPreToolUse('Task', 'tu_task_B');
    expect(t.depth()).toBe(2);
    t.onPostToolUse('Task', 'tu_task_A');
    expect(t.depth()).toBe(1);
    expect(t.isInSubagentContext()).toBe(true); // still in B
    t.onPostToolUse('Task', 'tu_task_B');
    expect(t.depth()).toBe(0);
    expect(t.isInSubagentContext()).toBe(false);
  });

  test('unpaired PostToolUse does not go negative', () => {
    const t = new SubagentContextTracker();
    t.onPostToolUse('Task', 'tu_phantom');
    expect(t.depth()).toBe(0);
    expect(t.isInSubagentContext()).toBe(false);
  });

  test('missing tool_use_id does not track and returns false', () => {
    // If Claude Code ever omits tool_use_id, we gracefully degrade: no tracking.
    // Returns false so callers can observe the degradation. Warns once.
    const t = new SubagentContextTracker();
    expect(t.onPreToolUse('Task', undefined)).toBe(false);
    expect(t.depth()).toBe(0);
  });

  test('asymmetric tool_use_id: Pre has id, Post without id leaks the entry', () => {
    // Document behavior: mismatched tool_use_id between Pre and Post leaks
    // the Pre's entry. The reset() on session boundaries in HookEventBridge
    // is the safety net for this.
    const t = new SubagentContextTracker();
    t.onPreToolUse('Task', 'tu_pre');
    expect(t.onPostToolUse('Task', undefined)).toBe(false);
    expect(t.depth()).toBe(1); // leak; session lifecycle reset catches it
  });

  test('reset clears state', () => {
    const t = new SubagentContextTracker();
    t.onPreToolUse('Task', 'tu_1');
    t.onPreToolUse('Task', 'tu_2');
    expect(t.depth()).toBe(2);
    t.reset();
    expect(t.depth()).toBe(0);
    expect(t.isInSubagentContext()).toBe(false);
  });

  test('double PreToolUse with same id is idempotent', () => {
    const t = new SubagentContextTracker();
    t.onPreToolUse('Task', 'tu_same');
    t.onPreToolUse('Task', 'tu_same');
    expect(t.depth()).toBe(1); // Set dedupes
    t.onPostToolUse('Task', 'tu_same');
    expect(t.depth()).toBe(0);
  });
});
