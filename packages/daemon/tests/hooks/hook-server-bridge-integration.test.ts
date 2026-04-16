/**
 * End-to-end: real HTTP POST to HookServer -> bridge integration.
 *
 * Exercises the full path so schema assumptions (field names, casing of
 * tool_use_id) are exercised against live dispatch. Unit tests using
 * hand-constructed objects can't catch e.g. snake_case vs camelCase mismatch.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { AgentStatus, Question, UUID } from '@remi/shared';
import { HookEventBridge } from '../../src/hooks/hook-event-bridge.ts';
import { HookServer } from '../../src/hooks/hook-server.ts';

describe('HookServer -> HookEventBridge (HTTP integration)', () => {
  let server: HookServer | null = null;

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
  });

  async function post(url: string, body: Record<string, unknown>): Promise<number> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.status;
  }

  test('tool_use_id flows from HTTP body into subagent tracker', async () => {
    const statuses: Array<{ status: AgentStatus; context?: string }> = [];
    const questions: Question[] = [];
    const bridge = new HookEventBridge('session-1' as UUID, {
      onStatusChange: (status, context) => {
        statuses.push(context !== undefined ? { status, context } : { status });
      },
      onQuestion: (q) => questions.push(q),
      onSessionInfo: () => {},
    });

    server = new HookServer({ port: 0 });
    const h = bridge.hookHandlers();
    server.on('PreToolUse', (input) => h.onPreToolUse?.(input));
    server.on('PostToolUse', (input) => h.onPostToolUse?.(input));
    server.on('PermissionRequest', (input) => h.onPermissionRequest?.(input));
    server.start();
    const url = `http://127.0.0.1:${server.port}/hooks`;

    // POST PreToolUse(Task) with tool_use_id
    expect(
      await post(url, {
        hook_event_name: 'PreToolUse',
        session_id: 'session-1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
        permission_mode: 'default',
        tool_name: 'Task',
        tool_input: { subagent_type: 'Explore', prompt: 'look' },
        tool_use_id: 'tu_http_1',
      }),
    ).toBe(200);

    expect(bridge.isInSubagentContext()).toBe(true);

    // Subagent's Bash PermissionRequest should now be suppressed
    expect(
      await post(url, {
        hook_event_name: 'PermissionRequest',
        session_id: 'session-1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
        permission_mode: 'default',
        tool_name: 'Bash',
        tool_input: { command: 'nmap -sV' },
      }),
    ).toBe(200);

    expect(questions).toHaveLength(0);

    // PostToolUse(Task) with matching tool_use_id closes context
    expect(
      await post(url, {
        hook_event_name: 'PostToolUse',
        session_id: 'session-1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
        permission_mode: 'default',
        tool_name: 'Task',
        tool_input: {},
        tool_response: { ok: true },
        tool_use_id: 'tu_http_1',
      }),
    ).toBe(200);

    expect(bridge.isInSubagentContext()).toBe(false);

    // Now a real user-directed PermissionRequest should pass through
    expect(
      await post(url, {
        hook_event_name: 'PermissionRequest',
        session_id: 'session-1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
        permission_mode: 'default',
        tool_name: 'Bash',
        tool_input: { command: 'dig example.com' },
      }),
    ).toBe(200);

    expect(questions).toHaveLength(1);
  });

  test('PreToolUse without tool_use_id degrades gracefully (no context)', async () => {
    const bridge = new HookEventBridge('session-1' as UUID, {
      onStatusChange: () => {},
      onQuestion: () => {},
      onSessionInfo: () => {},
    });

    server = new HookServer({ port: 0 });
    const h = bridge.hookHandlers();
    server.on('PreToolUse', (input) => h.onPreToolUse?.(input));
    server.start();
    const url = `http://127.0.0.1:${server.port}/hooks`;

    await post(url, {
      hook_event_name: 'PreToolUse',
      session_id: 'session-1',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/tmp',
      permission_mode: 'default',
      tool_name: 'Task',
      tool_input: {},
      // tool_use_id intentionally omitted
    });

    // Should NOT enter subagent context when id missing
    expect(bridge.isInSubagentContext()).toBe(false);
  });
});
