import { expect, test } from 'bun:test';
import {
  createPing,
  createSessionUpdate,
  createTranscriptContent,
  createTranscriptLoadComplete,
  deserialize,
  generateId,
  now,
  relayV2,
  serialize,
} from '@remi/shared';
import { resumed } from './relay-r3-fixture.ts';
test('oversize actual transcript content visibly refuses completion and preserves encrypted read half', async () => {
  const running = await resumed();
  try {
    const content = 'OWNED_OVERSIZE_SENTINEL'.repeat(30000);
    const message = createTranscriptContent(
      'session',
      'entry',
      'assistant',
      content,
      {
        id: generateId(),
        sessionId: 'session',
        sender: 'agent',
        content,
        createdAt: now(),
        state: 'delivered',
        stateChangedAt: now(),
        isEditing: false,
        bullets: [],
      },
      false,
    );
    expect(running.relay.sendRaw(running.cid, message)).toBe(false);
    expect(
      running.relay.sendRaw(running.cid, createTranscriptLoadComplete('session', 1, generateId())),
    ).toBe(false);
    const refused = await running.channel.receive(await running.socket.binary());
    const error = refused ? deserialize(new TextDecoder().decode(refused)) : null;
    expect(error?.type === 'error' && error.code).toBe('PAYLOAD_TOO_LARGE');
    await running.channel.send(new TextEncoder().encode(serialize(createPing())));
    const pong = await running.channel.receive(await running.socket.binary());
    expect(pong && deserialize(new TextDecoder().decode(pong))?.type).toBe('pong');
    expect(running.logs.join('\n')).not.toContain('OWNED_OVERSIZE_SENTINEL');
  } finally {
    await running.cleanup();
  }
});
test('semantic send queue bound refuses synchronously without claiming delivery', async () => {
  const running = await resumed();
  try {
    for (let i = 0; i < relayV2.MAX_PENDING_SENDS; i++)
      expect(running.relay.sendRaw(running.cid, createSessionUpdate('session', 'idle'))).toBe(true);
    expect(running.relay.sendRaw(running.cid, createSessionUpdate('session', 'idle'))).toBe(false);
  } finally {
    await running.cleanup();
  }
});
