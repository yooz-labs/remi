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
import { installProcessGuards } from '../../src/cli/process-guards';

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
