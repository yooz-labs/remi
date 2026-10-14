/** Real cache/Git -> verified child -> HubRelay/Worker -> enrolled encrypted client (#1285). */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ProtocolMessage,
  type SessionListResponseMessage,
  createAnswer,
  createHelloAck,
  createSessionListRequest,
  createSessionListResponse,
  deserialize,
  generateId,
  now,
  relayV2,
  serialize,
} from '@remi/shared';
import {
  CAPABILITY_HEADER,
  loadOrCreateCapabilityToken,
} from '../../packages/daemon/src/auth/capability-token.ts';
import { SessionRegistryFile } from '../../packages/daemon/src/session/session-registry-file.ts';
import { WorkspaceCache } from '../../packages/daemon/src/workspace/describe.ts';
import { resumed } from './relay-r3-fixture.ts';

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(`Timed out: ${what}`);
    await Bun.sleep(5);
  }
}

function git(directory: string, ...args: string[]): void {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    {
      cwd: directory,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) throw new Error(`Owned git failed: ${result.stderr}`);
}

async function fixture() {
  const localRequests: string[] = [];
  let failLocal = false;
  const running = await resumed({
    onSessionListRequest: (cid, id) => {
      localRequests.push(id);
      if (failLocal) throw new Error('OWNED_LOCAL_LIST_FAILURE');
      running.relay.sendRaw(cid, createSessionListResponse([], id));
    },
  });
  const previous = process.env['REMI_HOME'];
  process.env['REMI_HOME'] = running.dir;
  const token = loadOrCreateCapabilityToken(join(running.dir, 'capability.key'));
  const project = join(running.dir, 'project');
  mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'commit', '-q', '--allow-empty', '-m', 'initial');
  const sessionId = generateId();
  let clock = 1_000_000;
  const children = new Set<Bun.ServerWebSocket<undefined>>();
  const requests: { id: string; includeExternal: boolean }[] = [];
  const held: (() => void)[] = [];
  let hold = false;
  const cache = new WorkspaceCache({
    now: () => clock,
    onChange: () => notify(),
  });
  function response(requestId: string, includeExternal = false): SessionListResponseMessage {
    return createSessionListResponse(
      [
        {
          sessionId,
          name: 'owned child',
          projectPath: project,
          status: 'idle',
          lastActivity: now(),
          messageCount: 0,
          source: 'daemon',
          canAttach: true,
          canResume: false,
          harness: 'claude',
          harnessSessionId: sessionId,
          workspace: cache.get(project),
          wsPort: server.port as number,
          daemonHost: 'owned-private-child.invalid',
        },
        ...(includeExternal
          ? [
              {
                sessionId: 'owned-transcript',
                projectPath: project,
                status: 'completed' as const,
                lastActivity: now(),
                messageCount: 0,
                source: 'transcript' as const,
                canAttach: false,
                canResume: true,
              },
            ]
          : []),
      ],
      requestId,
      [server.port as number],
    );
  }
  function notify() {
    if (!children.size) return;
    const value = serialize(response(generateId()));
    for (const child of children) child.send(value);
  }
  const server = Bun.serve<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (request.headers.get(CAPABILITY_HEADER) !== token)
        return new Response('denied', { status: 401 });
      if (server.upgrade(request)) return;
      return new Response('bad', { status: 400 });
    },
    websocket: {
      open(ws) {
        children.add(ws);
      },
      close(ws) {
        children.delete(ws);
      },
      message(ws, data) {
        const message = deserialize(String(data));
        if (message?.type === 'hello') {
          ws.send(serialize(createHelloAck('2.0.0', sessionId, { attachState: 'attached' })));
        } else if (message?.type === 'session_list_request') {
          requests.push({ id: message.id, includeExternal: message.includeExternal ?? false });
          const value = serialize(response(message.id, message.includeExternal));
          if (hold) held.push(() => ws.send(value));
          else ws.send(value);
        }
      },
    },
  });
  const registry = new SessionRegistryFile(join(running.dir, 'live'));
  registry.register({
    sessionId,
    pid: process.pid,
    wsPort: server.port as number,
    hookPort: 1,
    projectPath: project,
    name: 'owned child',
    startedAt: '2026-01-01T00:00:00Z',
  });
  cache.get(project);
  await cache.settled(project);
  const messages: ProtocolMessage[] = [];
  let receiveTail = Promise.resolve();
  let receiveError: unknown;
  running.socket.tap((frame) => {
    if (typeof frame === 'string') return;
    receiveTail = receiveTail
      .then(async () => {
        const bytes = await running.channel.receive(frame);
        if (bytes) {
          const message = deserialize(new TextDecoder().decode(bytes));
          if (message) messages.push(message);
        } else if (frame[0] === relayV2.TYPE_BYE) {
          await running.channel.bye();
        }
      })
      .catch((error) => {
        receiveError = error;
      });
  });
  const list = async (includeExternal = true) => {
    const request = createSessionListRequest(includeExternal);
    await running.channel.send(new TextEncoder().encode(serialize(request)));
    return request.id;
  };
  const lists = () =>
    messages.filter(
      (message): message is SessionListResponseMessage => message.type === 'session_list_response',
    );
  return {
    ...running,
    sessionId,
    project,
    cache,
    messages,
    requests,
    localRequests,
    list,
    lists,
    notify,
    failLocal: () => {
      failLocal = true;
    },
    hold: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      for (const send of held.splice(0)) send();
    },
    async refresh(change = true) {
      if (change) git(project, 'switch', '-q', '-c', 'changed');
      clock += 11_000;
      cache.get(project);
      await cache.settled(project);
    },
    async cleanup() {
      hold = false;
      for (const send of held.splice(0)) send();
      try {
        await cache.settled(project);
        await running.cleanup();
        await receiveTail;
        if (receiveError) throw receiveError;
      } finally {
        server.stop(true);
        if (previous === undefined) Reflect.deleteProperty(process.env, 'REMI_HOME');
        else process.env['REMI_HOME'] = previous;
      }
    },
  };
}

test('a changed workspace read reaches the enrolled relay client as one aggregate (#1285)', async () => {
  const owned = await fixture();
  try {
    const id = await owned.list();
    await until(
      () => owned.lists().some((message) => message.requestId === id),
      'initial relay list',
    );
    expect(owned.lists()[0]?.sessions[0]?.workspace?.branch).toBe('main');
    await owned.refresh();
    await until(
      () =>
        owned
          .lists()
          .some(
            (message) =>
              message.requestId !== id && message.sessions[0]?.workspace?.branch === 'changed',
          ),
      'fresh unsolicited workspace aggregate',
    );
    expect(owned.lists()).toHaveLength(2);
    const update = owned.lists()[1];
    expect(update?.sessions[0]).toMatchObject({
      harness: 'claude',
      harnessSessionId: owned.sessionId,
    });
    expect(update?.sessions[0]?.wsPort).toBeUndefined();
    expect(update?.sessions[0]?.daemonHost).toBeUndefined();
    expect(update?.daemonPorts).toBeUndefined();
    expect(update?.sessions.some((session) => session.sessionId === 'owned-transcript')).toBe(true);
    expect(owned.requests.every((request) => request.includeExternal)).toBe(true);
    expect(owned.cache.readsStarted()).toBe(2);
    await owned.refresh(false);
    await Bun.sleep(80);
    expect(owned.lists()).toHaveLength(2);
    expect(owned.cache.readsStarted()).toBe(3);
  } finally {
    await owned.cleanup();
  }
}, 15000);

test('an unsolicited aggregate failure is visible and retires the relay channel (#1285)', async () => {
  const owned = await fixture();
  try {
    const initial = await owned.list();
    await until(
      () => owned.lists().some((message) => message.requestId === initial),
      'initial relay list',
    );
    owned.failLocal();
    owned.notify();
    await until(
      () => owned.logs.includes('Relay session list refresh failed; reconnect required'),
      'visible refresh failure',
    );
    await until(() => owned.relay.connectionCount === 0, 'retired failed refresh channel');
    expect(owned.lists()).toHaveLength(1);
    expect(owned.localRequests).toHaveLength(2);
    expect(owned.logs.some((line) => line.includes('OWNED_LOCAL_LIST_FAILURE'))).toBe(false);
  } finally {
    await owned.cleanup();
  }
}, 15000);

test('child list invalidations coalesce behind a held aggregate without blocking answers (#1285)', async () => {
  const owned = await fixture();
  try {
    const initial = await owned.list();
    await until(
      () => owned.lists().some((message) => message.requestId === initial),
      'initial relay list',
    );
    owned.hold();
    const pending = await owned.list();
    await until(() => owned.requests.length === 2, 'held child request');
    await owned.refresh();
    for (let index = 0; index < 20; index++) owned.notify();
    const extra = await owned.list(false);
    const answer = createAnswer('missing-session', 'missing-question', 'no');
    await owned.channel.send(new TextEncoder().encode(serialize(answer)));
    await until(
      () =>
        owned.messages.some(
          (message) =>
            message.type === 'error' &&
            message.code === 'BUSY' &&
            message.details?.['requestId'] === extra,
        ),
      'bounded busy response',
    );
    await until(
      () =>
        owned.messages.some(
          (message) =>
            message.type === 'answer_result' &&
            message.requestId === answer.id &&
            message.outcome === 'session-not-found',
        ),
      'answer refusal during list',
    );
    expect(owned.requests).toHaveLength(2);
    expect(owned.localRequests).toHaveLength(2);
    owned.release();
    await until(
      () => owned.lists().some((message) => message.requestId === pending),
      'held aggregate response',
    );
    await until(
      () =>
        owned
          .lists()
          .some(
            (message) =>
              message.requestId !== initial &&
              message.requestId !== pending &&
              message.sessions[0]?.workspace?.branch === 'changed',
          ),
      'coalesced fresh aggregate',
    );
    await Bun.sleep(80);
    expect(owned.lists()).toHaveLength(3);
    expect(owned.requests).toHaveLength(3);
    expect(owned.localRequests).toHaveLength(3);
    expect(owned.requests.every((request) => request.includeExternal)).toBe(true);
  } finally {
    await owned.cleanup();
  }
}, 15000);
