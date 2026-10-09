/**
 * A create request with a workspace (#1236, ADR 0036): the handler makes the
 * worktree with real git in a real repository, starts the child in it, and says
 * where in the response. Every refusal spawns nothing.
 *
 * A real `HarnessRegistry` over a real PATH (a fake `claude` in a temp directory,
 * plus the directory of the system's git), and the handler's own injection points
 * for the port probe and the spawn, which record what the handler asked for.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CreateSessionResponseMessage, ProtocolMessage, UUID } from '@remi/shared';
import { createCreateSessionHandlers } from '../../../src/cli/handlers/create-session-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { validateClaudeRemoteArgs } from '../../../src/harness/claude-args.ts';
import { HarnessRegistry } from '../../../src/harness/registry.ts';
import { SessionRegistryFile } from '../../../src/session/session-registry-file.ts';
import { RecentRepositoryStore } from '../../../src/workspace/recent-store.ts';

const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;
const SPAWNED = { sessionId: '55555555-5555-4555-8555-555555555555', port: 20003 };

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args],
    { cwd, encoding: 'utf-8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

describe('create requests with a workspace (#1236)', () => {
  let root: string;
  let bin: string;
  let repo: string;
  let savedPath: string | undefined;
  let logged: string[];
  let sent: ProtocolMessage[];
  let probes: number;
  let freePort: number | null;
  let spawnError: Error | null;
  let spawns: Array<{ port: number; directory: string | undefined; extraArgs: string[] }>;
  let history: RecentRepositoryStore;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-create-ws-')));
    bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n');
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
    const gitPath = spawnSync('which', ['git'], { encoding: 'utf-8' }).stdout.trim();
    savedPath = process.env['PATH'];
    process.env['PATH'] = `${bin}:${path.dirname(gitPath)}`;

    repo = path.join(root, 'project');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');

    logged = [];
    sent = [];
    probes = 0;
    freePort = SPAWNED.port;
    spawnError = null;
    spawns = [];
    history = new RecentRepositoryStore(path.join(root, 'home', 'recent-repositories.json'));
    configureLogger({ writeLog: (line: string) => logged.push(line) });
  });

  afterEach(() => {
    __resetLoggerForTests();
    process.env['PATH'] = savedPath ?? '';
    fs.rmSync(root, { recursive: true, force: true });
  });

  const handlers = () =>
    createCreateSessionHandlers({
      harnesses: new HarnessRegistry({
        claude: { command: 'claude', validateRemoteArgs: validateClaudeRemoteArgs },
      }),
      liveSessionsRegistry: new SessionRegistryFile(path.join(root, 'live-sessions')),
      spawningPorts: new Set(),
      basePort: 20000,
      portRange: 10,
      bindHost: '127.0.0.1',
      inheritedArgs: () => ['--inherited'],
      rememberRepository: (directory, repository) => history.remember(directory, repository),
      send: (_connectionId, message) => {
        sent.push(message);
        return true;
      },
      findAvailableTcpPort: async () => {
        probes += 1;
        return freePort;
      },
      spawnDaemon: async (port, directory, extraArgs) => {
        spawns.push({ port, directory, extraArgs });
        if (spawnError) throw spawnError;
        return { ...SPAWNED, pid: 4242 };
      },
    });

  const response = () => sent[0] as CreateSessionResponseMessage;
  const worktreeDir = (branch: string) => path.join(root, 'remi-worktrees', `project-${branch}`);

  test('a new worktree: the child starts in it, and the response says where', async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    await handlers().onCreateSessionRequest(CID, repo, REQ, {
      workspace: { repository: repo, worktree: { branch: 'feature/x' } },
    });
    const dir = worktreeDir('feature-x');
    expect(spawns).toEqual([{ port: SPAWNED.port, directory: dir, extraArgs: ['--inherited'] }]);
    expect(response()).toMatchObject({
      success: true,
      sessionId: SPAWNED.sessionId,
      port: SPAWNED.port,
      workspace: {
        repository: repo,
        directory: dir,
        worktree: { branch: 'feature/x', base: head },
      },
    });
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/x');
    expect(history.list().map((r) => r.repository)).toEqual([repo]);
  });

  test('a workspace without a worktree starts the child in the main worktree', async () => {
    await handlers().onCreateSessionRequest(CID, undefined, REQ, {
      workspace: { repository: path.join(repo, '.') },
    });
    expect(spawns.map((s) => s.directory)).toEqual([repo]);
    expect(response().workspace).toEqual({ repository: repo, directory: repo });
  });

  test('the workspace goes with a harness request: both are applied', async () => {
    await handlers().onCreateSessionRequest(CID, repo, REQ, {
      harness: 'claude',
      args: ['--model', 'opus'],
      workspace: { repository: repo, worktree: { branch: 'b' } },
    });
    expect(spawns).toEqual([
      {
        port: SPAWNED.port,
        directory: worktreeDir('b'),
        extraArgs: ['--inherited', '--harness', 'claude', '--', '--model', 'opus'],
      },
    ]);
  });

  test('a directory that differs from the repository is refused, and nothing is made or spawned', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    await handlers().onCreateSessionRequest(CID, elsewhere, REQ, {
      workspace: { repository: repo, worktree: { branch: 'b' } },
    });
    expect(response()).toMatchObject({ success: false });
    expect(response().error).toContain('differ');
    expect(probes).toBe(0);
    expect(spawns).toEqual([]);
    expect(fs.existsSync(path.join(root, 'remi-worktrees'))).toBe(false);
  });

  test('a directory equal to the repository, an empty one or none is accepted', async () => {
    for (const directory of [repo, `${repo}/`, '', undefined]) {
      sent = [];
      spawns = [];
      await handlers().onCreateSessionRequest(CID, directory, REQ, {
        workspace: { repository: repo },
      });
      expect(response().success, String(directory)).toBe(true);
      expect(spawns.map((s) => s.directory)).toEqual([repo]);
    }
  });

  test('a workspace the parser refuses spawns nothing and probes no port', async () => {
    for (const workspace of [
      { repository: 'relative' },
      { repository: repo, worktree: { branch: '-x' } },
      'x',
    ]) {
      sent = [];
      await handlers().onCreateSessionRequest(CID, undefined, REQ, { workspace });
      expect(response().success, JSON.stringify(workspace)).toBe(false);
      expect(response().error).toContain('Invalid workspace');
    }
    expect(probes).toBe(0);
    expect(spawns).toEqual([]);
  });

  test('a workspace git refuses spawns nothing, and the log has the reason, escaped', async () => {
    git(repo, 'branch', 'taken');
    await handlers().onCreateSessionRequest(CID, undefined, REQ, {
      workspace: { repository: repo, worktree: { branch: 'taken' } },
    });
    expect(response()).toMatchObject({ success: false });
    expect(response().error).toContain('That branch already exists');
    expect(spawns).toEqual([]);
    expect(logged.some((line) => line.includes('refused') && line.includes('taken'))).toBe(true);
  });

  test('with no free port, no worktree is made', async () => {
    freePort = null;
    await handlers().onCreateSessionRequest(CID, undefined, REQ, {
      workspace: { repository: repo, worktree: { branch: 'b' } },
    });
    expect(response()).toMatchObject({ success: false });
    expect(spawns).toEqual([]);
    expect(fs.existsSync(path.join(root, 'remi-worktrees'))).toBe(false);
    expect(git(repo, 'branch', '--list', 'b')).toBe('');
  });

  test('a spawn that fails after the worktree is made keeps the worktree, and the log names it', async () => {
    spawnError = new Error('spawn failed (test)');
    await handlers().onCreateSessionRequest(CID, undefined, REQ, {
      workspace: { repository: repo, worktree: { branch: 'b' } },
    });
    expect(response()).toMatchObject({ success: false });
    expect(response().error).not.toContain(root);
    expect(history.list()).toEqual([]);
    expect(fs.existsSync(worktreeDir('b'))).toBe(true);
    // The failure line itself names the worktree it leaves (the spawn line names it too).
    expect(
      logged.some(
        (line) => line.includes('Failed to spawn') && line.includes(`stays at ${worktreeDir('b')}`),
      ),
    ).toBe(true);
  });

  test('a resume cannot start in a new worktree: refused, nothing made or spawned (#1270 review)', async () => {
    await handlers().onCreateSessionRequest(CID, undefined, REQ, {
      args: ['--resume', '3f9c2a1e-0000-4000-8000-000000000042'],
      workspace: { repository: repo, worktree: { branch: 'b' } },
    });
    expect(response()).toMatchObject({ success: false });
    expect(response().error).toContain('resumed session cannot start in a new worktree');
    expect(probes).toBe(0);
    expect(spawns).toEqual([]);
    expect(fs.existsSync(path.join(root, 'remi-worktrees'))).toBe(false);
  });

  test('a resume in the repository itself, with no new worktree, is allowed', async () => {
    await handlers().onCreateSessionRequest(CID, undefined, REQ, {
      args: ['--resume', '3f9c2a1e-0000-4000-8000-000000000042'],
      workspace: { repository: repo },
    });
    expect(response().success).toBe(true);
    expect(spawns.map((s) => s.directory)).toEqual([repo]);
  });

  test('a hook that fails after the worktree is made: the session starts, and the response says so', async () => {
    const hookFile = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hookFile, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hookFile, 0o755);
    await handlers().onCreateSessionRequest(CID, undefined, REQ, {
      workspace: { repository: repo, worktree: { branch: 'b' } },
    });
    expect(response().success).toBe(true);
    expect(spawns.map((s) => s.directory)).toEqual([worktreeDir('b')]);
    expect(response().notice).toContain('hook');
  });

  test('a request with no workspace is unchanged: no workspace in the response', async () => {
    await handlers().onCreateSessionRequest(CID, repo, REQ, undefined);
    expect(spawns.map((s) => s.directory)).toEqual([repo]);
    expect(response().success).toBe(true);
    expect('workspace' in response()).toBe(false);
    expect(history.list().map((r) => r.repository)).toEqual([repo]);
  });

  test('a history write failure still reports the successfully started child', async () => {
    fs.mkdirSync(history.filePath, { recursive: true });
    await handlers().onCreateSessionRequest(CID, repo, REQ);
    expect(response()).toMatchObject({
      success: true,
      sessionId: SPAWNED.sessionId,
      port: SPAWNED.port,
    });
    expect(spawns).toHaveLength(1);
    expect(logged.some((line) => line.includes('could not remember'))).toBe(true);
  });
});
