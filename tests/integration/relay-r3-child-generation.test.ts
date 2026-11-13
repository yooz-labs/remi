import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ProtocolMessage,
  createAnswer,
  createAnswerResult,
  createHello,
  createHelloAck,
  createPing,
  createSessionListResponse,
  createSessionUpdate,
  createUserInput,
  deserialize,
  encodeFileDownloadFrame,
  generateId,
  serialize,
} from '@remi/shared';
import {
  CAPABILITY_HEADER,
  loadOrCreateCapabilityToken,
} from '../../packages/daemon/src/auth/capability-token.ts';
import { ChildProxy } from '../../packages/daemon/src/remote/child-proxy.ts';
import { SessionRegistryFile } from '../../packages/daemon/src/session/session-registry-file.ts';
import { Mailbox } from '../../packages/signaling/tests/e2e/endpoints.ts';

async function fixture(sessionId = 'owned-child') {
  const dir = mkdtempSync(join(tmpdir(), 'remi-r3-child-generation-'));
  chmodSync(dir, 0o700);
  const previous = process.env['REMI_HOME'];
  process.env['REMI_HOME'] = dir;
  const token = loadOrCreateCapabilityToken(join(dir, 'capability.key'));
  const requests = new Mailbox<{
    message: ProtocolMessage;
    raw: string;
    reply: (message: ProtocolMessage) => void;
    close: () => void;
  }>();
  const forwarded: ProtocolMessage[] = [];
  const failures: string[] = [];
  const ownerLosses: boolean[] = [];
  const invalidations: number[] = [];
  let authority = true;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, server) {
      if (req.headers.get(CAPABILITY_HEADER) !== token)
        return new Response('denied', { status: 401 });
      if (server.upgrade(req)) return;
      return new Response('bad', { status: 400 });
    },
    websocket: {
      message(ws, data) {
        const message = deserialize(String(data));
        if (!message) throw new Error('INVALID_FIXTURE_REQUEST');
        requests.push({
          message,
          raw: String(data),
          close: () => ws.close(),
          reply: (value) => {
            ws.send(serialize(value));
          },
        });
      },
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error('MISSING_FIXTURE_PORT');
  const registry = new SessionRegistryFile(join(dir, 'live'));
  const entry = {
    sessionId,
    pid: process.pid,
    wsPort: port,
    hookPort: 1,
    projectPath: dir,
    name: 'owned',
    startedAt: '2026-01-01T00:00:00Z',
  };
  registry.register(entry);
  const proxy = new ChildProxy(
    registry,
    'owned-device',
    (message) => forwarded.push(message),
    (id, consumed) => {
      failures.push(id);
      ownerLosses.push(consumed === true);
    },
    () => authority,
    undefined,
    () => invalidations.push(1),
    dir,
  );
  const ack = () => createHelloAck('2.0.0', entry.sessionId, { attachState: 'attached' });
  const cleanup = () => {
    proxy.close();
    server.stop(true);
    if (previous === undefined) Reflect.deleteProperty(process.env, 'REMI_HOME');
    else process.env['REMI_HOME'] = previous;
    rmSync(dir, { recursive: true, force: true });
  };
  return {
    proxy,
    registry,
    entry,
    requests,
    forwarded,
    failures,
    ownerLosses,
    invalidations,
    ack,
    cleanup,
    revoke: () => {
      authority = false;
    },
  };
}

for (const retirement of ['revoked', 'generation-replaced', 'proxy-closed'] as const) {
  test(`only fresh verified child lists invalidate the aggregate before ${retirement} (#1285)`, async () => {
    const owned = await fixture();
    try {
      const result = owned.proxy.list(owned.entry.sessionId, false);
      const hello = await owned.requests.next();
      hello.reply(createSessionListResponse([], generateId()));
      await Bun.sleep(40);
      expect(owned.invalidations).toHaveLength(0);
      hello.reply(owned.ack());
      const request = await owned.requests.next();
      const response = createSessionListResponse([], request.message.id);
      request.reply(response);
      expect(await result).toEqual(response);
      // A duplicate or late issued response must not cause a refresh loop.
      request.reply(response);
      await Bun.sleep(40);
      expect(owned.invalidations).toHaveLength(0);
      request.reply(createSessionListResponse([], generateId()));
      await Bun.sleep(40);
      expect(owned.invalidations).toHaveLength(1);
      expect(owned.forwarded).toHaveLength(0);
      if (retirement === 'revoked') owned.revoke();
      else if (retirement === 'generation-replaced')
        owned.registry.register({ ...owned.entry, startedAt: '2026-01-02T00:00:00Z' });
      else owned.proxy.close();
      request.reply(createSessionListResponse([], generateId()));
      await Bun.sleep(40);
      expect(owned.invalidations).toHaveLength(1);
      expect(owned.forwarded).toHaveLength(0);
    } finally {
      owned.cleanup();
    }
  }, 3000);
}

test('issued child list correlations retain at most 128 recent IDs (#1285)', async () => {
  const owned = await fixture();
  try {
    for (let index = 0; index < 130; index++) {
      const result = owned.proxy.list(owned.entry.sessionId, false);
      let request = await owned.requests.next();
      if (index === 0) {
        request.reply(owned.ack());
        request = await owned.requests.next();
      }
      const response = createSessionListResponse([], request.message.id);
      request.reply(response);
      expect(await result).toEqual(response);
    }
    const issued = (owned.proxy as unknown as { issuedLists: Set<string> }).issuedLists;
    expect(issued.size).toBe(128);
    expect(owned.invalidations).toHaveLength(0);
    owned.proxy.close();
    expect(issued.size).toBe(0);
  } finally {
    owned.cleanup();
  }
}, 5000);

for (const retirement of ['revoked', 'generation-replaced', 'proxy-closed'] as const) {
  test(`the verified child ping stays on its socket and ${retirement} refuses another Pong`, async () => {
    const owned = await fixture();
    try {
      const sent = owned.proxy.send(
        owned.entry.sessionId,
        createUserInput(owned.entry.sessionId, 'owned', false),
      );
      const hello = await owned.requests.next();
      const unverified = createPing();
      hello.reply(unverified);
      expect(await owned.requests.quiet(50)).toBe(true);
      hello.reply(owned.ack());
      await sent;
      await owned.requests.next();
      const ping = createPing();
      hello.reply(ping);
      const reply = await owned.requests.next(500);
      expect(reply.message.type).toBe('pong');
      expect(reply.message.type === 'pong' && reply.message.pingId).toBe(ping.id);
      expect(owned.forwarded.some((message) => message.type === 'ping')).toBe(false);
      if (retirement === 'revoked') owned.revoke();
      else if (retirement === 'generation-replaced')
        owned.registry.register({ ...owned.entry, startedAt: '2026-01-02T00:00:00Z' });
      else owned.proxy.close();
      hello.reply(createPing());
      expect(await owned.requests.quiet(80)).toBe(true);
    } finally {
      owned.cleanup();
    }
  }, 3000);
}

test('revocation while actual child hello waits prevents proxied user input after ready', async () => {
  const owned = await fixture();
  try {
    const sent = owned.proxy.send(
      owned.entry.sessionId,
      createUserInput(owned.entry.sessionId, 'OWNED_PRIVATE_CHILD_INPUT', false),
    );
    void sent.catch(() => {});
    const hello = await owned.requests.next();
    expect(hello.message.type).toBe('hello');
    owned.revoke();
    hello.reply(owned.ack());
    await expect(sent).rejects.toThrow('CHILD_UNAVAILABLE');
    expect(await owned.requests.quiet(80)).toBe(true);
    expect(owned.forwarded).toHaveLength(0);
  } finally {
    owned.cleanup();
  }
}, 3000);

test('old child frames and delayed close cannot settle or refuse new-generation answers', async () => {
  const owned = await fixture();
  try {
    const initial = owned.proxy.send(
      owned.entry.sessionId,
      createUserInput(owned.entry.sessionId, 'owned', false),
    );
    const first = await owned.requests.next();
    first.reply(owned.ack());
    await initial;
    await owned.requests.next();
    const children = (owned.proxy as unknown as { children: Map<string, { ws: WebSocket }> })
      .children;
    const old = children.get(owned.entry.sessionId)?.ws;
    if (!old || !old.onclose) throw new Error('MISSING_ACTUAL_CHILD_SOCKET');
    const close = old.onclose;
    let delayedClose: (() => void) | undefined;
    old.onclose = (event) => {
      delayedClose = () => close.call(old, event);
    };
    owned.registry.register({ ...owned.entry, startedAt: '2026-01-01T00:00:01Z' });
    first.reply(createSessionUpdate(owned.entry.sessionId, 'idle', 'OLD_GENERATION_SENTINEL'));
    await Bun.sleep(40);
    expect(owned.forwarded).toHaveLength(0);
    const answer = createAnswer(owned.entry.sessionId, 'owned-question', '1');
    const result = owned.proxy.answer(answer);
    const second = await owned.requests.next();
    second.reply(owned.ack());
    const actual = await owned.requests.next();
    expect(actual.message.type).toBe('answer');
    const until = Date.now() + 500;
    while (!delayedClose && Date.now() < until) await Bun.sleep(5);
    if (!delayedClose) throw new Error('MISSING_ACTUAL_OLD_CLOSE');
    delayedClose();
    actual.reply(createAnswerResult(answer.id, answer.sessionId, answer.questionId, 'delivered'));
    expect(await result).toBe('delivered');
    expect(owned.failures).toHaveLength(0);
  } finally {
    owned.cleanup();
  }
}, 3000);

test('child hello refresh is same-session/current, forwarded once after explicit hello and cached fresh', async () => {
  const f = await fixture(randomUUID());
  try {
    const pending = f.proxy.send(
      f.entry.sessionId,
      createHello('owned', 'T4', { resumeSessionId: f.entry.sessionId }),
    );
    const child = await f.requests.next();
    child.reply(f.ack());
    await pending;
    expect(f.forwarded.filter((m) => m.type === 'hello_ack')).toHaveLength(1);
    const ready = createHelloAck('owned', f.entry.sessionId, {
      attachState: 'attached',
      capabilities: ['browser_links'],
    });
    child.reply(ready);
    await Bun.sleep(40);
    expect(f.forwarded.filter((m) => m.type === 'hello_ack')).toHaveLength(2);
    await f.proxy.send(
      f.entry.sessionId,
      createHello('owned', 'T4', { resumeSessionId: f.entry.sessionId }),
    );
    expect(f.forwarded.at(-1)).toEqual(ready);
    child.reply(
      createHelloAck('owned', randomUUID(), {
        attachState: 'attached',
        capabilities: ['browser_links'],
      }),
    );
    await Bun.sleep(40);
    expect(f.forwarded.filter((m) => m.type === 'hello_ack')).toHaveLength(3);
    expect(f.failures).toEqual([f.entry.sessionId]);
  } finally {
    f.cleanup();
  }
}, 3000);

test('browser request consumes child ownership before send and actual socket loss forbids replacement', async () => {
  const f = await fixture(randomUUID());
  try {
    const pending = f.proxy.send(
      f.entry.sessionId,
      createHello('owned', 'T4', { resumeSessionId: f.entry.sessionId }),
    );
    const child = await f.requests.next();
    child.reply(f.ack());
    await pending;
    await f.proxy.send(f.entry.sessionId, {
      type: 'browser_link_receiver_request',
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: f.entry.sessionId,
      binding: { harness: 'claude', harnessSessionId: randomUUID() },
      seq: 1,
      action: 'select',
    });
    const receiver = await f.requests.next();
    expect(receiver.message.type).toBe('browser_link_receiver_request');
    receiver.close();
    const end = performance.now() + 500;
    while (!f.failures.length && performance.now() < end) await Bun.sleep(5);
    expect(f.ownerLosses).toEqual([true]);
    await expect(f.proxy.send(f.entry.sessionId, createHello('owned', 'T4'))).rejects.toThrow(
      'SESSION_NOT_FOUND',
    );
    expect(await f.requests.quiet(80)).toBe(true);
  } finally {
    f.cleanup();
  }
}, 3000);

for (const operation of [
  'file_fetch_begin',
  'file_fetch_read',
  'file_fetch_complete',
  'file_fetch_cancel',
] as const)
  test(`original raw ${operation} consumes child state before possible send and socket loss`, async () => {
    const f = await fixture(randomUUID());
    try {
      const envelope = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId: f.entry.sessionId,
      };
      const request =
        operation === 'file_fetch_begin'
          ? {
              ...envelope,
              type: operation,
              binding: { harness: 'claude' as const, harnessSessionId: randomUUID() },
              relativePath: 'owned.bin',
            }
          : operation === 'file_fetch_cancel'
            ? { ...envelope, type: operation, beginId: randomUUID() }
            : operation === 'file_fetch_read'
              ? {
                  ...envelope,
                  type: operation,
                  transferId: Buffer.alloc(16).toString('base64url'),
                  seq: 0,
                  receivedBytes: 0,
                }
              : {
                  ...envelope,
                  type: operation,
                  transferId: Buffer.alloc(16).toString('base64url'),
                  receivedBytes: 1,
                  digest: Buffer.alloc(32).toString('base64url'),
                };
      const original = `  ${encodeFileDownloadFrame(request)}\n`;
      const pending = f.proxy.sendFileDownload(f.entry.sessionId, original);
      const child = await f.requests.next();
      child.reply(f.ack());
      await pending;
      const sent = await f.requests.next();
      expect(sent.raw).toBe(original);
      expect(sent.message.type).toBe(operation);
      sent.close();
      const end = performance.now() + 500;
      while (!f.ownerLosses.length && performance.now() < end) await Bun.sleep(5);
      expect(f.ownerLosses).toEqual([true]);
      await expect(f.proxy.sendFileDownload(f.entry.sessionId, original)).rejects.toThrow(
        'SESSION_NOT_FOUND',
      );
      expect(await f.requests.quiet(80)).toBe(true);
    } finally {
      f.cleanup();
    }
  }, 3000);

test('raw file send rechecks actual actor after held child hello before original units are sent', async () => {
  const f = await fixture(randomUUID());
  try {
    const original = encodeFileDownloadFrame({
      type: 'file_fetch_cancel',
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: f.entry.sessionId,
      beginId: randomUUID(),
    });
    const pending = f.proxy.sendFileDownload(f.entry.sessionId, original);
    void pending.catch(() => {});
    const child = await f.requests.next();
    f.revoke();
    child.reply(f.ack());
    await expect(pending).rejects.toThrow('CHILD_UNAVAILABLE');
    expect(await f.requests.quiet(80)).toBe(true);
  } finally {
    f.cleanup();
  }
}, 3000);
