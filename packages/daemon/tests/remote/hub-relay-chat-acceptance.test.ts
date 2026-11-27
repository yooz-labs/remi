/**
 * A chat acceptance reaches only the relay peer that asked for it (#1818). Real Worker, HubRelay,
 * ChildProxy and an actual child WebSocket adapter. The peer's own hello lists `chat_acceptance`;
 * the ChildProxy carries that list to the child in the hello it makes for it, and the child's
 * tracker records and sends a result only for a connection that listed it. A peer whose hello does
 * not (an older client, or an older hub's proxy, which carries nothing) gets nothing.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHAT_ACCEPTANCE_CAPABILITY,
  createHello,
  createIdentity,
  createUserInputResult,
  generateId,
  unlockIdentity,
} from '@remi/shared';
import { ChatAcceptanceTracker } from '../../src/cli/handlers/chat-acceptance.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { ChildProxy, childHello } from '../../src/remote/child-proxy.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import { relayBrowserFixture } from '../helpers/browser-link-service-fixture.ts';

test('only the relay peer whose hello lists chat_acceptance gets a result, through the child proxy', async () => {
  const other = await unlockIdentity(await createIdentity());
  const f = await relayBrowserFixture([other]);
  try {
    const asking = await f.connect();
    const silent = await f.connect(other);
    await asking.send(
      createHello('owned', 'T4', {
        resumeSessionId: f.sessionId,
        clientCapabilities: [CHAT_ACCEPTANCE_CAPABILITY],
      }),
    );
    await silent.send(createHello('owned', 'T4', { resumeSessionId: f.sessionId }));
    expect((await asking.next()).type).toBe('hello_ack');
    expect((await silent.next()).type).toBe('hello_ack');

    // What the child learned from each proxy's hello, read from its real connections.
    const attached = [...(f.registry.getSession(f.sessionId)?.attachedConnections ?? [])];
    const listed = (id: string) =>
      f.adapter.getDirectConnection(id)?.connectionClientCapabilities ?? [];
    const askingId = attached.find((id) => listed(id).includes(CHAT_ACCEPTANCE_CAPABILITY));
    const silentIds = attached.filter((id) => listed(id).length === 0);
    if (!askingId) throw new Error('the child never learned what the peer asked for');
    expect(silentIds.length).toBeGreaterThanOrEqual(1);

    const tracker = new ChatAcceptanceTracker({
      send: (connectionId, message) => f.adapter.sendRaw(connectionId, message),
      canReceive: (id) => listed(id).includes(CHAT_ACCEPTANCE_CAPABILITY),
    });
    const messageId = generateId();
    expect(tracker.record(f.sessionId, messageId, 'hello', askingId, tracker.sentTime())).toBe(
      true,
    );
    for (const id of silentIds) {
      expect(tracker.record(f.sessionId, generateId(), 'hello', id, tracker.sentTime())).toBe(
        false,
      );
    }
    expect(tracker.promptSubmitted(f.sessionId, 'hello')).toBe(true);

    const result = await asking.next();
    expect(result).toMatchObject({
      type: 'user_input_result',
      sessionId: f.sessionId,
      messageId,
      outcome: 'accepted',
    });
    expect(await silent.socket.quiet(150)).toBe(true);
  } finally {
    await f.close();
  }
}, 30000);

test('a verified child frame of an unregistered type is dropped; a malformed registered frame still closes the child', async () => {
  const lines: string[] = [];
  configureLogger({ writeLog: (line) => lines.push(line) });
  const f = await relayBrowserFixture();
  try {
    const peer = await f.connect();
    await peer.send(createHello('owned', 'T4', { resumeSessionId: f.sessionId }));
    expect((await peer.next()).type).toBe('hello_ack');
    const child = [...(f.registry.getSession(f.sessionId)?.attachedConnections ?? [])][0];
    if (!child) throw new Error('no child connection');
    // Raw text on the child's own socket, so a frame the serializer would refuse can be sent.
    const transport = (
      f.adapter.getDirectConnection(child) as unknown as { ws: { send(d: string): unknown } }
    ).ws;
    const send = (frame: object) => {
      transport.send(JSON.stringify(frame));
      return true;
    };

    // A future message type from a newer child: the channel stays up and the log gets one line
    // per (child, type), however often it repeats.
    expect(
      send({ type: 'a_future_message', id: generateId(), timestamp: new Date().toISOString() }),
    ).toBe(true);
    const future = (type: string) => ({
      type,
      id: generateId(),
      timestamp: new Date().toISOString(),
    });
    for (let n = 0; n < 5; n++) send(future('a_future_message'));
    send(future('another_future_message'));
    const result = createUserInputResult(f.sessionId, generateId());
    expect(send(result)).toBe(true);
    expect(await peer.next()).toMatchObject({ type: 'user_input_result', id: result.id });
    expect(peer.socket.isClosed).toBe(false);
    expect(f.relay.connectionCount).toBe(1);
    const dropped = lines.filter((line) => line.includes('dropped child frames of unknown type'));
    expect(dropped).toHaveLength(2);
    expect(dropped.some((line) => line.includes('a_future_message'))).toBe(true);
    expect(dropped.some((line) => line.includes('another_future_message'))).toBe(true);

    // A registered family frame the strict codec refuses is not dropped: the child is closed.
    send({
      type: 'browser_link_candidate',
      id: generateId(),
      timestamp: new Date().toISOString(),
      sessionId: f.sessionId,
    });
    const closed = await peer.next();
    expect(closed).toMatchObject({ type: 'error', code: 'SESSION_NOT_FOUND' });
  } finally {
    __resetLoggerForTests();
    await f.close();
  }
}, 30000);

test('the hub bounds the client capabilities it forwards to a child (#1818)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remi-child-proxy-caps-'));
  try {
    const proxy = new ChildProxy(
      new SessionRegistryFile(join(dir, 'live')),
      'device',
      () => {},
      () => {},
      () => true,
    );
    const messy = [...Array.from({ length: 20 }, (_, n) => `cap_${n}`), 7, null, 'x'.repeat(65)];
    const hello = {
      ...createHello('owned', 'T4', { resumeSessionId: 'session-1' }),
      clientCapabilities: messy as never,
    };
    // No live child exists, so the send is refused; what the proxy kept for its children is the point.
    await proxy.send('session-1', hello).catch(() => undefined);
    // Exactly 16 strings, none long, none non-string: the first 16 names, in order.
    expect(proxy.forwardedClientCapabilities).toEqual(
      Array.from({ length: 16 }, (_, n) => `cap_${n}`),
    );
    const built = childHello('device', 'session-1', proxy.forwardedClientCapabilities);
    expect(built.clientCapabilities).toHaveLength(16);
    // A client that asked for nothing leaves the field out, as an older hub's hello does.
    expect('clientCapabilities' in childHello('device', 'session-1', [])).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
