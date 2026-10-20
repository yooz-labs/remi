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

  test('guarded insertion writes literal reference text with no Enter', async () => {
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
    const reference = ' @"/private/space directory/owned-image" ';
    let checks = 0;
    expect(
      await session.insertText(reference, () => {
        checks++;
        return true;
      }),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Canonical cat echoes the input, but cannot copy a line until a newline.
    expect(output).toBe(reference);
    expect(checks).toBe(1);
    expect(output).not.toMatch(/[\r\n]/u);
  });

  test('insertion rechecks its guard after a real queued submit', async () => {
    let output = '';
    let valid = true;
    session = new PTYSession(
      { command: '/bin/cat', args: [] },
      {
        onData: (data) => {
          output += data;
        },
      },
    );
    await session.start();
    const first = session.submitInput('EARLIER', (phase) => {
      if (phase === 'text') valid = false;
      return true;
    });
    const inserted = session.insertText('MUST_NOT_INSERT', () => valid);
    await first;
    expect(await inserted).toBe(false);
    await session.write('RAW_STILL_WORKS');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(output).toContain('EARLIER\r');
    expect(output).not.toContain('MUST_NOT_INSERT');
    expect(output).toContain('RAW_STILL_WORKS');
  });

  test('insertion never interrupts an earlier text-to-Enter sequence', async () => {
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
    const first = session.submitInput('SUBMITTED');
    const insertion = session.insertText('INSERTED', () => true);
    await first;
    expect(await insertion).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(output).toContain('SUBMITTED\r');
    expect(output).not.toContain('SUBMITTEDINSERTED');
    // cat's copy of the earlier line can arrive after the insertion's echo.
    expect(output.split('INSERTED')).toHaveLength(2);
  });

  test('a throwing insertion guard writes nothing and leaves the queue usable', async () => {
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
    await expect(
      session.insertText('MUST_NOT_INSERT', () => {
        throw new Error('Authority unavailable');
      }),
    ).rejects.toThrow('Authority unavailable');
    await session.write('HEALTHY');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(output).toBe('HEALTHY');
  });

  test('insertion rejects controls and an exited terminal before writing', async () => {
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
    for (const value of ['', 'path\r', 'path\n', 'path\t', '\x1b[200~path', '\x7f', '\x85']) {
      expect(() => session.insertText(value, () => true)).toThrow('Insertion requires');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(output).toBe('');
    await session.close(2000);
    expect(() => session.insertText('AFTER_EXIT', () => true)).toThrow('Cannot write');
  });
});
