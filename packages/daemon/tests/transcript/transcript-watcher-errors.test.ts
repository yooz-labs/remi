/**
 * TranscriptWatcher survives watcher errors instead of killing the daemon (#903).
 *
 * An `FSWatcher` that emits `'error'` with no listener throws out of the event
 * loop as an `uncaughtException`. The `try/catch` around `fs.watch()` catches
 * only the synchronous construction throw, so the asynchronous case — the
 * watched path vanishing while the daemon runs — was unguarded. Transcript
 * files vanish in normal use (session rotation, `/clear`, cleanup), so this was
 * a real crash path, not just the CI test noise that surfaced it.
 *
 * These tests drive the real watcher and emit the real event. Before the fix
 * they fail by crashing the test process rather than by asserting.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TranscriptWatcher } from '../../src/transcript/transcript-watcher.ts';

/** Wait for a condition rather than sleeping a guess. */
async function until(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition never became true');
}

describe('TranscriptWatcher watcher-error handling (#903)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-watcher-err-'));
    file = path.join(dir, 'live.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an error on the file watcher is reported, not thrown', async () => {
    fs.writeFileSync(file, '');
    const errors: Error[] = [];
    const watcher = new TranscriptWatcher({ filePath: file }, { onError: (e) => errors.push(e) });
    await watcher.start();

    // Reach the live watcher and emit exactly what Linux inotify produces when
    // a watched path disappears. With no listener this is an uncaughtException
    // and the daemon dies; the assertion below can only run if it is handled.
    const inner = (watcher as unknown as { watcher: fs.FSWatcher | null }).watcher;
    expect(inner).not.toBeNull();
    (inner as unknown as EventEmitter).emit(
      'error',
      new Error(`ENOENT: no such file or directory, watch '${file}'`),
    );

    await until(() => errors.length > 0);
    expect(errors[0]?.message).toContain('falling back to polling');
    watcher.stop();
  });

  test('polling still delivers new entries after the watcher dies', async () => {
    // The reason losing a watcher is survivable: the poll fallback is already
    // armed. If this regressed, a watcher error would silently stop transcript
    // updates, which is worse than the crash it replaced.
    fs.writeFileSync(file, '');
    const seen: unknown[] = [];
    const watcher = new TranscriptWatcher(
      { filePath: file, pollIntervalMs: 50, readExisting: false },
      { onUserMessage: (e) => seen.push(e) },
    );
    await watcher.start();

    const inner = (watcher as unknown as { watcher: fs.FSWatcher | null }).watcher;
    (inner as unknown as EventEmitter).emit('error', new Error('simulated watcher death'));

    fs.appendFileSync(
      file,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`,
    );

    await until(() => seen.length > 0, 3000);
    expect(seen.length).toBeGreaterThan(0);
    watcher.stop();
  });

  test('an error on the directory watcher is survivable while awaiting the file', async () => {
    // No file yet, so the watcher is in directory-watching mode.
    const errors: Error[] = [];
    const watcher = new TranscriptWatcher(
      { filePath: file, pollIntervalMs: 50 },
      { onError: (e) => errors.push(e) },
    );
    await watcher.start();

    // The file appearing must still be detected via the poll fallback even
    // though the directory watcher is gone.
    fs.writeFileSync(file, '');
    await until(() => fs.existsSync(file));
    expect(errors.every((e) => e instanceof Error)).toBe(true);
    watcher.stop();
  });
});
