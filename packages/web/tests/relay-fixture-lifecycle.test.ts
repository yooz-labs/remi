/** Real hub/API-created daemon + PTY + Worker teardown, including a failed test body. */
import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCreateSessionRequest, createHello } from '@remi/shared';
import { CAPABILITY_HEADER } from '../../daemon/src/auth/capability-token';
import { Mailbox } from '../../signaling/tests/e2e/endpoints';
import {
  cleanupOwnedRelayFixtures,
  ownedRelayChild,
  ownedRelayHub,
  registerOwnedRelayFixtureCleanup,
} from './helpers/relay-hub';
registerOwnedRelayFixtureCleanup();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (!alive(pid)) return true;
    await Bun.sleep(10);
  }
  return false;
}

test('owned fixture cleanup stops API-created daemons, PTY children and real Worker after body failure', async () => {
  const running = await ownedRelayHub();
  const direct = await ownedRelayChild(running);
  const registry = join(running.dir, 'state/live-sessions');
  const ws = new WebSocket(`ws://127.0.0.1:${running.port}/ws`, {
    headers: { [CAPABILITY_HEADER]: running.capability },
  } as never);
  const inbox = new Mailbox<Record<string, unknown>>();
  ws.onmessage = (event) => inbox.push(JSON.parse(String(event.data)));
  const pids = new Set<number>([running.proc.pid, direct.child.pid]);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('owned capability refused'));
    });
    ws.send(JSON.stringify(createHello('owned-lifecycle', '2')));
    for (let i = 0; i < 32; i++) if ((await inbox.next(10000))['type'] === 'hello_ack') break;
    const request = createCreateSessionRequest(running.dir);
    ws.send(JSON.stringify(request));
    let response: Record<string, unknown> | undefined;
    for (let i = 0; i < 32; i++) {
      const message = await inbox.next(10000);
      if (message['type'] === 'create_session_response' && message['requestId'] === request.id) {
        response = message;
        break;
      }
    }
    expect(response?.['success']).toBe(true);
    let entries: { pid: number; claudeChildPid: number }[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      entries = readdirSync(registry)
        .filter((name) => name.endsWith('.json'))
        .map(
          (name) =>
            JSON.parse(readFileSync(join(registry, name), 'utf8')) as {
              pid: number;
              claudeChildPid: number;
            },
        );
      if (entries.length === 2 && entries.every((entry) => Number.isInteger(entry.claudeChildPid)))
        break;
      await Bun.sleep(10);
    }
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      pids.add(entry.pid);
      pids.add(entry.claudeChildPid);
      expect(alive(entry.pid)).toBe(true);
      expect(alive(entry.claudeChildPid)).toBe(true);
    }
    // The same cleanup registered with afterEach must run when the body rejects.
    let rejected = false;
    try {
      throw new Error('owned lifecycle body failure');
    } catch {
      rejected = true;
    } finally {
      ws.close();
      await cleanupOwnedRelayFixtures();
    }
    expect(rejected).toBe(true);
    for (const pid of pids) expect(await gone(pid)).toBe(true);
    let workerReachable = false;
    try {
      await fetch(`${running.worker.url}/health`, { signal: AbortSignal.timeout(300) });
      workerReachable = true;
    } catch {
      /* disposed real Worker */
    }
    expect(workerReachable).toBe(false);
    expect(existsSync(running.dir)).toBe(false);
  } finally {
    ws.close();
    // Red-pin failures must not leave the exact private fixture PIDs behind.
    if (existsSync(registry))
      for (const name of readdirSync(registry)) {
        if (!name.endsWith('.json')) continue;
        const entry = JSON.parse(readFileSync(join(registry, name), 'utf8'));
        for (const pid of [entry.pid, entry.claudeChildPid])
          if (Number.isInteger(pid)) pids.add(pid);
      }
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGTERM');
    await cleanupOwnedRelayFixtures();
    for (const pid of pids) await gone(pid);
  }
}, 20000);

test('owned relay teardown runs in each importing test file', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'remi1199-lifecycle-files-'));
  const helper = join(import.meta.dir, 'helpers/relay-hub.ts');
  for (const name of ['first', 'second'])
    writeFileSync(
      join(dir, `${name}.test.ts`),
      `
    import { test, afterAll } from 'bun:test';
    import { existsSync, writeFileSync } from 'node:fs';
    import { ownedRelayHub, cleanupOwnedRelayFixtures, registerOwnedRelayFixtureCleanup } from ${JSON.stringify(helper)};
    registerOwnedRelayFixtureCleanup();
    let fixture;
    test(${JSON.stringify(name)}, async () => { fixture = await ownedRelayHub(); });
    afterAll(async () => {
      writeFileSync(${JSON.stringify(join(dir, `${name}.json`))}, JSON.stringify({ homeRemoved: !existsSync(fixture.dir) }));
      await cleanupOwnedRelayFixtures();
    });
  `,
    );
  const runner = Bun.spawn(
    [process.execPath, 'test', join(dir, 'first.test.ts'), join(dir, 'second.test.ts')],
    {
      cwd: join(import.meta.dir, '../../..'),
      env: { HOME: dir, PATH: '/usr/bin:/bin', E2E_BUNDLER: 'esbuild' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const output = Promise.all([
    new Response(runner.stdout).text(),
    new Response(runner.stderr).text(),
  ]);
  const timer = setTimeout(() => runner.kill('SIGTERM'), 15000);
  try {
    expect(await runner.exited).toBe(0);
    await output;
    for (const name of ['first', 'second'])
      expect(JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')).homeRemoved).toBe(true);
  } finally {
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

test('cleanup invalidates an actual hub setup awaiting Worker readiness', async () => {
  const initial = await ownedRelayHub();
  const prototype = Object.getPrototypeOf(initial.worker.mf) as object;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'ready');
  if (!descriptor?.get) throw new Error('Actual Miniflare ready getter unavailable');
  await cleanupOwnedRelayFixtures();
  let workerURL: string | undefined;
  // Observe the original real ready result; do not replace Miniflare evaluation.
  Object.defineProperty(prototype, 'ready', {
    ...descriptor,
    get(this: unknown) {
      const ready: Promise<unknown> = Promise.resolve(descriptor.get?.call(this));
      return ready.then((url) => {
        workerURL = String(url);
        return url;
      });
    },
  });
  const pending = ownedRelayHub().then(
    () => 'unexpected setup success',
    (error) => String(error.message),
  );
  try {
    await cleanupOwnedRelayFixtures();
    expect(await pending).toBe('Owned relay fixture lifetime ended');
    if (!workerURL) throw new Error('Actual late Worker ready URL missing');
    let reachable = false;
    try {
      await fetch(workerURL, { signal: AbortSignal.timeout(200) });
      reachable = true;
    } catch {
      /* late Worker was disposed before setup rejection */
    }
    expect(reachable).toBe(false);
  } finally {
    Object.defineProperty(prototype, 'ready', descriptor);
    await cleanupOwnedRelayFixtures();
  }
}, 15000);

test('real Bun assertion and timeout failures still dispose their owned fixture', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'remi1199-lifecycle-failures-'));
  const helper = join(import.meta.dir, 'helpers/relay-hub.ts');
  try {
    for (const kind of ['assertion', 'timeout']) {
      const receipt = join(dir, `${kind}.json`);
      const file = join(dir, `${kind}.test.ts`);
      writeFileSync(
        file,
        `
        import { test, beforeAll, afterAll, expect } from 'bun:test';
        import { existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
        import { join } from 'node:path';
        import { ownedRelayHub, ownedRelayChild, cleanupOwnedRelayFixtures, registerOwnedRelayFixtureCleanup } from ${JSON.stringify(helper)};
        registerOwnedRelayFixtureCleanup();
        let fixture; let pids = [];
        beforeAll(async () => {
          fixture = await ownedRelayHub();
          const child = await ownedRelayChild(fixture);
          const live = join(fixture.dir, 'state/live-sessions');
          const entry = JSON.parse(readFileSync(join(live, readdirSync(live)[0]), 'utf8'));
          pids = [fixture.proc.pid, child.child.pid, entry.claudeChildPid];
        }, 15000);
        test('owned ${kind}', async () => {
          ${kind === 'timeout' ? 'await new Promise(() => {});' : 'expect(false).toBe(true);'}
        }, 1500);
        afterAll(async () => {
          if (!fixture) { writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ setupFailed: true })); await cleanupOwnedRelayFixtures(); return; }
          let workerClosed = false;
          try { await fetch(fixture.worker.url, { signal: AbortSignal.timeout(200) }); }
          catch { workerClosed = true; }
          const gone = pids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } });
          writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ homeRemoved: !existsSync(fixture.dir), workerClosed, gone }));
          await cleanupOwnedRelayFixtures();
        });
      `,
      );
      const runner = Bun.spawn([process.execPath, 'test', file], {
        cwd: join(import.meta.dir, '../../..'),
        env: { HOME: dir, PATH: '/usr/bin:/bin', E2E_BUNDLER: 'esbuild' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = Promise.all([
        new Response(runner.stdout).text(),
        new Response(runner.stderr).text(),
      ]);
      const timer = setTimeout(() => runner.kill('SIGTERM'), 20000);
      try {
        expect(await runner.exited).toBe(1);
        await output;
        expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({
          homeRemoved: true,
          workerClosed: true,
          gone: true,
        });
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 45000);

(process.getuid?.() === 0 ? test.skip : test)(
  'daemon teardown error still disposes Worker and retains ownership for retry',
  async () => {
    const { chmodSync } = await import('node:fs');
    const running = await ownedRelayHub();
    const child = await ownedRelayChild(running);
    const registry = join(running.dir, 'state/live-sessions');
    const entries = readdirSync(registry).map((name) =>
      JSON.parse(readFileSync(join(registry, name), 'utf8')),
    );
    const pids = [running.proc.pid, child.child.pid, entries[0].claudeChildPid];
    try {
      chmodSync(registry, 0);
      await expect(cleanupOwnedRelayFixtures()).rejects.toThrow(
        'Owned relay fixture cleanup failed',
      );
      let workerClosed = false;
      try {
        await fetch(running.worker.url, { signal: AbortSignal.timeout(200) });
      } catch {
        workerClosed = true;
      }
      expect(workerClosed).toBe(true);
      chmodSync(registry, 0o700);
      await cleanupOwnedRelayFixtures();
      for (const pid of pids) expect(await gone(pid)).toBe(true);
      expect(existsSync(running.dir)).toBe(false);
    } finally {
      if (existsSync(registry)) chmodSync(registry, 0o700);
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGTERM');
      await cleanupOwnedRelayFixtures();
      for (const pid of pids) await gone(pid);
    }
  },
  15000,
);
