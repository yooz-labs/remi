/**
 * Tests for the wrapper-mode SIGTSTP / SIGCONT handler (issue #361).
 *
 * The handler self-sends SIGSTOP to actually suspend the process. We
 * cannot let SIGSTOP fire inside the test runner (it would hang the
 * suite), so the test injects a `kill` seam that records the signals
 * that would be sent. This is a real seam, not a mock -- the production
 * binary uses the default `process.kill`.
 *
 * SIGCONT path: we deliver a real SIGCONT to ourselves and assert that
 * the listener runs and `onResume` fires.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  type SuspendHandlerController,
  installSuspendHandler,
} from '../../src/cli/suspend-handler';

describe('installSuspendHandler', () => {
  let controller: SuspendHandlerController | null = null;

  afterEach(() => {
    controller?.dispose();
    controller = null;
  });

  test('requestSuspend forwards SIGTSTP to process.kill', () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    controller = installSuspendHandler({
      kill: (pid, signal) => {
        calls.push({ pid, signal });
      },
    });

    controller.requestSuspend();
    expect(calls).toEqual([{ pid: process.pid, signal: 'SIGTSTP' }]);
  });

  test('SIGTSTP listener teardown sends SIGSTOP via kill seam', async () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    controller = installSuspendHandler({
      kill: (pid, signal) => {
        calls.push({ pid, signal });
      },
    });

    // requestSuspend() invokes our kill seam with SIGTSTP. Because the seam
    // does not actually deliver the signal, we have to fire SIGTSTP for real
    // to exercise the listener. Our installed listener will then call the
    // seam with SIGSTOP, which is also intercepted (so the runner survives).
    process.kill(process.pid, 'SIGTSTP');
    // Signal delivery is async in Bun; yield once.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stopCalls = calls.filter((c) => c.signal === 'SIGSTOP');
    expect(stopCalls.length).toBe(1);
    expect(stopCalls[0]?.pid).toBe(process.pid);
  });

  test('SIGCONT triggers onResume callback', async () => {
    let resumed = 0;
    controller = installSuspendHandler({
      kill: () => {
        // swallow signal sends so the test runner survives
      },
      onResume: () => {
        resumed++;
      },
    });

    process.kill(process.pid, 'SIGCONT');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(resumed).toBe(1);
  });

  test('dispose removes both signal listeners', async () => {
    let resumed = 0;
    controller = installSuspendHandler({
      kill: () => {},
      onResume: () => {
        resumed++;
      },
    });
    controller.dispose();
    controller = null;

    // After dispose, our listener should not run for SIGCONT.
    process.kill(process.pid, 'SIGCONT');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(resumed).toBe(0);
  });

  test('re-entrant SIGTSTP only triggers one SIGSTOP before resume', async () => {
    const calls: Array<NodeJS.Signals | number> = [];
    controller = installSuspendHandler({
      kill: (_pid, signal) => {
        calls.push(signal);
      },
    });

    process.kill(process.pid, 'SIGTSTP');
    process.kill(process.pid, 'SIGTSTP');
    await new Promise((resolve) => setTimeout(resolve, 30));

    const stopCount = calls.filter((s) => s === 'SIGSTOP').length;
    expect(stopCount).toBe(1);
  });

  test('after SIGCONT, a second SIGTSTP fires SIGSTOP again', async () => {
    const calls: Array<NodeJS.Signals | number> = [];
    controller = installSuspendHandler({
      kill: (_pid, signal) => {
        calls.push(signal);
      },
    });

    process.kill(process.pid, 'SIGTSTP');
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.kill(process.pid, 'SIGCONT');
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.kill(process.pid, 'SIGTSTP');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stopCount = calls.filter((s) => s === 'SIGSTOP').length;
    expect(stopCount).toBe(2);
  });
});
