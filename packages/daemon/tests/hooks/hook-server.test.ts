import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { HookServer } from '../../src/hooks/hook-server.ts';
import type {
  NotificationHookInput,
  PermissionRequestHookInput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  StopFailureHookInput,
  StopHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
} from '../../src/hooks/hook-types.ts';

const TEST_PORT = 19876;

function makeUrl(port: number): string {
  return `http://127.0.0.1:${port}/hooks`;
}

function makePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'test-session',
    transcript_path: '/tmp/test.jsonl',
    cwd: '/tmp/project',
    permission_mode: 'default',
    ...overrides,
  };
}

describe('HookServer', () => {
  let server: HookServer;
  let port: number;

  beforeEach(() => {
    port = TEST_PORT + Math.floor(Math.random() * 1000);
  });

  afterEach(() => {
    server?.stop();
  });

  it('starts and stops', () => {
    server = new HookServer({ port });
    expect(server.isRunning).toBe(false);

    server.start();
    expect(server.isRunning).toBe(true);

    server.stop();
    expect(server.isRunning).toBe(false);
  });

  it('returns 404 for non-hook paths', async () => {
    server = new HookServer({ port });
    server.start();

    const res = await fetch(`http://127.0.0.1:${port}/other`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for GET requests', async () => {
    server = new HookServer({ port });
    server.start();

    const res = await fetch(makeUrl(port));
    expect(res.status).toBe(404);
  });

  it('accepts unknown event names with 200 (future-proofing)', async () => {
    server = new HookServer({ port });
    server.start();

    const res = await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePayload({ hook_event_name: 'UnknownEvent' })),
    });
    expect(res.status).toBe(200);
  });

  it('returns 400 for missing hook_event_name', async () => {
    server = new HookServer({ port });
    server.start();

    const res = await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePayload({})),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid JSON', async () => {
    const errors: Error[] = [];
    server = new HookServer({ port }, { onError: (e) => errors.push(e) });
    server.start();

    const res = await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(errors.length).toBe(1);
  });

  it('dispatches PreToolUse events via constructor callback', async () => {
    const received: PreToolUseHookInput[] = [];
    server = new HookServer(
      { port },
      {
        onPreToolUse: (input) => received.push(input),
      },
    );
    server.start();

    const payload = makePayload({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    const res = await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    expect(received.length).toBe(1);
    expect(received[0]?.tool_name).toBe('Bash');
  });

  it('dispatches PostToolUse events', async () => {
    const received: PostToolUseHookInput[] = [];
    server = new HookServer(
      { port },
      {
        onPostToolUse: (input) => received.push(input),
      },
    );
    server.start();

    const res = await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        makePayload({
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
          tool_response: 'file1.txt\nfile2.txt',
        }),
      ),
    });
    expect(res.status).toBe(200);
    expect(received.length).toBe(1);
  });

  it('dispatches Notification events', async () => {
    const received: NotificationHookInput[] = [];
    server = new HookServer(
      { port },
      {
        onNotification: (input) => received.push(input),
      },
    );
    server.start();

    const res = await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        makePayload({
          hook_event_name: 'Notification',
          notification_type: 'permission_prompt',
          message: 'Allow Bash tool?',
        }),
      ),
    });
    expect(res.status).toBe(200);
    expect(received.length).toBe(1);
    expect(received[0]?.notification_type).toBe('permission_prompt');
    expect(received[0]?.message).toBe('Allow Bash tool?');
  });

  it('dispatches Stop events', async () => {
    const received: StopHookInput[] = [];
    server = new HookServer(
      { port },
      {
        onStop: (input) => received.push(input),
      },
    );
    server.start();

    const res = await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        makePayload({
          hook_event_name: 'Stop',
          stop_hook_active: false,
        }),
      ),
    });
    expect(res.status).toBe(200);
    expect(received.length).toBe(1);
  });

  it('dispatches SessionStart events', async () => {
    const received: SessionStartHookInput[] = [];
    server = new HookServer(
      { port },
      {
        onSessionStart: (input) => received.push(input),
      },
    );
    server.start();

    const res = await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        makePayload({
          hook_event_name: 'SessionStart',
          source: 'startup',
          model: 'claude-opus-4-6',
        }),
      ),
    });
    expect(res.status).toBe(200);
    expect(received.length).toBe(1);
    expect(received[0]?.model).toBe('claude-opus-4-6');
  });

  it('dispatches PermissionRequest events', async () => {
    const received: PermissionRequestHookInput[] = [];
    server = new HookServer({ port }, { onPermissionRequest: (input) => received.push(input) });
    server.start();

    const res = await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        makePayload({
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf /' },
          permission_suggestions: ['Yes', 'No'],
        }),
      ),
    });
    expect(res.status).toBe(200);
    expect(received.length).toBe(1);
    expect(received[0]?.tool_name).toBe('Bash');
  });

  it('dispatches PostToolUseFailure events', async () => {
    const received: PostToolUseFailureHookInput[] = [];
    server = new HookServer({ port }, { onPostToolUseFailure: (input) => received.push(input) });
    server.start();

    const res = await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        makePayload({
          hook_event_name: 'PostToolUseFailure',
          tool_name: 'Bash',
          tool_input: {},
          error: 'command not found',
        }),
      ),
    });
    expect(res.status).toBe(200);
    expect(received.length).toBe(1);
    expect(received[0]?.error).toBe('command not found');
  });

  it('dispatches SubagentStart events', async () => {
    const received: SubagentStartHookInput[] = [];
    server = new HookServer({ port }, { onSubagentStart: (input) => received.push(input) });
    server.start();

    const res = await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        makePayload({ hook_event_name: 'SubagentStart', agent_type: 'code-reviewer' }),
      ),
    });
    expect(res.status).toBe(200);
    expect(received.length).toBe(1);
    expect(received[0]?.agent_type).toBe('code-reviewer');
  });

  it('dispatches SubagentStop events', async () => {
    const received: SubagentStopHookInput[] = [];
    server = new HookServer({ port }, { onSubagentStop: (input) => received.push(input) });
    server.start();

    const res = await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        makePayload({ hook_event_name: 'SubagentStop', agent_type: 'code-reviewer' }),
      ),
    });
    expect(res.status).toBe(200);
    expect(received.length).toBe(1);
  });

  it('dispatches StopFailure events', async () => {
    const received: StopFailureHookInput[] = [];
    server = new HookServer({ port }, { onStopFailure: (input) => received.push(input) });
    server.start();

    const res = await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePayload({ hook_event_name: 'StopFailure', error_type: 'timeout' })),
    });
    expect(res.status).toBe(200);
    expect(received.length).toBe(1);
    expect(received[0]?.error_type).toBe('timeout');
  });

  it('dispatches SessionEnd events', async () => {
    const received: SessionEndHookInput[] = [];
    server = new HookServer({ port }, { onSessionEnd: (input) => received.push(input) });
    server.start();

    const res = await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePayload({ hook_event_name: 'SessionEnd', reason: 'user_exit' })),
    });
    expect(res.status).toBe(200);
    expect(received.length).toBe(1);
    expect(received[0]?.reason).toBe('user_exit');
  });

  it('dispatches medium-priority events to dynamic listeners only', async () => {
    server = new HookServer({ port });
    server.start();

    const received: unknown[] = [];
    server.on('UserPromptSubmit', (input) => received.push(input));

    const res = await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePayload({ hook_event_name: 'UserPromptSubmit' })),
    });
    expect(res.status).toBe(200);
    expect(received.length).toBe(1);
  });

  it('supports dynamic listeners via on()', async () => {
    server = new HookServer({ port });
    server.start();

    const received: PreToolUseHookInput[] = [];
    server.on('PreToolUse', (input) => received.push(input));

    await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        makePayload({
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          tool_input: {},
        }),
      ),
    });

    expect(received.length).toBe(1);
    expect(received[0]?.tool_name).toBe('Edit');
  });

  it('fires both constructor and dynamic listeners', async () => {
    const constructorReceived: PreToolUseHookInput[] = [];
    const dynamicReceived: PreToolUseHookInput[] = [];

    server = new HookServer(
      { port },
      {
        onPreToolUse: (input) => constructorReceived.push(input),
      },
    );
    server.start();
    server.on('PreToolUse', (input) => dynamicReceived.push(input));

    await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        makePayload({
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: {},
        }),
      ),
    });

    expect(constructorReceived.length).toBe(1);
    expect(dynamicReceived.length).toBe(1);
  });

  it('removeListeners clears specific event', async () => {
    server = new HookServer({ port });
    server.start();

    const received: PreToolUseHookInput[] = [];
    server.on('PreToolUse', (input) => received.push(input));
    server.removeListeners('PreToolUse');

    await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        makePayload({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: {},
        }),
      ),
    });

    expect(received.length).toBe(0);
  });

  it('exposes url property', () => {
    server = new HookServer({ port });
    expect(server.url).toBe(`http://127.0.0.1:${port}/hooks`);
  });

  // -------------------------------------------------------------------------
  // Synchronous PermissionRequest resolver (#496)
  // -------------------------------------------------------------------------
  describe('synchronous PermissionRequest decision', () => {
    async function postPermission(p: number): Promise<Response> {
      return fetch(makeUrl(p), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          makePayload({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }),
        ),
      });
    }

    it("returns hookSpecificOutput decision behavior 'allow'", async () => {
      server = new HookServer({ port });
      server.setPermissionResolver(async () => 'allow');
      server.start();
      const res = await postPermission(port);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      });
    });

    it("returns hookSpecificOutput decision behavior 'deny'", async () => {
      server = new HookServer({ port });
      server.setPermissionResolver(async () => 'deny');
      server.start();
      const res = await postPermission(port);
      expect(await res.json()).toEqual({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
      });
    });

    it("returns {} for 'passthrough' (Claude renders the prompt)", async () => {
      server = new HookServer({ port });
      server.setPermissionResolver(async () => 'passthrough');
      server.start();
      const res = await postPermission(port);
      expect(await res.json()).toEqual({});
    });

    it('falls back to {} when no resolver is installed (legacy path)', async () => {
      server = new HookServer({ port });
      server.start();
      const res = await postPermission(port);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
    });

    it('a throwing resolver fails to passthrough ({}) and reports onError', async () => {
      const errors: Error[] = [];
      server = new HookServer({ port }, { onError: (e) => errors.push(e) });
      server.setPermissionResolver(async () => {
        throw new Error('resolver boom');
      });
      server.start();
      const res = await postPermission(port);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({}); // fail to the user, never block/allow
      expect(errors.length).toBe(1);
    });

    it('only intercepts PermissionRequest; other events still dispatch + {}', async () => {
      let preToolFired = 0;
      server = new HookServer({ port }, { onPreToolUse: () => preToolFired++ });
      server.setPermissionResolver(async () => 'deny');
      server.start();
      const res = await fetch(makeUrl(port), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makePayload({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })),
      });
      expect(await res.json()).toEqual({});
      expect(preToolFired).toBe(1);
    });
  });
});
