/**
 * Real-fs test for the hub census aggregation (#786/#787): writes
 * LiveSessionEntry files to a real temp directory through SessionRegistryFile
 * (same path the daemon uses), then verifies buildHubQuestionCensus flattens
 * them into the wire-shaped HubPendingQuestion list. No mocks.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildHubQuestionCensus } from '../../src/cli/hub-question-census.ts';
import {
  DEFAULT_BASE_PORT,
  type LiveSessionEntry,
  SessionRegistryFile,
} from '../../src/session/session-registry-file.ts';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remi-hub-census-test-'));
}

function makeEntry(overrides: Partial<LiveSessionEntry> = {}): LiveSessionEntry {
  return {
    sessionId: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    pid: process.pid,
    wsPort: DEFAULT_BASE_PORT,
    hookPort: DEFAULT_BASE_PORT + 100,
    projectPath: '/tmp/test-project',
    name: 'test:project/main',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('buildHubQuestionCensus (#786/#787, real fs)', () => {
  let tmpDir: string;
  let registry: SessionRegistryFile;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    registry = new SessionRegistryFile(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('empty registry census is zero sessions, zero questions', () => {
    const census = buildHubQuestionCensus(registry.listLive());
    expect(census).toEqual({ sessions: 0, questions: [] });
  });

  test('sessions with no pending questions count toward `sessions` but contribute nothing to `questions`', () => {
    registry.register(makeEntry({ sessionId: 'a', wsPort: DEFAULT_BASE_PORT }));
    registry.register(makeEntry({ sessionId: 'b', wsPort: DEFAULT_BASE_PORT + 1 }));

    const census = buildHubQuestionCensus(registry.listLive());
    expect(census.sessions).toBe(2);
    expect(census.questions).toEqual([]);
  });

  test('flattens each session pendingQuestions entry, carrying sessionId + sessionName', () => {
    registry.register(
      makeEntry({ sessionId: 'a', name: 'host:project-a/main', wsPort: DEFAULT_BASE_PORT }),
    );
    registry.register(
      makeEntry({ sessionId: 'b', name: 'host:project-b/dev', wsPort: DEFAULT_BASE_PORT + 1 }),
    );
    registry.setPendingQuestions('a', [
      { id: 'qa1', label: 'Permission: Bash', createdAt: '2026-07-17T00:00:00.000Z' },
      { id: 'qa2', label: 'Allow this action?', createdAt: '2026-07-17T00:00:01.000Z' },
    ]);
    registry.setPendingQuestions('b', [
      { id: 'qb1', label: 'Permission: Write', createdAt: '2026-07-17T00:00:02.000Z' },
    ]);

    const census = buildHubQuestionCensus(registry.listLive());
    expect(census.sessions).toBe(2);
    expect(census.questions).toHaveLength(3);

    const byId = new Map(census.questions.map((q) => [q.id, q]));
    expect(byId.get('qa1')).toEqual({
      id: 'qa1',
      sessionId: 'a',
      sessionName: 'host:project-a/main',
      label: 'Permission: Bash',
      createdAt: '2026-07-17T00:00:00.000Z',
    });
    expect(byId.get('qb1')).toEqual({
      id: 'qb1',
      sessionId: 'b',
      sessionName: 'host:project-b/dev',
      label: 'Permission: Write',
      createdAt: '2026-07-17T00:00:02.000Z',
    });
  });

  test('answering a question (setPendingQuestions with a smaller set) drops it from the next census', () => {
    registry.register(makeEntry({ sessionId: 'a' }));
    registry.setPendingQuestions('a', [
      { id: 'q1', label: 'x', createdAt: 't1' },
      { id: 'q2', label: 'y', createdAt: 't2' },
    ]);
    registry.setPendingQuestions('a', [{ id: 'q2', label: 'y', createdAt: 't2' }]);

    const census = buildHubQuestionCensus(registry.listLive());
    expect(census.questions.map((q) => q.id)).toEqual(['q2']);
  });

  test('a stale (dead-pid) session is dropped by listLive before it reaches the census', () => {
    registry.register(makeEntry({ sessionId: 'dead', pid: 999999 }));
    registry.setPendingQuestions('dead', [{ id: 'q1', label: 'x', createdAt: 't' }]);

    // listLive() itself reaps the dead entry (pre-existing behavior); the
    // census must reflect that, not resurrect a question for a gone daemon.
    const census = buildHubQuestionCensus(registry.listLive());
    expect(census.sessions).toBe(0);
    expect(census.questions).toEqual([]);
  });
});
