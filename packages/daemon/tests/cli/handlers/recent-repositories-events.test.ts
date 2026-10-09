/**
 * The recent-repositories request (#1236 phase C): the handler reads the machine's real session
 * store and answers the requesting connection with the repositories of its recent sessions.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, RecentRepositoriesResponseMessage, UUID } from '@remi/shared';
import { createRecentRepositoriesHandlers } from '../../../src/cli/handlers/recent-repositories-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { RecentRepositoryStore } from '../../../src/workspace/recent-store.ts';

const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;

describe('recent_repositories_request (#1236 phase C)', () => {
  let root: string;
  let store: SessionStore;
  let sent: Array<{ connectionId: UUID; message: ProtocolMessage }>;
  let history: RecentRepositoryStore;
  let logged: string[];

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-recent-handler-')));
    store = new SessionStore(path.join(root, 'sessions.json'));
    sent = [];
    history = new RecentRepositoryStore(path.join(root, 'history', 'recent-repositories.json'));
    logged = [];
    configureLogger({ writeLog: (line) => logged.push(line) });
  });

  afterEach(() => {
    __resetLoggerForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function repo(name: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    const run = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', ...args], { cwd: dir });
    run('init', '-q', '-b', 'main');
    run('commit', '-q', '--allow-empty', '-m', 'first');
    return fs.realpathSync(dir);
  }

  function record(projectPath: string, startedAt: string, id: string): void {
    store.save({
      remiSessionId: id as UUID,
      claudeSessionId: null,
      projectPath,
      port: 0,
      pid: null,
      startedAt,
      exitedAt: null,
      exitCode: null,
    });
  }

  const handlers = () =>
    createRecentRepositoriesHandlers({
      sessionStore: store,
      repositoryStore: history,
      send: (connectionId, message) => {
        sent.push({ connectionId, message });
        return true;
      },
    });

  test('answers the requester with the repositories of the store, most recent first', async () => {
    const a = repo('a');
    const b = repo('b');
    record(a, '2026-10-07T10:00:00.000Z', '11111111-1111-4111-8111-111111111111');
    record(b, '2026-10-07T11:00:00.000Z', '22222222-2222-4222-8222-222222222222');
    await handlers().onRecentRepositoriesRequest(CID, REQ, undefined);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.connectionId).toBe(CID);
    const response = sent[0]?.message as RecentRepositoriesResponseMessage;
    expect(response.type).toBe('recent_repositories_response');
    expect(response.requestId).toBe(REQ);
    expect(response.repositories.map((r) => r.repository)).toEqual([b, a]);
  });

  test('an empty store answers with an empty list, never silence', async () => {
    await handlers().onRecentRepositoriesRequest(CID, REQ, 5);
    expect((sent[0]?.message as RecentRepositoriesResponseMessage).repositories).toEqual([]);
  });

  test('retained history still answers when the session store cannot be read', async () => {
    const main = repo('retained');
    await history.remember(main);
    fs.writeFileSync(path.join(root, 'sessions.json'), '{ not json');
    await handlers().onRecentRepositoriesRequest(CID, REQ, undefined);
    expect(
      (sent[0]?.message as RecentRepositoriesResponseMessage).repositories.map((r) => r.repository),
    ).toEqual([main]);
  });

  test('damaged history is logged and ignored while session repositories still answer', async () => {
    const main = repo('current');
    record(main, new Date().toISOString(), '11111111-1111-4111-8111-111111111111');
    fs.mkdirSync(path.dirname(history.filePath));
    fs.writeFileSync(history.filePath, '{ private-contents');
    await handlers().onRecentRepositoriesRequest(CID, REQ, undefined);
    expect(
      (sent[0]?.message as RecentRepositoriesResponseMessage).repositories.map((r) => r.repository),
    ).toEqual([main]);
    expect(logged.some((line) => line.includes('ignoring the file'))).toBe(true);
    expect(logged.join('\n')).not.toContain('private-contents');
  });

  test('a store that cannot be read still answers, with an empty list', async () => {
    fs.writeFileSync(path.join(root, 'sessions.json'), '{ not json');
    await handlers().onRecentRepositoriesRequest(CID, REQ, undefined);
    expect(sent).toHaveLength(1);
    expect((sent[0]?.message as RecentRepositoriesResponseMessage).repositories).toEqual([]);
  });

  test('a limit that is not a number is the default, ten', async () => {
    for (let i = 0; i < 12; i++) {
      record(
        repo(`n${String(i).padStart(2, '0')}`),
        new Date(Date.UTC(2026, 9, 7, 10, i)).toISOString(),
        `${String(i).padStart(2, '0')}111111-1111-4111-8111-111111111111`,
      );
    }
    await handlers().onRecentRepositoriesRequest(CID, REQ, '5' as unknown as number);
    expect((sent[0]?.message as RecentRepositoriesResponseMessage).repositories).toHaveLength(10);
  }, 30000);

  test('requests that arrive together share one walk, and each gets its own answer', async () => {
    record(repo('a'), '2026-10-07T10:00:00.000Z', '11111111-1111-4111-8111-111111111111');
    let reads = 0;
    const counted = createRecentRepositoriesHandlers({
      sessionStore: {
        list: () => {
          reads += 1;
          return store.list();
        },
      },
      send: (connectionId, message) => {
        sent.push({ connectionId, message });
        return true;
      },
    });
    const other = 'req11111-0000-0000-0000-000000000000' as UUID;
    await Promise.all([
      counted.onRecentRepositoriesRequest(CID, REQ, 1),
      counted.onRecentRepositoriesRequest(CID, other, 5),
    ]);
    expect(reads).toBe(1);
    expect(
      sent.map((s) => (s.message as RecentRepositoriesResponseMessage).requestId).sort(),
    ).toEqual([REQ, other].sort());
    await counted.onRecentRepositoriesRequest(CID, REQ, 1);
    expect(reads).toBe(2);
  });

  test('the limit the client asked for is applied', async () => {
    for (let i = 0; i < 4; i++) {
      record(
        repo(`r${i}`),
        `2026-10-07T1${i}:00:00.000Z`,
        `${i}1111111-1111-4111-8111-111111111111`,
      );
    }
    await handlers().onRecentRepositoriesRequest(CID, REQ, 2);
    expect((sent[0]?.message as RecentRepositoriesResponseMessage).repositories).toHaveLength(2);
  });
});
