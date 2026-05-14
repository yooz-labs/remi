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

    // Phase 4 (#419): PermissionRequest events during a Task tool call
    // are no longer dropped at the bridge level. The tracker (cli.ts
    // wiring) gates push by PTY presence. This test now asserts the
    // bookkeeping: handlePermissionRequest forwards both events, and
    // isInSubagentContext() tracks tool_use_id correctly.
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

    expect(questions).toHaveLength(1);
    expect(questions[0]?.text).toContain('nmap -sV');

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

    // Post-Task PermissionRequest still forwards.
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

    expect(questions).toHaveLength(2);
    expect(questions[1]?.text).toContain('dig example.com');
  });

  test('Phase 4 (#419): subagent PermissionRequest with agent_id forwards to the bridge', async () => {
    // Pre-phase-4 the cli.ts hook listener dropped events with agent_id
    // set, suppressing user-visible questions for Task/Agent subagents.
    // Phase 4 demoted agent_id to metadata: events forward to the
    // bridge and the QuestionPresenceTracker (cli.ts) gates push by
    // PTY presence. This test models the new cli.ts behavior: no
    // listener-level drop, both events reach the bridge.
    const questions: Question[] = [];
    const bridge = new HookEventBridge('session-1' as UUID, {
      onStatusChange: () => {},
      onQuestion: (q) => questions.push(q),
      onSessionInfo: () => {},
    });
    server = new HookServer({ port: 0 });
    const h = bridge.hookHandlers();
    server.on('PermissionRequest', (input) => h.onPermissionRequest?.(input));
    server.start();
    const url = `http://127.0.0.1:${server.port}/hooks`;

    // Subagent PermissionRequest with agent_id set (as captured from real payload)
    expect(
      await post(url, {
        hook_event_name: 'PermissionRequest',
        session_id: 'session-1',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/tmp',
        permission_mode: 'default',
        tool_name: 'Bash',
        tool_input: { command: 'nmap --version' },
        agent_id: 'a26be54375f029520',
        agent_type: 'general-purpose',
      }),
    ).toBe(200);

    // Bridge forwarded the question; cli.ts wiring would route it to
    // tracker.recordPendingHook (push only on PTY confirmation).
    expect(questions).toHaveLength(1);
    expect(questions[0]?.text).toContain('nmap --version');

    // Main PermissionRequest (no agent_id) forwards too.
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

    expect(questions).toHaveLength(2);
    expect(questions[1]?.text).toContain('dig example.com');
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
