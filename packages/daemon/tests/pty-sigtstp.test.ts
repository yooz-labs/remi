/**
 * Tests for Ctrl+Z (SIGTSTP) handling in PTY sessions.
 *
 * Verifies that:
 * 1. The \x1a byte (Ctrl+Z) can be written to the PTY without crashing
 * 2. The PTY session stays alive after receiving \x1a
 * 3. The daemon process ignores SIGTSTP
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { PTYSession } from '../src/pty/pty-session';

describe('PTY SIGTSTP handling', () => {
  let session: PTYSession;

  afterEach(async () => {
    try {
      await session?.close(2000);
    } catch {
      // Session may have already exited
    }
  });

  test('writing \\x1a to PTY does not crash the session', async () => {
    // Spawn a simple shell that will receive the Ctrl+Z byte
    session = new PTYSession(
      { command: '/bin/cat', args: [] },
      {
        onError: (err) => {
          // Log but don't fail -- we just want to verify no crash
          console.error('[PTY error]', err.message);
        },
      },
    );
    await session.start();
    expect(session.isRunning).toBe(true);

    // Write Ctrl+Z byte to the PTY
    session.write('\x1a');

    // Small delay to let the PTY process the byte
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Session should still be running -- \x1a is just a byte in the PTY stream
    expect(session.isRunning).toBe(true);
  });

  test('PTY session survives \\x1a followed by normal input', async () => {
    let output = '';
    session = new PTYSession(
      { command: '/bin/sh', args: ['-c', 'cat'] },
      {
        onData: (data) => {
          output += data;
        },
        onError: (err) => {
          console.error('[PTY error]', err.message);
        },
      },
    );
    await session.start();
    expect(session.isRunning).toBe(true);

    // Send Ctrl+Z then normal text
    session.write('\x1a');
    await new Promise((resolve) => setTimeout(resolve, 50));

    session.write('hello\r');
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Session should still be alive
    expect(session.isRunning).toBe(true);

    // The output should contain "hello" (cat echoes input)
    expect(output).toContain('hello');
  });

  test('daemon process ignores SIGTSTP without suspending', async () => {
    // A bare SIGTSTP listener is enough to suppress the kernel default. The
    // wrapper-mode handler is in `cli/suspend-handler.ts`; this test only
    // verifies the underlying runtime contract that the suspend handler
    // depends on.
    const received = new Promise<void>((resolve) => {
      const handler = () => {
        process.removeListener('SIGTSTP', handler);
        resolve();
      };
      process.on('SIGTSTP', handler);
    });

    // Send SIGTSTP to ourselves -- should not suspend the process
    process.kill(process.pid, 'SIGTSTP');

    // Wait for the signal to be delivered (async on some platforms)
    await received;

    // If we reach here, the process was not suspended -- it handled the signal
    expect(process.exitCode).toBeUndefined();
  });
});
