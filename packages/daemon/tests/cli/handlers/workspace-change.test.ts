/** Real git/cache/registry/builder and shipping WebSocket server; no harness process or mocks. */
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type ProtocolMessage,
  type SessionListResponseMessage,
  createHello,
  deserialize,
  generateId,
  serialize,
} from '@remi/shared';
import { MessageAPI } from '../../../src/api/message-api';
import { broadcastWorkspaceChange } from '../../../src/cli/handlers/session-list-entries';
import { ClaudeHarness } from '../../../src/harness/index';
import { PTYSession } from '../../../src/pty/pty-session';
import { WebSocketServer } from '../../../src/server/websocket-server';
import { SessionBindingStore } from '../../../src/session/session-binding-store';
import { SessionRegistry } from '../../../src/session/session-registry';
import { SessionStore } from '../../../src/session/session-store';
import { TranscriptDiscovery } from '../../../src/transcript/transcript-discovery';
import { WorkspaceCache } from '../../../src/workspace/describe';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function git(directory: string, ...args: string[]): void {
  const result = spawnSync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args],
    { cwd: directory, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error('workspace client timed out');
    await Bun.sleep(5);
  }
}

async function fixture(harnessKind: 'claude' | 'codex' = 'claude') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-workspace-push-')));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'commit', '-q', '--allow-empty', '-m', 'initial');
  let clock = 1_000_000;
  const broadcasts: ProtocolMessage[] = [];
  const sockets: WebSocket[] = [];
  const updates: SessionListResponseMessage[] = [];
  const cache = new WorkspaceCache({
    now: () => clock,
    onChange: (dir) => broadcastWorkspaceChange(deps, dir),
  });
  const registry = new SessionRegistry({ workspaceOf: (dir) => cache.get(dir) });
  const binding = new SessionBindingStore(new SessionStore(path.join(root, 'sessions.json')));
  const discovery = new TranscriptDiscovery({ projectsDir: path.join(root, 'transcripts') });
  const harness = new ClaudeHarness(discovery);
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  cleanup.push(async () => {
    for (const socket of sockets) socket.close();
    await server.stop();
    await until(() => sockets.every((socket) => socket.readyState === WebSocket.CLOSED));
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const deps = {
    sessionRegistry: registry,
    bindingStore: binding,
    transcriptDiscovery: discovery,
    harness,
    currentPort: () => server.port,
    getLivePorts: () => [server.port],
    broadcast(message: ProtocolMessage) {
      broadcasts.push(message);
      server.broadcast(message);
    },
  };
  await server.start();
  expect(server.port).toBeGreaterThan(0);
  const sessionId = generateId();
  const harnessSessionId = generateId();
  // The registry holds a genuine unstarted PTY, as it does before a harness starts. No model runs.
  registry.registerSession(
    sessionId,
    project,
    new PTYSession({ command: '/bin/cat', cwd: project }),
    new MessageAPI({ sessionId }),
    true,
  );
  binding.preAssign({
    remiSessionId: sessionId,
    claudeSessionId: harnessKind === 'claude' ? harnessSessionId : null,
    ...(harnessKind === 'codex' && { harness: 'codex', harnessSessionId }),
    projectPath: project,
    port: server.port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    exitedAt: null,
    exitCode: null,
  });
  await cache.settled(project);
  broadcasts.length = 0;
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  sockets.push(socket);
  socket.addEventListener('open', () =>
    socket.send(serialize(createHello('workspace-test', '1.0'))),
  );
  socket.addEventListener('message', (event) => {
    const message = deserialize(String(event.data));
    if (message?.type === 'session_list_response') updates.push(message);
  });
  await until(() => server.allConnections.some((connection) => connection.isConnected));
  return {
    project,
    registry,
    cache,
    broadcasts,
    updates,
    sessionId,
    harnessSessionId,
    async refresh() {
      clock += 11_000;
      registry.listSessions();
      await cache.settled(project);
    },
  };
}

for (const harnessKind of ['claude', 'codex'] as const) {
  test(`a changed branch read pushes one current ${harnessKind} list to a connected client (#1285)`, async () => {
    const f = await fixture(harnessKind);
    git(f.project, 'checkout', '-q', '-b', 'changed');
    await f.refresh();
    await until(() => f.updates.length === 1);
    expect(f.broadcasts).toHaveLength(1);
    expect(f.updates[0]?.sessions).toHaveLength(1);
    expect(f.updates[0]?.sessions[0]).toMatchObject({
      sessionId: f.sessionId,
      harness: harnessKind,
      harnessSessionId: f.harnessSessionId,
      workspace: { repository: f.project, directory: f.project, branch: 'changed' },
    });
    // No siblings are required for a workspace push; the own port is filtered out.
    expect(f.updates[0]?.daemonPorts).toBeUndefined();
    expect(f.cache.readsStarted()).toBe(2);
    await f.refresh();
    expect(f.broadcasts).toHaveLength(1);
    expect(f.cache.readsStarted()).toBe(3);
  });
}

test('a workspace read finishing after its session closes pushes nothing (#1285)', async () => {
  const f = await fixture();
  git(f.project, 'checkout', '-q', '-b', 'changed');
  const refresh = f.refresh();
  await f.registry.shutdown();
  await refresh;
  expect(f.cache.get(f.project)?.branch).toBe('changed');
  expect(f.broadcasts).toEqual([]);
  expect(f.updates).toEqual([]);
});
