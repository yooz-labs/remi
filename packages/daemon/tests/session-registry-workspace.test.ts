/**
 * The session list names the workspace a session runs in (#1236 phase B, ADR 0036): the registry
 * reads it from a real `WorkspaceCache` over a real repository, primed when the session registers.
 * The PTY and message API are the same inert stand-ins `session-registry.test.ts` uses: the
 * registry only holds them.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../src/api/message-api.ts';
import type { PTYSession } from '../src/pty/pty-session.ts';
import { SessionRegistry } from '../src/session/session-registry.ts';
import { WorkspaceCache } from '../src/workspace/describe.ts';

const pty = () =>
  ({ id: generateId(), close: mock(() => Promise.resolve()) }) as unknown as PTYSession;
const messageApi = () =>
  ({
    bulletCount: 0,
    handleMessage: mock(() => {}),
    handleMessageUpdate: mock(() => {}),
    reset: mock(() => {}),
  }) as unknown as MessageAPI;

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args],
    { cwd, encoding: 'utf-8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

describe('the session list names its workspace (#1236 phase B)', () => {
  let root: string;
  let registry: SessionRegistry;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-registry-ws-')));
  });

  afterEach(async () => {
    await registry?.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('registering starts the read, and the entry carries it once git has answered', async () => {
    const repo = path.join(root, 'project');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    const cache = new WorkspaceCache();
    registry = new SessionRegistry({ workspaceOf: (dir) => cache.get(dir) });
    registry.registerSession(registry.createSessionId(), repo, pty(), messageApi());
    // Registration asked once, so the read is already running.
    expect(cache.inFlight()).toBe(1);
    await cache.settled(repo);
    expect(registry.listSessions()[0]?.workspace).toEqual({
      repository: repo,
      directory: repo,
      branch: 'main',
    });
  });

  test('a session outside any repository has no workspace field', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    const cache = new WorkspaceCache();
    registry = new SessionRegistry({ workspaceOf: (dir) => cache.get(dir) });
    registry.registerSession(registry.createSessionId(), plain, pty(), messageApi());
    await cache.settled(plain);
    expect('workspace' in (registry.listSessions()[0] as object)).toBe(false);
  });

  test('a registry with no workspace source lists none', () => {
    registry = new SessionRegistry();
    registry.registerSession(registry.createSessionId(), root, pty(), messageApi());
    expect('workspace' in (registry.listSessions()[0] as object)).toBe(false);
  });
});
