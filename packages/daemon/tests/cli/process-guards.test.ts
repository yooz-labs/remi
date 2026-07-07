/**
 * Tests for the process-level error guards (issue #534).
 *
 * These dispatch real `unhandledRejection` / `uncaughtException` events via
 * `process.emit` -- Bun/Node deliver both synchronously to listeners, so no
 * timer is needed to observe the immediate effects. The injected `exit` seam
 * records the code instead of terminating the test runner; this is a real
 * seam (production uses `process.exit`), not a mock. Each test uninstalls
 * its listeners in `afterEach` so a stray real exception in the runner isn't
 * swallowed by a leftover handler from a previous test.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installProcessGuards } from '../../src/cli/process-guards.ts';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('installProcessGuards', () => {
  let uninstall: (() => void) | null = null;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  test('uncaughtException logs with stack, runs onFatal, then exits(1)', async () => {
    const logs: string[] = [];
    const exitCalls: number[] = [];
    let onFatalCalls = 0;

    uninstall = installProcessGuards({
      logError: (msg) => logs.push(msg),
      onFatal: async () => {
        onFatalCalls++;
      },
      exit: (code) => {
        exitCalls.push(code);
        return undefined as never;
      },
    });

    process.emit('uncaughtException', new Error('boom'));
    await wait(10);

    expect(logs.some((l) => l.includes('boom') && l.includes('.test.ts'))).toBe(true);
    expect(onFatalCalls).toBe(1);
    expect(exitCalls).toEqual([1]);
  });

  test('unhandledRejection logs but does not exit or run onFatal', async () => {
    const logs: string[] = [];
    const exitCalls: number[] = [];
    let onFatalCalls = 0;

    uninstall = installProcessGuards({
      logError: (msg) => logs.push(msg),
      onFatal: async () => {
        onFatalCalls++;
      },
      exit: (code) => {
        exitCalls.push(code);
        return undefined as never;
      },
    });

    const reason = new Error('rejected');
    const promise = Promise.reject(reason);
    process.emit('unhandledRejection', reason, promise);
    // Prevent this synthetic rejection from also being reported as a real
    // unhandled rejection by the test runner itself.
    promise.catch(() => {});
    await wait(10);

    expect(logs.some((l) => l.includes('rejected'))).toBe(true);
    expect(onFatalCalls).toBe(0);
    expect(exitCalls).toEqual([]);
  });

  test('reentrancy: a second uncaughtException skips onFatal and exits immediately', async () => {
    const exitCalls: number[] = [];
    let onFatalCalls = 0;
    const fatalControl: { resolve?: () => void } = {};

    uninstall = installProcessGuards({
      logError: () => {},
      onFatal: () =>
        new Promise<void>((resolve) => {
          onFatalCalls++;
          fatalControl.resolve = resolve;
        }),
      exit: (code) => {
        exitCalls.push(code);
        return undefined as never;
      },
    });

    process.emit('uncaughtException', new Error('first'));
    process.emit('uncaughtException', new Error('second'));

    // The reentrant path exits synchronously, without waiting on onFatal.
    expect(exitCalls).toEqual([1]);

    // The first call's onFatal is scheduled on a microtask; flush it.
    await wait(10);
    expect(onFatalCalls).toBe(1);

    // Settling the first call's onFatal afterwards must not add a second
    // exit entry -- the `exited` guard makes doExit a no-op past the first.
    fatalControl.resolve?.();
    await wait(10);
    expect(exitCalls).toEqual([1]);
  });

  test('onFatal rejecting still results in exit(1)', async () => {
    const logs: string[] = [];
    const exitCalls: number[] = [];

    uninstall = installProcessGuards({
      logError: (msg) => logs.push(msg),
      onFatal: async () => {
        throw new Error('teardown failed');
      },
      exit: (code) => {
        exitCalls.push(code);
        return undefined as never;
      },
    });

    process.emit('uncaughtException', new Error('boom'));
    await wait(10);

    expect(logs.some((l) => l.includes('teardown failed'))).toBe(true);
    expect(exitCalls).toEqual([1]);
  });

  test('slow onFatal: exit fires after fatalTimeoutMs even if onFatal never settles', async () => {
    const exitCalls: number[] = [];

    uninstall = installProcessGuards({
      logError: () => {},
      onFatal: () => new Promise(() => {}), // never settles
      exit: (code) => {
        exitCalls.push(code);
        return undefined as never;
      },
      fatalTimeoutMs: 50,
    });

    process.emit('uncaughtException', new Error('boom'));

    // Before the timeout, exit must not have fired yet.
    await wait(10);
    expect(exitCalls).toEqual([]);

    await wait(80);
    expect(exitCalls).toEqual([1]);
  });

  test('watchdog holds the event loop: hanging onFatal exits 1, not 0 (real subprocess)', async () => {
    // The in-runner tests above cannot catch a watchdog-timer lifetime bug:
    // bun:test itself keeps the process alive, so an unref'd (broken) timer
    // still fires there. This spawns a REAL bun process whose only remaining
    // event-loop work after the crash is the watchdog itself — with an
    // unref'd timer the loop drains and the process exits 0 (a "clean stop"
    // no supervisor would restart); the referenced timer must force exit 1.
    const guardsPath = path.join(import.meta.dir, '../../src/cli/process-guards.ts');
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-process-guards-'));
    const script = path.join(sandbox, 'crash.ts');
    fs.writeFileSync(
      script,
      [
        `import { installProcessGuards } from ${JSON.stringify(guardsPath)};`,
        'installProcessGuards({',
        '  logError: () => {},',
        '  onFatal: () => new Promise(() => {}), // hangs forever, holds no refs',
        '  fatalTimeoutMs: 100,',
        '});',
        "setTimeout(() => { throw new Error('kaboom'); }, 10);",
      ].join('\n'),
    );
    try {
      const proc = Bun.spawn(['bun', script], { stdout: 'ignore', stderr: 'ignore' });
      const code = await proc.exited;
      expect(code).toBe(1);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }, 15000);

  test('uninstall removes both listeners', () => {
    const before = {
      rejection: process.listenerCount('unhandledRejection'),
      exception: process.listenerCount('uncaughtException'),
    };

    const dispose = installProcessGuards({
      logError: () => {},
      onFatal: async () => {},
    });

    expect(process.listenerCount('unhandledRejection')).toBe(before.rejection + 1);
    expect(process.listenerCount('uncaughtException')).toBe(before.exception + 1);

    dispose();

    expect(process.listenerCount('unhandledRejection')).toBe(before.rejection);
    expect(process.listenerCount('uncaughtException')).toBe(before.exception);
  });
});
