/**
 * Which stored row a resume starts from when the person names a Claude session id (#1129, #1308
 * review). Every resume adds a row for the same Claude session, so after a resume has ended twice
 * there are several exited rows for one id; `findByClaudeSessionId` refuses to choose among them
 * (right for its other callers), and a resume must not dead-end on that. Real store on a temp file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { AmbiguousSessionIdentityError, SessionStore } from '../../src/session/session-store.ts';

const CLAUDE_ID = '3f9c2a1e-0000-4000-8000-000000000042';

describe('findResumableByClaudeSessionId (#1129)', () => {
  let dir: string;
  let filePath: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-resumable-'));
    filePath = path.join(dir, 'sessions.json');
    store = new SessionStore(filePath);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    remiSessionId: crypto.randomUUID(),
    claudeSessionId: CLAUDE_ID,
    projectPath: '/tmp/project',
    port: 18765,
    pid: null,
    startedAt: '2026-10-01T00:00:00.000Z',
    exitedAt: '2026-10-01T01:00:00.000Z',
    exitCode: 0,
    ...over,
  });
  const write = (rows: Array<Record<string, unknown>>) =>
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, sessions: rows }));

  test('no row, no answer', () => {
    write([]);
    expect(store.findResumableByClaudeSessionId(CLAUDE_ID)).toBeNull();
  });

  test('several exited rows of one session: the newest names where it last ran', () => {
    const newest = row({ startedAt: '2026-10-03T00:00:00.000Z', projectPath: '/tmp/newest' });
    write([
      row({ startedAt: '2026-10-01T00:00:00.000Z', projectPath: '/tmp/oldest' }),
      newest,
      row({ startedAt: '2026-10-02T00:00:00.000Z', projectPath: '/tmp/middle' }),
    ]);

    expect(store.findResumableByClaudeSessionId(CLAUDE_ID)?.remiSessionId).toBe(
      newest['remiSessionId'] as string,
    );
    // The row-by-row lookup other callers use still refuses to choose.
    expect(() => store.findByClaudeSessionId(CLAUDE_ID)).toThrow(AmbiguousSessionIdentityError);
  });

  test('one live row beside exited ones: the live one, so the held check can refuse it', () => {
    const live = row({ exitedAt: null, exitCode: null, pid: process.pid });
    write([row(), live, row({ startedAt: '2026-10-02T00:00:00.000Z' })]);

    expect(store.findResumableByClaudeSessionId(CLAUDE_ID)?.remiSessionId).toBe(
      live['remiSessionId'] as string,
    );
  });

  test('two live rows are still an ambiguity: nothing is chosen', () => {
    write([
      row({ exitedAt: null, exitCode: null, pid: process.pid }),
      row({ exitedAt: null, exitCode: null, pid: process.pid }),
    ]);

    expect(() => store.findResumableByClaudeSessionId(CLAUDE_ID)).toThrow(
      AmbiguousSessionIdentityError,
    );
  });

  test("another harness's row never answers to a Claude id", () => {
    write([row({ harness: 'codex', harnessSessionId: '01950000-0000-7000-8000-0000000000aa' })]);
    expect(store.findResumableByClaudeSessionId(CLAUDE_ID)).toBeNull();
  });

  test('the binding store offers it, so the resume handler goes through the one accessor', () => {
    const newest = row({ startedAt: '2026-10-03T00:00:00.000Z' });
    write([row(), newest]);

    expect(
      new SessionBindingStore(store).getResumableByClaudeSessionId(CLAUDE_ID)?.remiSessionId,
    ).toBe(newest['remiSessionId'] as UUID);
  });
});
