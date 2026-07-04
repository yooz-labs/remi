import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import { normalizeProjectPath } from '../../src/cli/path-resolver.ts';
import { SessionBindingStore } from '../../src/session/session-binding-store.ts';
import { SessionStore, type StoredSession } from '../../src/session/session-store.ts';
import { TranscriptIndex } from '../../src/session/transcript-index.ts';

function makeTmpPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-binding-test-'));
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

describe('SessionBindingStore', () => {
  let filePath: string;
  let store: SessionStore;
  let binding: SessionBindingStore;

  beforeEach(() => {
    filePath = makeTmpPath();
    store = new SessionStore(filePath);
    binding = new SessionBindingStore(store);
  });

  afterEach(() => {
    try {
      fs.rmSync(path.dirname(filePath), { recursive: true });
    } catch {
      // ignore
    }
  });

  test('preAssign persists the full record; get reads the binding back', () => {
    const session = makeSession({ claudeSessionId: 'claude-A' });
    binding.preAssign(session);

    expect(binding.get(session.remiSessionId)).toEqual({ claudeSessionId: 'claude-A' });
    // Durable: a fresh accessor over a fresh store off the same file reads it.
    const fresh = new SessionBindingStore(new SessionStore(filePath));
    expect(fresh.get(session.remiSessionId)?.claudeSessionId).toBe('claude-A');
  });

  test('update sets the binding (rotation / first discovery)', () => {
    const session = makeSession({ claudeSessionId: 'claude-A' });
    binding.preAssign(session);

    binding.update(session.remiSessionId, 'claude-B');
    expect(binding.get(session.remiSessionId)?.claudeSessionId).toBe('claude-B');
    // Persisted, not just in memory.
    expect(
      new SessionStore(filePath).findByRemiSessionId(session.remiSessionId)?.claudeSessionId,
    ).toBe('claude-B');
  });

  test('get mirrors findByRemiSessionId(id)?.claudeSessionId exactly', () => {
    // absent record -> null (not an object)
    const absent = crypto.randomUUID() as UUID;
    expect(binding.get(absent)).toBeNull();

    // present record with a null binding -> object carrying null
    const session = makeSession({ claudeSessionId: null });
    binding.preAssign(session);
    expect(binding.get(session.remiSessionId)).toEqual({ claudeSessionId: null });
    // ?.claudeSessionId yields null in both today and post-migration form
    expect(binding.get(session.remiSessionId)?.claudeSessionId ?? null).toBe(
      store.findByRemiSessionId(session.remiSessionId)?.claudeSessionId ?? null,
    );
  });

  test('update on an absent record is a no-op (matches SessionStore)', () => {
    const absent = crypto.randomUUID() as UUID;
    binding.update(absent, 'claude-X');
    expect(binding.get(absent)).toBeNull();
  });

  test('getByClaudeSessionId reverse-looks-up the record (or null)', () => {
    const session = makeSession({ claudeSessionId: 'claude-rev' });
    binding.preAssign(session);

    expect(binding.getByClaudeSessionId('claude-rev')?.remiSessionId).toBe(session.remiSessionId);
    expect(binding.getByClaudeSessionId('nope')).toBeNull();
  });

  test('cross-process freshness: a second store handle writing the same file is seen immediately', () => {
    // This is the load-bearing no-cache property. A sibling daemon (a DIFFERENT
    // SessionStore handle on the same sessions.json) rotates the binding; the
    // accessor must observe it on the very next get() with zero staleness — this
    // is exactly what preserves #321 (no cached id wedges classify) and the #430
    // "re-adopt on rotation" characterization test.
    const session = makeSession({ claudeSessionId: 'claude-1' });
    binding.preAssign(session);
    expect(binding.get(session.remiSessionId)?.claudeSessionId).toBe('claude-1');

    // A separate handle (simulating a sibling/fallback writer in another context)
    // writes a new id straight to disk, NOT through `binding`.
    const sibling = new SessionStore(filePath);
    sibling.updateClaudeSessionId(session.remiSessionId, 'claude-2');

    // No cache: the next read observes the external write.
    expect(binding.get(session.remiSessionId)?.claudeSessionId).toBe('claude-2');
  });

  test('multi-rotation sequence ends on the final id (golden)', () => {
    const session = makeSession({ claudeSessionId: 'claude-1' });
    binding.preAssign(session);
    binding.update(session.remiSessionId, 'claude-2');
    binding.update(session.remiSessionId, 'claude-3');

    expect(binding.get(session.remiSessionId)?.claudeSessionId).toBe('claude-3');
    expect(binding.getByClaudeSessionId('claude-3')?.remiSessionId).toBe(session.remiSessionId);
    expect(binding.getByClaudeSessionId('claude-1')).toBeNull();
  });

  test('rotation mirrors the NEW claudeSessionId into the durable index (#577)', () => {
    // The transcript-index must follow a rotation; otherwise the purged-binding
    // fallback would load the STALE pre-rotation transcript. Mirroring from the
    // record returned by updateClaudeSessionId (not a second read) closes the
    // race where a concurrent purge could null the row between write and mirror.
    const indexPath = path.join(path.dirname(filePath), 'transcript-index.json');
    const index = new TranscriptIndex(indexPath);
    const withIndex = new SessionBindingStore(store, index);

    const session = makeSession({ claudeSessionId: 'claude-old' });
    withIndex.preAssign(session);
    expect(index.get(session.remiSessionId)?.claudeSessionId).toBe('claude-old');

    withIndex.update(session.remiSessionId, 'claude-new');
    // The index now points at the rotated id with the same project path.
    const entry = index.get(session.remiSessionId);
    expect(entry?.claudeSessionId).toBe('claude-new');
    expect(entry?.projectPath).toBe(session.projectPath);
  });

  test('preAssign seeds TranscriptIndex with the NORMALIZED projectPath, not the raw input (#680)', () => {
    // A caller passing an unnormalized (tilde-form) projectPath must not make
    // TranscriptIndex diverge from what SessionStore actually persisted.
    const indexPath = path.join(path.dirname(filePath), 'transcript-index.json');
    const index = new TranscriptIndex(indexPath);
    const withIndex = new SessionBindingStore(store, index);

    const tildePath = '~/Documents/git/nemar/nemar-cli';
    const session = makeSession({ claudeSessionId: 'claude-tilde', projectPath: tildePath });
    withIndex.preAssign(session);

    const expected = normalizeProjectPath(tildePath);
    expect(store.findByRemiSessionId(session.remiSessionId)?.projectPath).toBe(expected);
    expect(index.get(session.remiSessionId)?.projectPath).toBe(expected);
  });
});
