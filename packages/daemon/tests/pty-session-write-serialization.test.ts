/**
 * Real-PTY regression test for the write-serialization queue added in
 * pty-session.ts (#795).
 *
 * Removing the session's exclusive write lock means any attached connection
 * can call `submitInput()` concurrently now, not just one. `submitInput()`
 * writes its text, waits ~50ms, then writes a trailing CR -- if two calls
 * interleave in that gap, one connection's text can land in the middle of
 * another's, corrupting both. This exact race (`390898b` allowed concurrent
 * writers without a queue; `588afde` reverted it for "queued resize/answer/
 * input would race the active client's session") is why `PTYSession` now
 * serializes every write through a per-session queue.
 *
 * This spawns a REAL PTY (no mocks) and relies on the terminal's own ECHO
 * (canonical mode, on by default) to observe the raw bytes as they actually
 * landed: every write we make echoes back verbatim. If two concurrent
 * `submitInput()` calls interleaved, at least one of the two full strings
 * would no longer appear as a contiguous, uncorrupted run in the output.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { PTYSession } from '../src/pty/pty-session.ts';

describe('PTYSession write serialization (#795)', () => {
  let session: PTYSession;

  afterEach(async () => {
    try {
      await session?.close(2000);
    } catch {
      // Session may have already exited
    }
  });

  test('concurrent submitInput calls do not interleave text/CR bytes', async () => {
    let output = '';
    session = new PTYSession(
      { command: '/bin/cat', args: [] },
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

    // Two distinct, easily-searched-for strings, submitted CONCURRENTLY --
    // exactly the scenario the exclusive lock used to prevent entirely.
    const textA = 'AAAAAAAAAAAAAAAAAAAA'; // 20 chars
    const textB = 'BBBBBBBBBBBBBBBBBBBB'; // 20 chars

    await Promise.all([session.submitInput(textA), session.submitInput(textB)]);

    // Let the PTY's echo (and cat's own stdin->stdout copy) settle.
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Each full string must appear intact. cat echoes/copies every write it
    // receives, so an uncorrupted run produces the pattern twice (raw tty
    // echo + cat's own forwarded copy); if the writes interleaved, at least
    // one of the two full 20-char runs would be broken up by the other
    // connection's bytes and this count would drop.
    const countOf = (needle: string): number => output.split(needle).length - 1;
    expect(countOf(textA)).toBeGreaterThanOrEqual(2);
    expect(countOf(textB)).toBeGreaterThanOrEqual(2);

    // And each submit's CR immediately follows its own text with nothing
    // from the other submit spliced in between -- the direct serialization
    // guarantee, not just "the text happened to survive".
    expect(output).toContain(`${textA}\r`);
    expect(output).toContain(`${textB}\r`);
  });

  test('a raw write() does not land inside an in-flight submitInput sequence', async () => {
    let output = '';
    session = new PTYSession(
      { command: '/bin/cat', args: [] },
      {
        onData: (data) => {
          output += data;
        },
      },
    );
    await session.start();

    const text = 'SUBMITSUBMITSUBMITSU'; // 21 chars, no 'X' in it
    await Promise.all([
      session.submitInput(text),
      // A concurrent single-shot write from a different connection (e.g. a
      // raw keystroke), racing the 50ms gap between submitInput's text and
      // its CR.
      session.write('X'),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 400));

    // The submit's text must not have an 'X' spliced into the middle of it.
    expect(output).toContain(`${text}\r`);
  });
});
