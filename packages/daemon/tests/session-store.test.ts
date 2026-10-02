import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import { normalizeProjectPath } from '../src/cli/path-resolver.ts';
import {
  AmbiguousSessionIdentityError,
  MalformedSessionStoreError,
  SessionStore,
  SessionStoreLockError,
  type StoredSession,
  resolveStoredSession,
} from '../src/session/session-store.ts';

function makeTmpPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-test-'));
  return path.join(dir, 'sessions.json');
}

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

describe('SessionStore', () => {
  let filePath: string;
  let store: SessionStore;

  beforeEach(() => {
    filePath = makeTmpPath();
    store = new SessionStore(filePath);
  });

  afterEach(() => {
    try {
      fs.rmSync(path.dirname(filePath), { recursive: true });
    } catch {
      // ignore
    }
  });

  test('list returns empty array when no file exists', () => {
    expect(store.list()).toEqual([]);
  });

  test('save and list round-trips a session', () => {
    const session = makeSession();
    store.save(session);
    const sessions = store.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.remiSessionId).toBe(session.remiSessionId);
  });

  test('save updates existing session by remiSessionId', () => {
    const session = makeSession();
    store.save(session);
    const updated = { ...session, claudeSessionId: 'claude-123' };
    store.save(updated);
    const sessions = store.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.claudeSessionId).toBe('claude-123');
  });

  test('list returns most recent first', () => {
    const older = makeSession({ startedAt: '2025-01-01T00:00:00Z' });
    const newer = makeSession({ startedAt: '2025-06-01T00:00:00Z' });
    store.save(older);
    store.save(newer);
    const sessions = store.list();
    expect(sessions[0]?.remiSessionId).toBe(newer.remiSessionId);
    expect(sessions[1]?.remiSessionId).toBe(older.remiSessionId);
  });

  test('findByClaudeSessionId returns matching session', () => {
    const session = makeSession({ claudeSessionId: 'claude-abc' });
    store.save(session);
    const found = store.findByClaudeSessionId('claude-abc');
    expect(found).not.toBeNull();
    expect(found?.remiSessionId).toBe(session.remiSessionId);
  });

  test('findByClaudeSessionId returns null when not found', () => {
    expect(store.findByClaudeSessionId('nonexistent')).toBeNull();
  });

  test('findByRemiSessionId returns matching session', () => {
    const session = makeSession();
    store.save(session);
    const found = store.findByRemiSessionId(session.remiSessionId);
    expect(found).not.toBeNull();
    expect(found?.remiSessionId).toBe(session.remiSessionId);
  });

  test('getMostRecent returns latest session', () => {
    const older = makeSession({ startedAt: '2025-01-01T00:00:00Z' });
    const newer = makeSession({ startedAt: '2025-06-01T00:00:00Z' });
    store.save(older);
    store.save(newer);
    const recent = store.getMostRecent();
    expect(recent?.remiSessionId).toBe(newer.remiSessionId);
  });

  test('getMostRecent returns null when empty', () => {
    expect(store.getMostRecent()).toBeNull();
  });

  test('markExited sets exitedAt and exitCode', () => {
    const session = makeSession();
    store.save(session);
    store.markExited(session.remiSessionId, 0);
    const found = store.findByRemiSessionId(session.remiSessionId);
    expect(found?.exitedAt).not.toBeNull();
    expect(found?.exitCode).toBe(0);
  });

  test('markExited is a no-op for unknown session', () => {
    store.markExited('nonexistent' as UUID, 1);
    expect(store.list()).toEqual([]);
  });

  test('updateClaudeSessionId updates the field', () => {
    const session = makeSession();
    store.save(session);
    store.updateClaudeSessionId(session.remiSessionId, 'claude-xyz');
    const found = store.findByRemiSessionId(session.remiSessionId);
    expect(found?.claudeSessionId).toBe('claude-xyz');
  });

  test('does not overwrite corrupt JSON', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const corrupt = 'not json';
    fs.writeFileSync(filePath, corrupt, 'utf-8');
    expect(() => store.list()).toThrow(MalformedSessionStoreError);
    const session = makeSession();
    expect(() => store.save(session)).toThrow(MalformedSessionStoreError);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(corrupt);
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
  });

  test('rejects a wrong-version store instead of treating it as empty', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 99, sessions: [] }), 'utf-8');
    expect(() => store.list()).toThrow(MalformedSessionStoreError);
  });

  test('refuses to select an ambiguous Claude session ID', () => {
    const first = makeSession({ claudeSessionId: 'duplicate-claude-id' });
    const second = makeSession({ claudeSessionId: 'duplicate-claude-id' });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, sessions: [first, second] }, null, 2),
      'utf-8',
    );

    expect(() => store.findByClaudeSessionId('duplicate-claude-id')).toThrow(
      AmbiguousSessionIdentityError,
    );
  });

  test('refuses to select an ambiguous Remi session ID', () => {
    const remiSessionId = crypto.randomUUID() as UUID;
    const first = makeSession({ remiSessionId, claudeSessionId: 'claude-first' });
    const second = makeSession({ remiSessionId, claudeSessionId: 'claude-second' });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, sessions: [first, second] }, null, 2),
      'utf-8',
    );

    expect(() => store.findByRemiSessionId(remiSessionId)).toThrow(AmbiguousSessionIdentityError);
  });

  test('prefers the one active row for a resumed Claude lineage', () => {
    const claudeSessionId = 'resumed-claude-id';
    const historical = makeSession({
      claudeSessionId,
      exitedAt: new Date(Date.now() - 60_000).toISOString(),
      exitCode: 0,
    });
    const current = makeSession({ claudeSessionId });
    store.save(historical);
    store.save(current);

    expect(store.findByClaudeSessionId(claudeSessionId)?.remiSessionId).toBe(current.remiSessionId);
    expect(resolveStoredSession(store.list(), claudeSessionId)?.remiSessionId).toBe(
      current.remiSessionId,
    );
  });

  test('refuses ambiguous exact and prefix Remi resume queries', () => {
    const first = makeSession({
      remiSessionId: 'aaaaaaaa-1111-1111-1111-111111111111' as UUID,
    });
    const second = makeSession({
      remiSessionId: 'aaaaaaaa-2222-2222-2222-222222222222' as UUID,
    });

    expect(() =>
      resolveStoredSession(
        [
          { ...first, remiSessionId: 'duplicate-1111' as UUID },
          { ...second, remiSessionId: 'duplicate-1111' as UUID },
        ],
        'duplicate-1111',
      ),
    ).toThrow(AmbiguousSessionIdentityError);
    expect(() => resolveStoredSession([first, second], 'aaaaaaaa')).toThrow(
      AmbiguousSessionIdentityError,
    );
  });

  test('rejects mutations that would select or create an ambiguous identity', () => {
    const first = makeSession({ claudeSessionId: 'claude-safe' });
    const second = makeSession({ claudeSessionId: 'claude-other' });
    store.save(first);
    store.save(second);

    const beforeDuplicateClaude = fs.readFileSync(filePath, 'utf-8');
    expect(() =>
      store.save({ ...makeSession({ claudeSessionId: 'claude-safe' }), projectPath: '/tmp/next' }),
    ).toThrow(AmbiguousSessionIdentityError);
    expect(() => store.updateClaudeSessionId(second.remiSessionId, 'claude-safe')).toThrow(
      AmbiguousSessionIdentityError,
    );
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(beforeDuplicateClaude);

    const duplicateRemi = first.remiSessionId;
    const duplicateFile = {
      version: 1,
      sessions: [
        first,
        { ...second, remiSessionId: duplicateRemi, claudeSessionId: 'claude-duplicate' },
      ],
    };
    fs.writeFileSync(filePath, JSON.stringify(duplicateFile, null, 2), 'utf-8');
    const beforeDuplicateRemi = fs.readFileSync(filePath, 'utf-8');
    expect(() => store.save(makeSession())).toThrow(AmbiguousSessionIdentityError);
    expect(() => store.markExited(duplicateRemi, 1)).toThrow(AmbiguousSessionIdentityError);
    expect(() => store.updateClaudeSessionId(duplicateRemi, 'claude-new')).toThrow(
      AmbiguousSessionIdentityError,
    );
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(beforeDuplicateRemi);
  });

  test('reclaims a stale same-host lock from a dead process', () => {
    const lockPath = `${filePath}.lock`;
    const staleAt = Date.now() - 60_000;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        ownerId: 'stale-owner',
        pid: 999999,
        host: os.hostname(),
        acquiredAt: staleAt,
      }),
      'utf-8',
    );
    fs.utimesSync(lockPath, new Date(staleAt), new Date(staleAt));

    store.save(makeSession());

    expect(store.list()).toHaveLength(1);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(
      fs.readdirSync(path.dirname(filePath)).filter((name) => name.includes('.recovery-')),
    ).toEqual([]);
  });

  test('does not reclaim a live lock and preserves the store', () => {
    const lockPath = `${filePath}.lock`;
    const original = makeSession();
    store.save(original);
    const before = fs.readFileSync(filePath, 'utf-8');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        ownerId: 'live-owner',
        pid: process.pid,
        host: os.hostname(),
        acquiredAt: Date.now(),
      }),
      'utf-8',
    );

    expect(() => store.save(makeSession())).toThrow(SessionStoreLockError);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
    expect(fs.existsSync(lockPath)).toBe(true);
    fs.unlinkSync(lockPath);
  });

  test('does not reclaim malformed lock metadata or leave a lock after a store error', () => {
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(lockPath, 'not lock json', 'utf-8');

    expect(() => store.save(makeSession())).toThrow(SessionStoreLockError);
    expect(fs.existsSync(lockPath)).toBe(true);
    fs.unlinkSync(lockPath);

    const corrupt = 'still not json';
    fs.writeFileSync(filePath, corrupt, 'utf-8');
    expect(() => store.save(makeSession())).toThrow(MalformedSessionStoreError);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(corrupt);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('does not hide malformed lock metadata from list()', () => {
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(lockPath, 'not lock json', 'utf-8');

    expect(() => store.list()).toThrow(SessionStoreLockError);
    expect(fs.existsSync(lockPath)).toBe(true);
    fs.unlinkSync(lockPath);
  });

  test('trims oldest exited sessions when over limit', () => {
    // Create a store that uses the default MAX_SESSIONS (100)
    // We test with a smaller set by filling 101 sessions
    // Use recent dates so purgeStale doesn't remove them as old
    const now = Date.now();
    const sessions: StoredSession[] = [];
    for (let i = 0; i < 101; i++) {
      const s = makeSession({
        startedAt: new Date(now - (101 - i) * 60_000).toISOString(),
        exitedAt: i < 50 ? new Date(now - (100 - i) * 60_000).toISOString() : null,
        exitCode: i < 50 ? 0 : null,
      });
      sessions.push(s);
    }
    for (const s of sessions) {
      store.save(s);
    }
    const result = store.list();
    expect(result.length).toBe(100);
  });

  test('purgeStale marks sessions with dead PIDs as exited', () => {
    // PID 999999 is almost certainly not running
    const stale = makeSession({ pid: 999999 });
    store.save(stale);
    const changed = store.purgeStale();
    expect(changed).toBe(true);
    const found = store.findByRemiSessionId(stale.remiSessionId);
    expect(found?.exitedAt).not.toBeNull();
    expect(found?.exitCode).toBeNull();
  });

  test('purgeStale marks sessions with null PID (legacy) as exited', () => {
    const legacy = makeSession({ pid: null });
    store.save(legacy);
    const changed = store.purgeStale();
    expect(changed).toBe(true);
    const found = store.findByRemiSessionId(legacy.remiSessionId);
    expect(found?.exitedAt).not.toBeNull();
  });

  test('purgeStale does not touch sessions with alive PIDs', () => {
    // process.pid is always alive
    const alive = makeSession({ pid: process.pid });
    store.save(alive);
    const changed = store.purgeStale();
    expect(changed).toBe(false);
    const found = store.findByRemiSessionId(alive.remiSessionId);
    expect(found?.exitedAt).toBeNull();
  });

  test('purgeStale does not touch already-exited sessions', () => {
    const exited = makeSession({
      pid: 999999,
      exitedAt: new Date().toISOString(),
      exitCode: 0,
    });
    store.save(exited);
    const changed = store.purgeStale();
    expect(changed).toBe(false);
  });

  test('purgeStale removes exited sessions older than 7 days', () => {
    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const old = makeSession({
      exitedAt: oldDate,
      exitCode: 0,
    });
    store.save(old);
    const changed = store.purgeStale();
    expect(changed).toBe(true);
    expect(store.findByRemiSessionId(old.remiSessionId)).toBeNull();
  });

  test('purgeStale keeps recent exited sessions', () => {
    const recent = makeSession({
      exitedAt: new Date().toISOString(),
      exitCode: 0,
    });
    store.save(recent);
    const changed = store.purgeStale();
    expect(changed).toBe(false);
    expect(store.findByRemiSessionId(recent.remiSessionId)).not.toBeNull();
  });

  test('list auto-purges stale sessions', () => {
    const stale = makeSession({ pid: 999999 });
    const alive = makeSession({ pid: process.pid });
    store.save(stale);
    store.save(alive);
    const sessions = store.list();
    // Both still in list, but stale one is now marked exited
    expect(sessions).toHaveLength(2);
    const staleSession = sessions.find((s) => s.remiSessionId === stale.remiSessionId);
    const aliveSession = sessions.find((s) => s.remiSessionId === alive.remiSessionId);
    expect(staleSession?.exitedAt).not.toBeNull();
    expect(aliveSession?.exitedAt).toBeNull();
  });

  describe('projectPath normalization (#680)', () => {
    test('save normalizes a tilde-form projectPath before persisting', () => {
      const session = makeSession({ projectPath: '~/Documents/git/nemar/nemar-cli' });
      store.save(session);
      const found = store.findByRemiSessionId(session.remiSessionId);
      expect(found?.projectPath).toBe(path.join(os.homedir(), 'Documents/git/nemar/nemar-cli'));
    });

    test('tilde-form and absolute-form saves converge to the same projectPath', () => {
      const tilde = makeSession({ projectPath: '~/Documents/git/nemar/nemar-cli' });
      const absolute = makeSession({
        projectPath: path.join(os.homedir(), 'Documents/git/nemar/nemar-cli'),
      });
      store.save(tilde);
      store.save(absolute);
      const foundTilde = store.findByRemiSessionId(tilde.remiSessionId);
      const foundAbsolute = store.findByRemiSessionId(absolute.remiSessionId);
      expect(foundTilde?.projectPath).toBe(foundAbsolute?.projectPath ?? '');
    });

    test('reading a legacy raw-tilde entry off disk self-heals projectPath', () => {
      // Write a pre-#680 entry directly to disk, bypassing save()'s
      // normalization, to simulate a value written by an older binary.
      const legacy: StoredSession = makeSession({
        projectPath: '~/Documents/git/nemar/nemar-cli',
      });
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({ version: 1, sessions: [legacy] }, null, 2),
        'utf-8',
      );

      const found = store.findByRemiSessionId(legacy.remiSessionId);
      expect(found?.projectPath).toBe(normalizeProjectPath(legacy.projectPath));

      const listed = store.list();
      expect(listed[0]?.projectPath).toBe(normalizeProjectPath(legacy.projectPath));

      const recent = store.getMostRecent();
      expect(recent?.projectPath).toBe(normalizeProjectPath(legacy.projectPath));
    });

    test('self-healed projectPath is persisted on the next write', () => {
      const legacy: StoredSession = makeSession({
        projectPath: '~/Documents/git/nemar/nemar-cli',
      });
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({ version: 1, sessions: [legacy] }, null, 2),
        'utf-8',
      );

      store.markExited(legacy.remiSessionId, 0);

      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        sessions: StoredSession[];
      };
      expect(raw.sessions[0]?.projectPath).toBe(normalizeProjectPath(legacy.projectPath));
    });
  });

  // Harness seam, phase 1 (#1162). A Claude record carries exactly these eight
  // keys on disk. No `harness` or `harnessSessionId` key may materialize, so an
  // older daemon that rewrites the same sessions.json never meets (or drops)
  // anything it does not know. The list is spelled out here, not derived from
  // the StoredSession type, so the pin does not move when the type does.
  describe('legacy record shape (#1162)', () => {
    const LEGACY_KEYS = [
      'claudeSessionId',
      'exitCode',
      'exitedAt',
      'pid',
      'port',
      'projectPath',
      'remiSessionId',
      'startedAt',
    ];

    function diskRecords(): Record<string, unknown>[] {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        version: number;
        sessions: Record<string, unknown>[];
      };
      expect(raw.version).toBe(1);
      return raw.sessions;
    }

    test('a legacy record keeps exactly 8 keys through save, markExited and read', () => {
      const session = makeSession({ claudeSessionId: 'claude-legacy' });
      store.save(session);
      expect(Object.keys(diskRecords()[0] ?? {}).sort()).toEqual(LEGACY_KEYS);

      // Every read path returns the same eight keys, no more.
      expect(Object.keys(store.findByRemiSessionId(session.remiSessionId) ?? {}).sort()).toEqual(
        LEGACY_KEYS,
      );
      expect(Object.keys(store.findByClaudeSessionId('claude-legacy') ?? {}).sort()).toEqual(
        LEGACY_KEYS,
      );
      expect(Object.keys(store.list()[0] ?? {}).sort()).toEqual(LEGACY_KEYS);

      store.markExited(session.remiSessionId, 0);
      const afterExit = diskRecords();
      expect(afterExit).toHaveLength(1);
      expect(Object.keys(afterExit[0] ?? {}).sort()).toEqual(LEGACY_KEYS);
      expect(afterExit[0]?.['exitCode']).toBe(0);
      expect(typeof afterExit[0]?.['exitedAt']).toBe('string');
      expect(Object.keys(store.findByRemiSessionId(session.remiSessionId) ?? {}).sort()).toEqual(
        LEGACY_KEYS,
      );
    });

    test('a hand-written legacy file keeps exactly 8 keys through every rewriting operation', () => {
      // Written as a literal, not through makeSession or save(), so this is the
      // shape an older binary left on disk.
      const legacy = {
        remiSessionId: crypto.randomUUID(),
        claudeSessionId: null,
        projectPath: '/tmp/project',
        port: 18765,
        pid: process.pid,
        startedAt: '2026-01-01T00:00:00.000Z',
        exitedAt: null,
        exitCode: null,
      };
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, sessions: [legacy] }, null, 2));

      // updateClaudeSessionId rewrites the file.
      store.updateClaudeSessionId(legacy.remiSessionId as UUID, 'claude-adopted');
      expect(Object.keys(diskRecords()[0] ?? {}).sort()).toEqual(LEGACY_KEYS);
      expect(diskRecords()[0]?.['claudeSessionId']).toBe('claude-adopted');

      // Saving a different session rewrites the file too.
      const other = makeSession({ claudeSessionId: 'claude-other' });
      store.save(other);
      for (const record of diskRecords()) {
        expect(Object.keys(record).sort()).toEqual(LEGACY_KEYS);
      }

      // purgeStale rewrites it when it changes something: an exited row older
      // than seven days is removed, the legacy row stays.
      store.save(makeSession({ exitedAt: '2020-01-01T00:00:00.000Z', exitCode: 0 }));
      expect(store.purgeStale()).toBe(true);
      for (const record of diskRecords()) {
        expect(Object.keys(record).sort()).toEqual(LEGACY_KEYS);
      }

      store.markExited(legacy.remiSessionId as UUID, 1);
      const final = diskRecords().find((r) => r['remiSessionId'] === legacy.remiSessionId);
      expect(Object.keys(final ?? {}).sort()).toEqual(LEGACY_KEYS);
      expect(final?.['exitCode']).toBe(1);
    });
  });

  // Harness identity fields (#1162, ADR 0032). The store rebuilds every record
  // from the keys it knows, so a field it does not copy is dropped on the next
  // rewrite by any daemon. These tests construct a real SessionStore over real
  // files; the "unknown" shapes are hand-written because no code writes them yet.
  describe('harness identity fields (#1162)', () => {
    function writeFile(sessions: Record<string, unknown>[]): void {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, sessions }, null, 2));
    }

    function diskFile(): { version: number; sessions: Record<string, unknown>[] } {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }

    function legacyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        remiSessionId: crypto.randomUUID(),
        claudeSessionId: null,
        projectPath: '/tmp/project',
        port: 18765,
        pid: process.pid,
        startedAt: '2026-01-01T00:00:00.000Z',
        exitedAt: null,
        exitCode: null,
        ...overrides,
      };
    }

    test('well-typed harness and harnessSessionId survive save, read and every rewrite', () => {
      const session = makeSession({ harness: 'codex', harnessSessionId: 'thread-1' });
      store.save(session);
      expect(diskFile().sessions[0]?.['harness']).toBe('codex');
      expect(diskFile().sessions[0]?.['harnessSessionId']).toBe('thread-1');

      expect(store.findByRemiSessionId(session.remiSessionId)).toMatchObject({
        harness: 'codex',
        harnessSessionId: 'thread-1',
      });
      expect(store.list()[0]).toMatchObject({ harness: 'codex', harnessSessionId: 'thread-1' });

      // A different session's save and this one's markExited each rewrite the file.
      store.save(makeSession());
      store.markExited(session.remiSessionId, 0);
      const kept = diskFile().sessions.find((r) => r['remiSessionId'] === session.remiSessionId);
      expect(kept?.['harness']).toBe('codex');
      expect(kept?.['harnessSessionId']).toBe('thread-1');
      expect(kept?.['exitCode']).toBe(0);
    });

    test('a null harnessSessionId is a well-typed value and is kept', () => {
      const row = legacyRow({ harness: 'codex', harnessSessionId: null });
      writeFile([row]);

      store.markExited(row['remiSessionId'] as UUID, 0);
      const kept = diskFile().sessions[0];
      expect(kept?.['harness']).toBe('codex');
      expect(kept?.['harnessSessionId']).toBeNull();
    });

    test('an unknown harness string neither throws nor bricks the file, and survives a rewrite', () => {
      const future = legacyRow({
        harness: 'a-harness-from-a-newer-daemon',
        harnessSessionId: 'x-1',
      });
      const plain = legacyRow({ claudeSessionId: 'claude-plain' });
      writeFile([future, plain]);

      // Reading the file must not throw because of the unknown harness.
      expect(store.list()).toHaveLength(2);
      expect(store.findByClaudeSessionId('claude-plain')?.remiSessionId).toBe(
        plain['remiSessionId'] as string,
      );

      // A write by this build keeps the unknown record verbatim.
      store.markExited(plain['remiSessionId'] as UUID, 0);
      const file = diskFile();
      expect(file.version).toBe(1);
      const kept = file.sessions.find((r) => r['remiSessionId'] === future['remiSessionId']);
      expect(kept?.['harness']).toBe('a-harness-from-a-newer-daemon');
      expect(kept?.['harnessSessionId']).toBe('x-1');
    });

    test('ill-typed harness fields are ignored, not thrown on, and dropped on rewrite', () => {
      const row = legacyRow({
        claudeSessionId: 'claude-ill',
        harness: 5,
        harnessSessionId: { id: 'not-a-string' },
      });
      writeFile([row]);

      const found = store.findByClaudeSessionId('claude-ill');
      expect(found?.remiSessionId).toBe(row['remiSessionId'] as string);
      expect(Object.keys(found ?? {})).not.toContain('harness');
      expect(Object.keys(found ?? {})).not.toContain('harnessSessionId');

      store.markExited(row['remiSessionId'] as UUID, 0);
      expect(Object.keys(diskFile().sessions[0] ?? {}).sort()).toEqual([
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

    test('a record with the harness fields still needs a valid base record', () => {
      // The tolerance is for the two optional fields only; a bad required field
      // still rejects the file, as before.
      writeFile([legacyRow({ harness: 'codex', port: 'not-a-port' })]);
      expect(() => store.list()).toThrow(MalformedSessionStoreError);
    });

    test('the file stays version 1, which an older daemon requires', () => {
      store.save(makeSession({ harness: 'codex', harnessSessionId: 'thread-1' }));
      expect(diskFile().version).toBe(1);
    });
  });
});
