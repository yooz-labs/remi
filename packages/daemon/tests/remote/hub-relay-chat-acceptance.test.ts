/**
 * A chat acceptance reaches only the relay peer that asked for it (#1818). Real Worker, HubRelay,
 * ChildProxy and an actual child WebSocket adapter. The peer's own hello lists `chat_acceptance`;
 * the ChildProxy carries that list to the child in the hello it makes for it, and the child's
 * tracker records and sends a result only for a connection that listed it. A peer whose hello does
 * not (an older client, or an older hub's proxy, which carries nothing) gets nothing.
 */
import { expect, test } from 'bun:test';
import {
  CHAT_ACCEPTANCE_CAPABILITY,
  createHello,
  createIdentity,
  createUserInputResult,
  generateId,
  unlockIdentity,
} from '@remi/shared';
import { ChatAcceptanceTracker } from '../../src/cli/handlers/chat-acceptance.ts';
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
    expect(tracker.record(f.sessionId, messageId, 'hello', askingId)).toBe(true);
    for (const id of silentIds) {
      expect(tracker.record(f.sessionId, generateId(), 'hello', id)).toBe(false);
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

    // A future message type from a newer child: one line in the log, the channel stays up.
    expect(
      send({ type: 'a_future_message', id: generateId(), timestamp: new Date().toISOString() }),
    ).toBe(true);
    const result = createUserInputResult(f.sessionId, generateId());
    expect(send(result)).toBe(true);
    expect(await peer.next()).toMatchObject({ type: 'user_input_result', id: result.id });
    expect(peer.socket.isClosed).toBe(false);
    expect(f.relay.connectionCount).toBe(1);

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
    await f.close();
  }
}, 30000);
