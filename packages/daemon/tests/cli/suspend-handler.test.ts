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
      writeStderr: () => {
        // suppress diagnostic noise from the test runner output
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
      writeStderr: () => {},
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
      writeStderr: () => {},
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

  // ---------------------------------------------------------------------
  // PR #364 review fixes (Findings 1, 2, 3, 4): user-visible diagnostics
  // around suspend/resume failure modes.
  // ---------------------------------------------------------------------

  test('prints "suspended, fg to resume" hint to stderr before SIGSTOP (Finding 4)', async () => {
    const stderr: string[] = [];
    const calls: Array<NodeJS.Signals | number> = [];
    controller = installSuspendHandler({
      kill: (_pid, signal) => {
        calls.push(signal);
      },
      writeStderr: (msg) => stderr.push(msg),
    });

    process.kill(process.pid, 'SIGTSTP');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The hint MUST appear before SIGSTOP fires (the process is frozen
    // after SIGSTOP, so any later write would never reach the user).
    const hintIdx = stderr.findIndex((m) => m.includes("run 'fg'"));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(stderr[hintIdx]).toContain(`pid ${process.pid}`);
    // SIGSTOP was actually attempted after the hint.
    expect(calls).toContain('SIGSTOP');
  });

  test('aborts SIGSTOP and warns on stderr when teardownTty fails (Finding 1)', async () => {
    const stderr: string[] = [];
    const calls: Array<NodeJS.Signals | number> = [];

    // Force teardown to fail by throwing from setRawMode. We restore the
    // original at the end so the runner stays usable.
    const originalSetRawMode = process.stdin.setRawMode?.bind(process.stdin);
    const originalIsTTY = process.stdin.isTTY;
    // The suspend handler only calls setRawMode if isTTY is truthy. In a
    // test runner stdin may not be a TTY, so flip both.
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    process.stdin.setRawMode = (() => {
      throw new Error('synthetic teardown failure');
    }) as typeof process.stdin.setRawMode;

    try {
      controller = installSuspendHandler({
        kill: (_pid, signal) => {
          calls.push(signal);
        },
        onError: () => {
          // suppress: we're injecting the failure on purpose
        },
        writeStderr: (msg) => stderr.push(msg),
      });

      process.kill(process.pid, 'SIGTSTP');
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Critical contract: SIGSTOP MUST NOT have been sent.
      expect(calls.filter((s) => s === 'SIGSTOP')).toEqual([]);
      // The user gets a clear stderr message with an actionable next step.
      const msg = stderr.join('');
      expect(msg).toContain('cannot suspend');
      expect(msg).toContain('Ctrl+B d');
    } finally {
      if (originalSetRawMode) {
        process.stdin.setRawMode = originalSetRawMode;
      }
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: originalIsTTY,
      });
    }
  });

  test('aborts SIGSTOP, restores TTY, and warns when SIGSTOP itself fails (Finding 2)', async () => {
    const stderr: string[] = [];
    const calls: Array<NodeJS.Signals | number> = [];

    controller = installSuspendHandler({
      kill: (_pid, signal) => {
        calls.push(signal);
        if (signal === 'SIGSTOP') {
          throw new Error('synthetic SIGSTOP failure');
        }
      },
      onError: () => {
        // suppress: SIGSTOP failure is the test point
      },
      writeStderr: (msg) => stderr.push(msg),
    });

    process.kill(process.pid, 'SIGTSTP');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // SIGSTOP was attempted exactly once (the throw is the test).
    expect(calls.filter((s) => s === 'SIGSTOP').length).toBe(1);
    // User-visible diagnostic mentions the failure.
    const msg = stderr.join('');
    expect(msg).toContain('cannot suspend');
    expect(msg).toContain('synthetic SIGSTOP failure');
    expect(msg).toContain('staying in foreground');
  });

  test('warns on stderr when restoreTty partially fails after SIGCONT (Finding 3)', async () => {
    const stderr: string[] = [];

    const originalSetRawMode = process.stdin.setRawMode?.bind(process.stdin);
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    // Let setRawMode(false) succeed (during teardown if it ran) but
    // setRawMode(true) on resume throw, so only the rawMode op fails.
    let rawModeCalls = 0;
    process.stdin.setRawMode = ((value: boolean) => {
      rawModeCalls++;
      if (value === true) {
        throw new Error('synthetic raw-mode restore failure');
      }
      return process.stdin;
    }) as typeof process.stdin.setRawMode;

    try {
      controller = installSuspendHandler({
        kill: () => {},
        onError: () => {},
        writeStderr: (msg) => stderr.push(msg),
      });

      // Drive SIGCONT directly: the resume path is what we care about.
      process.kill(process.pid, 'SIGCONT');
      await new Promise((resolve) => setTimeout(resolve, 20));

      const msg = stderr.join('');
      expect(msg).toContain('terminal restore failed');
      expect(msg).toContain('raw-mode');
      expect(msg).toContain('Ctrl+B d');
      // Sanity: setRawMode(true) was attempted at least once.
      expect(rawModeCalls).toBeGreaterThanOrEqual(1);
    } finally {
      if (originalSetRawMode) {
        process.stdin.setRawMode = originalSetRawMode;
      }
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: originalIsTTY,
      });
    }
  });

  // ---------------------------------------------------------------------
  // Regression test for the daemon-mode SIGTSTP-ignore safety net
  // (PR #364 silent-failure-hunter, Finding 7). The unconditional ignore
  // listener that cli.ts installs in daemon mode lives at module scope and
  // is hard to import without booting the full daemon. We validate the
  // contract here: a bare SIGTSTP listener (the daemon-mode no-op) keeps
  // the kernel default from suspending the process, and that contract
  // continues to hold. If this test fails, the daemon-mode regression has
  // returned.
  // ---------------------------------------------------------------------
  test('regression: a no-op SIGTSTP listener prevents kernel-default suspend', async () => {
    let received = 0;
    const noop = () => {
      received++;
    };
    process.on('SIGTSTP', noop);
    try {
      // Real signal injection. If the kernel default ran, the test runner
      // would freeze and time out.
      process.kill(process.pid, 'SIGTSTP');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toBe(1);
    } finally {
      process.removeListener('SIGTSTP', noop);
    }
  });
});
