import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { createRawPtyOutput, generateId, now } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { createPtyMessageFanout } from '../../../src/cli/handlers/pty-message-fanout.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';

function fakePTY(): PTYSession {
  return {
    id: generateId(),
    write: () => {},
    submitInput: async () => {},
    close: async () => {},
  } as unknown as PTYSession;
}

function fakeMessageAPI(): MessageAPI {
  return { bulletCount: 0 } as unknown as MessageAPI;
}

describe('createPtyMessageFanout (#795)', () => {
  let sessionRegistry: SessionRegistry;
  let sentDirect: Array<{ connectionId: UUID; message: ProtocolMessage }>;
  let broadcasted: ProtocolMessage[];

  beforeEach(() => {
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    sentDirect = [];
    broadcasted = [];
  });

  afterEach(async () => {
    await sessionRegistry.shutdown();
  });

  function makeFanout() {
    return createPtyMessageFanout({
      sessionRegistry,
      sendToConnection: (connectionId, message) => {
        sentDirect.push({ connectionId, message });
        return true;
      },
      broadcast: (message) => {
        broadcasted.push(message);
      },
    });
  }

  test('raw_pty_output reaches every attached connection, not just one', () => {
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
    const connA = generateId();
    const connB = generateId();
    const connC = generateId();
    sessionRegistry.attachConnection(sessionId, connA);
    sessionRegistry.attachConnection(sessionId, connB);
    sessionRegistry.attachConnection(sessionId, connC);

    const fanout = makeFanout();
    const rawMsg = createRawPtyOutput('aGVsbG8=', sessionId);
    fanout(sessionId, rawMsg);

    expect(sentDirect).toHaveLength(3);
    const recipients = sentDirect.map((s) => s.connectionId).sort();
    expect(recipients).toEqual([connA, connB, connC].sort());
    for (const s of sentDirect) {
      expect(s.message).toBe(rawMsg);
    }
    // raw_pty_output is high-volume and never broadcast to query-mode clients.
    expect(broadcasted).toHaveLength(0);
  });

  test('raw_pty_output is a no-op when nobody is attached', () => {
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
    // Nobody attaches.

    const fanout = makeFanout();
    fanout(sessionId, createRawPtyOutput('aGVsbG8=', sessionId));

    expect(sentDirect).toHaveLength(0);
    expect(broadcasted).toHaveLength(0);
  });

  test('every other message type still goes through the ordinary broadcast', () => {
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
    sessionRegistry.attachConnection(sessionId, generateId());

    const fanout = makeFanout();
    const msg: ProtocolMessage = { type: 'ping', id: generateId(), timestamp: now() };
    fanout(sessionId, msg);

    expect(broadcasted).toEqual([msg]);
    // Not sent directly to the attached connection -- broadcast already covers it.
    expect(sentDirect).toHaveLength(0);
  });
});
