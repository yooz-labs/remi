/**
 * Writing and finding a non-Claude harness identity (epic #1175, phase 2
 * #1176): `SessionStore.updateHarnessIdentity`, `findByHarnessSessionId`, the
 * uniqueness rule for an active non-Claude pair, and the binding store's
 * `updateHarnessIdentity` and `preAssign` log. Real stores on temp files, no
 * stand-ins.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import {
  AmbiguousSessionIdentityError,
  SessionStore,
  type StoredSession,
} from '../../src/session/session-store.ts';
import { TranscriptIndex } from '../../src/session/transcript-index.ts';

const THREAD_A = '00000000-0000-7000-8000-00000000000a';
const THREAD_B = '00000000-0000-7000-8000-00000000000b';

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    remiSessionId: crypto.randomUUID() as UUID,
    claudeSessionId: null,
    projectPath: '/tmp/project',
    port: 18765,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    exitedAt: null,
    exitCode: null,
    ...overrides,
  };
}

/** A Codex record the way a launch creates it: naming its harness, no id yet. */
function codexRecord(overrides: Partial<StoredSession> = {}): StoredSession {
  return makeSession({ harness: 'codex', harnessSessionId: null, ...overrides });
}

describe('harness identity in the session store (#1176)', () => {
  let dir: string;
  let filePath: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-harness-identity-'));
    filePath = path.join(dir, 'sessions.json');
    store = new SessionStore(filePath);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function disk(): Array<Record<string, unknown>> {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')).sessions;
  }

  describe('updateHarnessIdentity', () => {
    test('fills in the id of a record that names its harness, and persists it', () => {
      const session = codexRecord();
      store.save(session);

      const updated = store.updateHarnessIdentity(session.remiSessionId, 'codex', THREAD_A);

      expect(updated).toMatchObject({ harness: 'codex', harnessSessionId: THREAD_A });
      expect(store.findByRemiSessionId(session.remiSessionId)).toMatchObject({
        harness: 'codex',
        harnessSessionId: THREAD_A,
      });
      expect(disk()[0]).toMatchObject({ harness: 'codex', harnessSessionId: THREAD_A });
    });

    test('a rotation replaces the stored id', () => {
      const session = codexRecord({ harnessSessionId: THREAD_A });
      store.save(session);

      store.updateHarnessIdentity(session.remiSessionId, 'codex', THREAD_B);

      expect(store.findByRemiSessionId(session.remiSessionId)?.harnessSessionId).toBe(THREAD_B);
    });

    test('returns null and writes nothing when the record is absent', () => {
      store.save(codexRecord());
      const before = fs.readFileSync(filePath, 'utf-8');

      expect(
        store.updateHarnessIdentity(crypto.randomUUID() as UUID, 'codex', THREAD_A),
      ).toBeNull();

      expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
    });

    test('refuses claude: a Claude identity is claudeSessionId, never a stored pair', () => {
      const session = makeSession({ claudeSessionId: 'claude-1' });
      store.save(session);
      const before = fs.readFileSync(filePath, 'utf-8');

      expect(() =>
        // The type rules `claude` out; a JavaScript caller or a cast reaches the runtime check.
        store.updateHarnessIdentity(session.remiSessionId, 'claude' as 'codex', 'claude-1'),
      ).toThrow('does not take claude');

      expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
      expect(Object.keys(disk()[0] ?? {})).not.toContain('harness');
    });

    test('refuses to re-label a Claude record, leaving it an eight-key Claude row', () => {
      const session = makeSession({ claudeSessionId: 'claude-2' });
      store.save(session);

      expect(() => store.updateHarnessIdentity(session.remiSessionId, 'codex', THREAD_A)).toThrow(
        'belongs to harness claude, not codex',
      );

      expect(Object.keys(disk()[0] ?? {}).sort()).toEqual([
        'claudeSessionId',
        'exitCode',
        'exitedAt',
        'pid',
        'port',
        'projectPath',
        'remiSessionId',
        'startedAt',
      ]);
    });

    test('refuses an id another active record of the harness already holds, writing nothing', () => {
      store.save(codexRecord({ harnessSessionId: THREAD_A }));
      const second = codexRecord();
      store.save(second);
      const before = fs.readFileSync(filePath, 'utf-8');

      expect(() => store.updateHarnessIdentity(second.remiSessionId, 'codex', THREAD_A)).toThrow(
        AmbiguousSessionIdentityError,
      );

      expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
    });
  });

  describe('a non-Claude record is closed to the Claude id paths', () => {
    function writeRaw(sessions: Array<Record<string, unknown>>): void {
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, sessions }));
    }

    function row(overrides: Record<string, unknown>): Record<string, unknown> {
      return {
        remiSessionId: crypto.randomUUID(),
        claudeSessionId: null,
        projectPath: '/tmp/project',
        port: 18765,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exitedAt: null,
        exitCode: null,
        ...overrides,
      };
    }

    test('updateClaudeSessionId refuses a codex record and writes nothing', () => {
      const session = codexRecord({ harnessSessionId: THREAD_A });
      store.save(session);
      const before = fs.readFileSync(filePath, 'utf-8');

      expect(() => store.updateClaudeSessionId(session.remiSessionId, 'claude-x')).toThrow(
        'belongs to harness codex, not claude',
      );

      expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
      expect(store.findByRemiSessionId(session.remiSessionId)?.claudeSessionId).toBeNull();
    });

    test('updateClaudeSessionId refuses a record of a harness this build does not know', () => {
      const session = makeSession({ harness: 'from-a-newer-daemon', harnessSessionId: 'x-1' });
      store.save(session);

      expect(() => store.updateClaudeSessionId(session.remiSessionId, 'claude-x')).toThrow(
        'belongs to harness from-a-newer-daemon',
      );
    });

    test('updateClaudeSessionId still works for a Claude record, with or without harness: claude', () => {
      const plain = makeSession();
      const named = makeSession({ harness: 'claude' });
      store.save(plain);
      store.save(named);

      expect(store.updateClaudeSessionId(plain.remiSessionId, 'claude-p')?.claudeSessionId).toBe(
        'claude-p',
      );
      expect(store.updateClaudeSessionId(named.remiSessionId, 'claude-n')?.claudeSessionId).toBe(
        'claude-n',
      );
      expect(store.updateClaudeSessionId(crypto.randomUUID() as UUID, 'x')).toBeNull();
    });

    test('findByClaudeSessionId never returns a non-Claude record that carries the id', () => {
      writeRaw([
        row({ harness: 'codex', harnessSessionId: THREAD_A, claudeSessionId: 'claude-y' }),
      ]);

      expect(store.findByClaudeSessionId('claude-y')).toBeNull();
    });

    test('a non-Claude record carrying a Claude id is no ambiguity for the Claude record that owns it', () => {
      const claude = row({ claudeSessionId: 'claude-z' });
      writeRaw([
        claude,
        row({ harness: 'codex', harnessSessionId: THREAD_A, claudeSessionId: 'claude-z' }),
      ]);

      expect(store.findByClaudeSessionId('claude-z')?.remiSessionId).toBe(
        claude['remiSessionId'] as string,
      );
    });

    test('two Claude records for one Claude id are still an ambiguity', () => {
      writeRaw([
        row({ claudeSessionId: 'claude-w', exitedAt: '2026-10-01T00:00:00.000Z', exitCode: 0 }),
        row({ claudeSessionId: 'claude-w', exitedAt: '2026-10-02T00:00:00.000Z', exitCode: 0 }),
      ]);

      expect(() => store.findByClaudeSessionId('claude-w')).toThrow(AmbiguousSessionIdentityError);
    });
  });

  describe('findByHarnessSessionId', () => {
    test('matches the harness and the id together', () => {
      const codex = codexRecord({ harnessSessionId: THREAD_A });
      store.save(codex);
      store.save(codexRecord({ harnessSessionId: THREAD_B }));

      expect(store.findByHarnessSessionId('codex', THREAD_A)?.remiSessionId).toBe(
        codex.remiSessionId,
      );
      expect(store.findByHarnessSessionId('codex', 'no-such-thread')).toBeNull();
    });

    test('the same id under another harness, or as a Claude id, is not a match', () => {
      store.save(makeSession({ harness: 'opencode', harnessSessionId: THREAD_A }));
      store.save(makeSession({ claudeSessionId: THREAD_A }));

      expect(store.findByHarnessSessionId('codex', THREAD_A)).toBeNull();
    });

    test('claude looks up the claudeSessionId column', () => {
      const claude = makeSession({ claudeSessionId: 'claude-3' });
      store.save(claude);
      store.save(codexRecord({ harnessSessionId: 'claude-3' }));

      expect(store.findByHarnessSessionId('claude', 'claude-3')?.remiSessionId).toBe(
        claude.remiSessionId,
      );
    });

    test('prefers the single active owner over exited history', () => {
      const historical = codexRecord({
        harnessSessionId: THREAD_A,
        startedAt: '2026-10-01T00:00:00.000Z',
        exitedAt: '2026-10-01T01:00:00.000Z',
        exitCode: 0,
        pid: null,
      });
      const current = codexRecord({ harnessSessionId: THREAD_A });
      store.save(historical);
      store.save(current);

      expect(store.findByHarnessSessionId('codex', THREAD_A)?.remiSessionId).toBe(
        current.remiSessionId,
      );
    });

    test('several exited owners and no active one is an ambiguity, not a guess', () => {
      for (const day of ['01', '02']) {
        store.save(
          codexRecord({
            harnessSessionId: THREAD_A,
            startedAt: `2026-10-${day}T00:00:00.000Z`,
            exitedAt: `2026-10-${day}T01:00:00.000Z`,
            exitCode: 0,
            pid: null,
          }),
        );
      }

      expect(() => store.findByHarnessSessionId('codex', THREAD_A)).toThrow(
        AmbiguousSessionIdentityError,
      );
    });
  });

  describe('two active records with the same non-Claude pair', () => {
    test('are rejected on save, naming the harness, and nothing is written', () => {
      store.save(codexRecord({ harnessSessionId: THREAD_A }));
      const before = fs.readFileSync(filePath, 'utf-8');

      let error: unknown;
      try {
        store.save(codexRecord({ harnessSessionId: THREAD_A }));
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(AmbiguousSessionIdentityError);
      expect((error as AmbiguousSessionIdentityError).identity).toBe('codex');
      expect((error as AmbiguousSessionIdentityError).matchCount).toBe(2);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
    });

    test('an unknown harness string is held to the same rule', () => {
      store.save(makeSession({ harness: 'from-a-newer-daemon', harnessSessionId: 'x-1' }));
      expect(() =>
        store.save(makeSession({ harness: 'from-a-newer-daemon', harnessSessionId: 'x-1' })),
      ).toThrow(AmbiguousSessionIdentityError);
    });

    test('an exited record and an active one for the same thread are a normal resume', () => {
      store.save(
        codexRecord({
          harnessSessionId: THREAD_A,
          exitedAt: '2026-10-01T01:00:00.000Z',
          exitCode: 0,
          pid: null,
        }),
      );
      expect(() => store.save(codexRecord({ harnessSessionId: THREAD_A }))).not.toThrow();
    });

    test('different harnesses, a Claude id and a null id never collide', () => {
      store.save(codexRecord({ harnessSessionId: THREAD_A }));
      store.save(makeSession({ harness: 'opencode', harnessSessionId: THREAD_A }));
      store.save(makeSession({ claudeSessionId: THREAD_A }));
      store.save(codexRecord());
      expect(() => store.save(codexRecord())).not.toThrow();
    });
  });
});

describe('SessionBindingStore harness identity (#1176)', () => {
  let dir: string;
  let store: SessionStore;
  let logged: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-binding-identity-'));
    store = new SessionStore(path.join(dir, 'sessions.json'));
    logged = [];
    configureLogger({
      writeLog: (line) => logged.push(line),
      consoleLog: (...a) => logged.push(a.join(' ')),
    });
  });

  afterEach(() => {
    __resetLoggerForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('updateHarnessIdentity records the id, and getIdentity reads it back', () => {
    const binding = new SessionBindingStore(store);
    const session = codexRecord();
    binding.preAssign(session);
    expect(binding.getIdentity(session.remiSessionId)).toEqual({
      harness: 'codex',
      harnessSessionId: null,
    });

    binding.updateHarnessIdentity(session.remiSessionId, 'codex', THREAD_A);

    expect(binding.getIdentity(session.remiSessionId)).toEqual({
      harness: 'codex',
      harnessSessionId: THREAD_A,
    });
    // The Claude column is untouched: `get()` still reads exactly the old shape.
    expect(binding.get(session.remiSessionId)).toEqual({ claudeSessionId: null });
  });

  test('update (the Claude id writer) refuses a codex record and never seeds the transcript index', () => {
    const index = new TranscriptIndex(path.join(dir, 'transcript-index.json'));
    const binding = new SessionBindingStore(store, index);
    const session = codexRecord();
    binding.preAssign(session);

    expect(() => binding.update(session.remiSessionId, 'claude-x')).toThrow(
      'belongs to harness codex, not claude',
    );

    expect(binding.get(session.remiSessionId)).toEqual({ claudeSessionId: null });
    expect(index.get(session.remiSessionId)).toBeNull();
  });

  test('update still rotates a Claude record and refreshes the index', () => {
    const index = new TranscriptIndex(path.join(dir, 'transcript-index.json'));
    const binding = new SessionBindingStore(store, index);
    const session = makeSession({ claudeSessionId: 'claude-old' });
    binding.preAssign(session);

    binding.update(session.remiSessionId, 'claude-new');

    expect(binding.get(session.remiSessionId)).toEqual({ claudeSessionId: 'claude-new' });
    expect(index.get(session.remiSessionId)?.claudeSessionId).toBe('claude-new');
  });

  test('updateHarnessIdentity on an absent record is a no-op', () => {
    const binding = new SessionBindingStore(store);
    expect(() =>
      binding.updateHarnessIdentity(crypto.randomUUID() as UUID, 'codex', THREAD_A),
    ).not.toThrow();
    expect(store.list()).toEqual([]);
  });

  test('preAssign of a record with no id logs the deferred index seed for Claude, not for Codex', () => {
    const index = new TranscriptIndex(path.join(dir, 'transcript-index.json'));
    const binding = new SessionBindingStore(store, index);

    binding.preAssign(makeSession());
    expect(logged.filter((l) => l.includes('index seed deferred'))).toHaveLength(1);

    logged.length = 0;
    binding.preAssign(codexRecord());
    expect(logged.filter((l) => l.includes('index seed deferred'))).toEqual([]);
  });

  test('a non-Claude identity never reaches the transcript index', () => {
    const index = new TranscriptIndex(path.join(dir, 'transcript-index.json'));
    const binding = new SessionBindingStore(store, index);
    const session = codexRecord();
    binding.preAssign(session);

    binding.updateHarnessIdentity(session.remiSessionId, 'codex', THREAD_A);

    expect(index.get(session.remiSessionId)).toBeNull();
  });
});
