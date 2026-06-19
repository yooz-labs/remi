/**
 * #591: the signaling Worker's phone -> daemon answer relay.
 *
 * Drives `worker.fetch` and `ConnectionRoom.fetch` directly with the real
 * routing + forwarding logic. The Durable Object runtime (storage + hibernatable
 * WebSockets) is supplied as a minimal harness — the host socket's `send` records
 * the forwarded envelope, the same boundary-capture approach as push-dismiss.test.
 */

import { describe, expect, test } from 'bun:test';
import { ConnectionRoom } from '../src/connection-room.ts';
import worker from '../src/index.ts';

/** A recording stand-in for a hibernatable Worker WebSocket of a given role. */
function makeWs(role: string): {
  sent: string[];
  deserializeAttachment: () => unknown;
  send: (s: string) => void;
} {
  const sent: string[] = [];
  return {
    sent,
    deserializeAttachment: () => ({ role }),
    send: (s: string) => sent.push(s),
  };
}

/** Minimal DurableObjectState harness (storage + getWebSockets) for the answer path. */
function makeState(sockets: unknown[]): unknown {
  return {
    storage: {
      get: async () => undefined,
      put: async () => {},
      deleteAll: async () => {},
      setAlarm: () => {},
    },
    getWebSockets: () => sockets,
    acceptWebSocket: () => {},
  };
}

const ENV = { CONNECTION_TIMEOUT_MS: '300000' };

function answerRequest(code: string, body: unknown): Request {
  return new Request(`https://signaling.example/answer/${code}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID = {
  sessionId: 'aaaaaaaa-0000-0000-0000-000000000000',
  questionId: 'bbbbbbbb-0000-0000-0000-000000000000',
  answer: 'yes',
  auth: { signature: 'sig', clientPublicKey: 'pub', clientFingerprint: 'fp' },
};

describe('ConnectionRoom.handleAnswerRelay (#591)', () => {
  test('forwards the answer to the host as a relay envelope', async () => {
    const host = makeWs('host');
    const room = new ConnectionRoom(makeState([host]), ENV);
    const res = await room.fetch(answerRequest('ABCD-1234', VALID));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: string }).result).toBe('delivered');
    expect(host.sent).toHaveLength(1);

    const envelope = JSON.parse(host.sent[0] ?? '') as { type: string; payload: string };
    expect(envelope.type).toBe('relay');
    const inner = JSON.parse(envelope.payload) as Record<string, unknown>;
    expect(inner).toMatchObject({
      type: 'answer',
      sessionId: VALID.sessionId,
      questionId: VALID.questionId,
      answer: VALID.answer,
    });
    // the Ed25519 auth block must be carried through for daemon verification
    expect(inner['auth']).toEqual(VALID.auth);
  });

  test('carries claudeSessionId through when present', async () => {
    const host = makeWs('host');
    const room = new ConnectionRoom(makeState([host]), ENV);
    await room.fetch(
      answerRequest('ABCD-1234', {
        ...VALID,
        claudeSessionId: 'cccccccc-0000-0000-0000-000000000000',
      }),
    );
    const inner = JSON.parse(
      (JSON.parse(host.sent[0] ?? '') as { payload: string }).payload,
    ) as Record<string, unknown>;
    expect(inner['claudeSessionId']).toBe('cccccccc-0000-0000-0000-000000000000');
  });

  test('returns no-peer (503) when no host is connected', async () => {
    const room = new ConnectionRoom(makeState([makeWs('client')]), ENV);
    const res = await room.fetch(answerRequest('ABCD-1234', VALID));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { result: string }).result).toBe('no-peer');
  });

  test('rejects missing required fields (400)', async () => {
    const host = makeWs('host');
    const room = new ConnectionRoom(makeState([host]), ENV);
    const res = await room.fetch(answerRequest('ABCD-1234', { sessionId: VALID.sessionId }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { result: string }).result).toBe('missing-fields');
    expect(host.sent).toHaveLength(0);
  });

  test('rejects invalid JSON (400)', async () => {
    const host = makeWs('host');
    const room = new ConnectionRoom(makeState([host]), ENV);
    const res = await room.fetch(answerRequest('ABCD-1234', 'not json'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { result: string }).result).toBe('invalid-json');
  });

  test('non-POST non-upgrade still rejected (426)', async () => {
    const room = new ConnectionRoom(makeState([makeWs('host')]), ENV);
    const res = await room.fetch(
      new Request('https://signaling.example/answer/ABCD-1234', { method: 'GET' }),
    );
    expect(res.status).toBe(426);
  });

  test('returns room-expired (410) when the restored code has expired', async () => {
    const host = makeWs('host');
    // restoreState() loads code + a PAST expiresAt (epoch 1 << now) from storage.
    const expiredState = {
      storage: {
        get: async () =>
          new Map<string, unknown>([
            ['code', 'WXYZ-2345'],
            ['expiresAt', 1],
          ]),
        put: async () => {},
        deleteAll: async () => {},
        setAlarm: () => {},
      },
      getWebSockets: () => [host],
      acceptWebSocket: () => {},
    };
    const room = new ConnectionRoom(expiredState, ENV);
    const res = await room.fetch(answerRequest('WXYZ-2345', VALID));
    expect(res.status).toBe(410);
    expect(((await res.json()) as { result: string }).result).toBe('room-expired');
    expect(host.sent).toHaveLength(0);
  });
});

describe('worker /answer/{code} route (#591)', () => {
  test('routes a valid POST through to the room, which forwards to the host', async () => {
    const host = makeWs('host');
    const room = new ConnectionRoom(makeState([host]), ENV);
    const env = {
      ...ENV,
      MAX_CONNECTIONS_PER_ROOM: '10',
      CONNECTIONS: {
        idFromName: (name: string) => name,
        get: () => room,
      },
    };
    const res = await worker.fetch(answerRequest('WXYZ-2345', VALID), env as never);
    expect(res.status).toBe(200);
    expect(host.sent).toHaveLength(1);
  });

  test('rejects a malformed code (400) before touching the room', async () => {
    let gotRoom = false;
    const env = {
      ...ENV,
      MAX_CONNECTIONS_PER_ROOM: '10',
      CONNECTIONS: {
        idFromName: (name: string) => name,
        get: () => {
          gotRoom = true;
          return new ConnectionRoom(makeState([]), ENV);
        },
      },
    };
    // matches the [A-Z0-9-]+ route but fails the XXXX-9999 code format
    const res = await worker.fetch(answerRequest('AB', VALID), env as never);
    expect(res.status).toBe(400);
    expect(gotRoom).toBe(false);
  });
});
