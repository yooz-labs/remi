import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ProtocolMessage,
  createAnswer,
  createAnswerResult,
  createHelloAck,
  createSessionUpdate,
  createUserInput,
  deserialize,
  serialize,
} from '@remi/shared';
import {
  CAPABILITY_HEADER,
  loadOrCreateCapabilityToken,
} from '../../packages/daemon/src/auth/capability-token.ts';
import { ChildProxy } from '../../packages/daemon/src/remote/child-proxy.ts';
import { SessionRegistryFile } from '../../packages/daemon/src/session/session-registry-file.ts';
import { Mailbox } from '../../packages/signaling/tests/e2e/endpoints.ts';

async function fixture() {
  const dir = mkdtempSync('/private/tmp/remi-r3-child-generation-');
  chmodSync(dir, 0o700);
  const previous = process.env['REMI_HOME'];
  process.env['REMI_HOME'] = dir;
  const token = loadOrCreateCapabilityToken(join(dir, 'capability.key'));
  const requests = new Mailbox<{
    message: ProtocolMessage;
    reply: (message: ProtocolMessage) => void;
  }>();
  const forwarded: ProtocolMessage[] = [];
  const failures: string[] = [];
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
          reply: (value) => {
            ws.send(serialize(value));
          },
        });
      },
    },
  });
  const registry = new SessionRegistryFile(join(dir, 'live'));
  const entry = {
    sessionId: 'owned-child',
    pid: process.pid,
    wsPort: server.port,
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
    (id) => failures.push(id),
    () => authority,
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
    ack,
    cleanup,
    revoke: () => {
      authority = false;
    },
  };
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
