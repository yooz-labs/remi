import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { HookServer } from '../../src/hooks/hook-server.ts';
import type {
  NotificationHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SessionStartHookInput,
  StopHookInput,
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

  it('returns 400 for unknown event names', async () => {
    server = new HookServer({ port });
    server.start();

    const res = await fetch(makeUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePayload({ hook_event_name: 'UnknownEvent' })),
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
});
