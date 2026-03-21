import { afterEach, describe, expect, test } from 'bun:test';
import { HookServer } from '../../src/hooks/hook-server.ts';

describe('HookServer with port 0 (OS-assigned)', () => {
  let server: HookServer | null = null;

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
  });

  test('starts on OS-assigned port', () => {
    server = new HookServer({ port: 0 });
    server.start();
    expect(server.port).toBeGreaterThan(0);
  });

  test('url contains the actual assigned port', () => {
    server = new HookServer({ port: 0 });
    server.start();
    expect(server.url).toContain(String(server.port));
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks$/);
  });

  test('two servers get different ports', () => {
    server = new HookServer({ port: 0 });
    server.start();
    const port1 = server.port;

    const server2 = new HookServer({ port: 0 });
    server2.start();
    const port2 = server2.port;

    expect(port1).not.toBe(port2);
    server2.stop();
  });

  test('accepts hook events on OS-assigned port', async () => {
    const events: string[] = [];
    server = new HookServer(
      { port: 0 },
      {
        onStop: () => events.push('stop'),
      },
    );
    server.start();

    const res = await fetch(`http://127.0.0.1:${server.port}/hooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'test-session',
        transcript_path: '/tmp/test.jsonl',
        cwd: '/tmp',
        permission_mode: 'default',
      }),
    });
    expect(res.status).toBe(200);
    expect(events).toContain('stop');
  });
});
