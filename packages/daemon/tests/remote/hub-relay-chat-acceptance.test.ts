/**
 * A chat acceptance reaches only the relay peer whose child connection it was sent to (#1818).
 * Real Worker, HubRelay, ChildProxy and an actual child WebSocket adapter; the child sends the
 * message the way the input handler's tracker does, to one child connection. The hub proxy
 * forwards a child's per-connection messages (`error` with a `messageId`, this result) through
 * the same generic path, so the result must arrive on that peer's encrypted channel and on no
 * other.
 */
import { expect, test } from 'bun:test';
import { createHello, createIdentity, createUserInputResult, unlockIdentity } from '@remi/shared';
import { relayBrowserFixture } from '../helpers/browser-link-service-fixture.ts';

test('a result sent to one relay peer reaches that peer only, through the child proxy', async () => {
  const other = await unlockIdentity(await createIdentity());
  const f = await relayBrowserFixture([other]);
  try {
    const a = await f.connect();
    const b = await f.connect(other);
    for (const peer of [a, b]) {
      await peer.send(createHello('owned', 'T4', { resumeSessionId: f.sessionId }));
      expect((await peer.next()).type).toBe('hello_ack');
    }
    const attached = [...(f.registry.getSession(f.sessionId)?.attachedConnections ?? [])];
    // The hub holds one child connection per relay peer.
    expect(attached.length).toBeGreaterThanOrEqual(2);
    const target = attached[attached.length - 1];
    if (!target) throw new Error('no child connection');
    const messageId = crypto.randomUUID();
    expect(f.adapter.sendRaw(target, createUserInputResult(f.sessionId, messageId))).toBe(true);

    const delivered = await Promise.race([
      a.next().then((m) => ({ peer: 'a', m })),
      b.next().then((m) => ({ peer: 'b', m })),
    ]);
    expect(delivered.m).toMatchObject({
      type: 'user_input_result',
      sessionId: f.sessionId,
      messageId,
      outcome: 'accepted',
    });
    const quiet = delivered.peer === 'a' ? b : a;
    expect(await quiet.socket.quiet(150)).toBe(true);
  } finally {
    await f.close();
  }
}, 30000);
